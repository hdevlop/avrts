import { OnRead, OnWrite } from "../core";
import {
  ACIC,
  ACO,
  ACSR,
  COM1A0,
  COM1A1,
  COM1B0,
  COM1B1,
  CS10,
  CS11,
  CS12,
  FOC1A,
  FOC1B,
  ICES1,
  ICF1,
  ICIE1,
  ICNC1,
  ICR1H,
  ICR1L,
  OCF1A,
  OCF1B,
  OCIE1A,
  OCIE1B,
  OCR1AH,
  OCR1AL,
  OCR1BH,
  OCR1BL,
  TCCR1A,
  TCCR1B,
  TCCR1C,
  TCNT1H,
  TCNT1L,
  TIFR1,
  TIMER1_CAPT_VECTOR,
  TIMER1_COMPA_VECTOR,
  TIMER1_COMPB_VECTOR,
  TIMER1_OVF_VECTOR,
  TIMSK1,
  TOIE1,
  TOV1,
  WGM10,
  WGM11,
  WGM12,
  WGM13,
} from "../cpu";
import type { CPU } from "../cpu";
import type { Gpio } from "./gpio";
import { PwmBroadcaster, pwmSignal } from "./pwm";
import type { PwmConfig } from "./pwm";
import type { Timer1Snapshot } from "../snapshot";
import type { PortName, PwmChannel, PwmSignal, PwmSource } from "./types";

// CS12:10 — same prescaler set as Timer0 (external-clock options not modeled).
const TIMER1_PRESCALER: Readonly<Record<number, number | undefined>> = {
  0b000: undefined,
  0b001: 1,
  0b010: 8,
  0b011: 64,
  0b100: 256,
  0b101: 1024,
  0b110: undefined, // external clock on T1, falling edge — not modeled
  0b111: undefined, // external clock on T1, rising edge — not modeled
};

const TIMER1_FLAG_MASK = (1 << TOV1) | (1 << OCF1A) | (1 << OCF1B) | (1 << ICF1);

// Datasheet: the input-capture noise canceler delays the capture by four
// system clock cycles (four equal samples required).
const NOISE_CANCELER_CYCLES = 4;

/**
 * Timer1 (16-bit). Models the prescaler, a 16-bit free-running counter, TOV1
 * overflow + the TOIE1 interrupt, and 8-bit PWM duty reporting for OC1A (Arduino
 * pin 9) and OC1B (pin 10) — the analogWrite mode the Arduino core uses. The
 * CPU byte accesses share the hardware TEMP latch. PWM compare values are
 * distinct from the CPU-visible buffers and transfer at the selected WGM edge.
 */
export class Timer1 implements PwmSource {
  private count = 0;
  private countingDown = false;
  private tempHigh = 0;
  private activeOcrA = 0;
  private activeOcrB = 0;
  private compareBlocked = false;
  private prescalerRemainder = 0;
  private lastCycle = 0;
  private powerReduced = false;
  // GTCCR TSM+PSRSYNC holds the shared prescaler in reset (counter frozen).
  private prescalerHeld = false;
  private sleepPaused = false;
  // Cached prescaler divisor, recomputed only when the CS bits (TCCR1B) change.
  // tick() runs every instruction, so it must not re-read/re-map the register.
  private cachedPrescaler: number | undefined = undefined;
  private readonly pwm = new PwmBroadcaster();
  private readonly onClockEvent = (): void => {
    this.syncToCpuCycle();
    this.scheduleClockEvent();
  };
  // Noise-canceler-delayed input capture (armed by an ICP1/comparator edge).
  private captureInputHigh = false;
  private filteredCaptureHigh = false;
  private frozenCaptureRemainingCycles = 0;
  private readonly onCaptureDelayEvent = (): void => {
    if (this.captureInputHigh === this.filteredCaptureHigh) return;
    this.filteredCaptureHigh = this.captureInputHigh;
    if (this.captureInputHigh === ((this.cpu.data[TCCR1B]! & (1 << ICES1)) !== 0)) {
      this.performCapture();
    }
  };

  constructor(
    private readonly cpu: CPU,
    private readonly gpio?: Gpio,
  ) {
    this.captureInputHigh = this.gpio?.readPin("B", 0) ?? false;
    this.filteredCaptureHigh = this.captureInputHigh;
    // ICP1 is PB0 (Arduino pin 8). The pin edge triggers capture unless the
    // comparator owns the trigger (ACSR.ACIC set).
    this.gpio?.onPinChange("B", 0, (high) => {
      if ((this.cpu.data[ACSR]! & (1 << ACIC)) !== 0) return;
      this.onCaptureEdge(high);
    }, true);
  }

  private get pwmConfig(): PwmConfig {
    return {
      tccrA: TCCR1A,
      tccrB: TCCR1B,
      wgm2Bit: WGM12,
      max: 255,
      topValue: () => this.pwmTop(),
      mode: () => this.pwmMode(),
      ocrValue: (channel) => this.ocrValue(channel),
    };
  }

  reset(): void {
    this.powerReduced = false;
    this.prescalerHeld = false;
    this.sleepPaused = false;
    this.count = 0;
    this.countingDown = false;
    this.tempHigh = 0;
    this.activeOcrA = 0;
    this.activeOcrB = 0;
    this.compareBlocked = false;
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.cpu.clearClockEvent(this.onCaptureDelayEvent);
    this.frozenCaptureRemainingCycles = 0;
    this.captureInputHigh = this.gpio?.readPin("B", 0) ?? false;
    this.filteredCaptureHigh = this.captureInputHigh;
    this.refreshPrescaler();
    this.scheduleClockEvent();
    this.driveOutput("A", undefined);
    this.driveOutput("B", undefined);
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  tick(cycles: number): void {
    if (this.frozen()) return;
    const prescaler = this.cachedPrescaler;
    if (prescaler === undefined) return;

    if (cycles > 1 && prescaler === 1) {
      const total = this.prescalerRemainder + cycles;
      this.prescalerRemainder = 0;
      this.advanceCounter(total);
      this.lastCycle = this.cpu.cycles;
      this.scheduleClockEvent();
      return;
    }

    this.prescalerRemainder += cycles;
    while (this.prescalerRemainder >= prescaler) {
      this.prescalerRemainder -= prescaler;
      this.increment();
    }
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  // 16-bit counter readback: low byte then high byte (AVR access order).
  @OnRead(TCNT1L) readTcnt1l(): number {
    this.syncToCpuCycle();
    this.tempHigh = (this.count >> 8) & 0xff;
    return this.count & 0xff;
  }
  @OnRead(ICR1H)
  @OnRead(TCNT1H) readTcnt1h(): number {
    return this.tempHigh;
  }

  @OnRead(ICR1L) readIcr1l(): number {
    this.syncToCpuCycle();
    this.tempHigh = this.cpu.data[ICR1H]!;
    return this.cpu.data[ICR1L]!;
  }

  // All four high-byte writes stage TEMP without altering the target register.
  @OnWrite(TCNT1H)
  @OnWrite(ICR1H)
  @OnWrite(OCR1AH)
  @OnWrite(OCR1BH)
  onWriteHigh(_cpu: CPU, addr: number, value: number, oldValue: number): void {
    this.cpu.data[addr] = oldValue;
    this.tempHigh = value;
  }
  @OnWrite(TCNT1L) onWriteTcnt1l(_cpu: CPU, _addr: number, value: number): void {
    const high = this.tempHigh;
    this.syncToCpuCycle();
    this.count = (high << 8) | value;
    this.cpu.data[TCNT1H] = high;
    this.compareBlocked = true;
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  @OnWrite(TIFR1)
  onWriteTifr1(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.cpu.data[TIFR1] = oldValue;
    this.syncToCpuCycle();
    this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! & ~(value & TIMER1_FLAG_MASK);
    this.onWriteTimsk1();
  }

  @OnWrite(TCCR1B)
  onWriteTccr1b(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    const oldMode = this.syncWithOldRegister(addr, oldValue);
    this.updateWaveformMode(oldMode);
    if (((oldValue ^ this.cpu.data[TCCR1B]!) & 7) !== 0) this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(TCCR1A)
  onWriteTccr1a(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    const oldMode = this.syncWithOldRegister(addr, oldValue);
    this.updateWaveformMode(oldMode);
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(TIMSK1)
  onWriteTimsk1(): void {
    this.syncToCpuCycle();
    this.requestCompareIfEnabled("A");
    this.requestCompareIfEnabled("B");
    this.requestOverflowIfEnabled();
    this.requestCaptureIfEnabled();
    this.scheduleClockEvent();
  }

  @OnWrite(TCCR1C)
  onWriteTccr1c(_cpu: CPU, _addr: number, value: number): void {
    // FOC1A/FOC1B are write-only strobes: in non-PWM modes they act on the
    // output pin like a compare match, but never set OCF1x or reload TCNT1.
    this.cpu.data[TCCR1C] = 0;
    if (this.isPwmMode()) return;
    this.syncToCpuCycle();
    if ((value & (1 << FOC1A)) !== 0) this.handleCompareOutput("A");
    if ((value & (1 << FOC1B)) !== 0) this.handleCompareOutput("B");
  }

  @OnWrite(OCR1AL)
  @OnWrite(OCR1BL)
  onWriteOcr1l(_cpu: CPU, addr: number, value: number, oldValue: number): void {
    let word = (this.tempHigh << 8) | value;
    this.cpu.data[addr] = oldValue;
    this.syncToCpuCycle();
    const mode = this.waveformMode();
    // Fixed-resolution PWM ignores the unused OCR bits on a CPU write.
    if (mode === 1 || mode === 5) word &= 0xff;
    else if (mode === 2 || mode === 6) word &= 0x1ff;
    else if (mode === 3 || mode === 7) word &= 0x3ff;
    this.cpu.data[addr] = word & 0xff;
    this.cpu.data[addr + 1] = word >> 8;
    if (!this.isPwmMode()) {
      this.updateCompareBuffers();
      this.scheduleClockEvent();
    }
  }

  @OnWrite(ICR1L) onWriteIcr1l(_cpu: CPU, addr: number, value: number, oldValue: number): void {
    const high = this.tempHigh;
    this.cpu.data[addr] = oldValue;
    this.syncToCpuCycle();
    const mode = this.waveformMode();
    if (mode !== 8 && mode !== 10 && mode !== 12 && mode !== 14) return;
    this.cpu.data[ICR1H] = high;
    this.cpu.data[ICR1L] = value;
    this.scheduleClockEvent();
    this.emitPwm("A");
    this.emitPwm("B");
  }

  readPwm(channel: PwmChannel): PwmSignal {
    this.syncToCpuCycle();
    return pwmSignal(this.cpu, this.pwmConfig, channel);
  }

  onPwmChange(channel: PwmChannel, listener: (signal: PwmSignal) => void): () => void {
    return this.pwm.on(channel, listener);
  }

  setPowerReduced(reduced: boolean): void {
    if (this.powerReduced === reduced) return;
    const captureWasPaused = this.powerReduced || this.sleepPaused;
    if (reduced) {
      this.syncToCpuCycle();
      this.powerReduced = true;
      this.updateCaptureClock(captureWasPaused);
      this.cpu.clearClockEvent(this.onClockEvent);
      return;
    }
    this.powerReduced = false;
    this.updateCaptureClock(captureWasPaused);
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  /** GTCCR TSM+PSRSYNC: hold the prescaler in reset (counter frozen). */
  setPrescalerHeld(held: boolean): void {
    if (this.prescalerHeld === held) return;
    if (held) {
      this.syncToCpuCycle();
      this.prescalerHeld = true;
      this.cpu.clearClockEvent(this.onClockEvent);
      return;
    }
    this.prescalerHeld = false;
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  /** GTCCR PSRSYNC: reset the shared prescaler (counter value untouched). */
  resetPrescaler(): void {
    this.syncToCpuCycle();
    this.prescalerRemainder = 0;
    this.scheduleClockEvent();
  }

  setSleepPaused(paused: boolean): void {
    if (this.sleepPaused === paused) return;
    const captureWasPaused = this.powerReduced || this.sleepPaused;
    if (paused) {
      this.syncToCpuCycle();
      this.sleepPaused = true;
      this.updateCaptureClock(captureWasPaused);
      this.cpu.clearClockEvent(this.onClockEvent);
      return;
    }
    this.sleepPaused = false;
    this.updateCaptureClock(captureWasPaused);
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  /**
   * Comparator-owned capture trigger (ACSR.ACIC set): the comparator output
   * replaces ICP1; ICES1 still selects the capture edge.
   */
  comparatorCaptureEdge(high: boolean): void {
    this.onCaptureEdge(high);
  }

  private frozen(): boolean {
    return this.powerReduced || this.prescalerHeld || this.sleepPaused;
  }

  private onCaptureEdge(high: boolean): void {
    this.captureInputHigh = high;
    this.cpu.clearClockEvent(this.onCaptureDelayEvent);
    if (this.powerReduced || this.sleepPaused) {
      this.frozenCaptureRemainingCycles = high === this.filteredCaptureHigh ? 0
        : (this.cpu.data[TCCR1B]! & (1 << ICNC1)) !== 0 ? NOISE_CANCELER_CYCLES : 1;
      return;
    }
    if (!this.captureEnabled()) return;
    if ((this.cpu.data[TCCR1B]! & (1 << ICNC1)) !== 0) {
      // Noise canceler: the capture lands four system cycles after the edge.
      // Every opposite edge cancels the candidate: four equal samples are required.
      this.cpu.addClockEvent(this.onCaptureDelayEvent, NOISE_CANCELER_CYCLES);
      return;
    }
    this.filteredCaptureHigh = high;
    if (high === ((this.cpu.data[TCCR1B]! & (1 << ICES1)) !== 0)) this.performCapture();
  }

  private performCapture(): void {
    if (!this.captureEnabled()) return;
    this.syncToCpuCycle();
    this.cpu.data[ICR1L] = this.count & 0xff;
    this.cpu.data[ICR1H] = (this.count >> 8) & 0xff;
    this.cpu.setInterruptFlag(TIFR1, 1 << ICF1);
    this.requestCaptureIfEnabled();
  }

  private captureEnabled(): boolean {
    const mode = this.waveformMode();
    return !this.powerReduced && !this.sleepPaused && mode !== 8 && mode !== 10 && mode !== 12 && mode !== 14;
  }

  private updateCaptureClock(wasPaused: boolean): void {
    const paused = this.powerReduced || this.sleepPaused;
    if (paused === wasPaused) return;
    if (paused) {
      this.frozenCaptureRemainingCycles = this.cpu.clockEventRemainingCycles(this.onCaptureDelayEvent);
      this.cpu.clearClockEvent(this.onCaptureDelayEvent);
    } else {
      if (this.frozenCaptureRemainingCycles > 0) {
        this.cpu.addClockEvent(this.onCaptureDelayEvent, this.frozenCaptureRemainingCycles);
      }
      this.frozenCaptureRemainingCycles = 0;
    }
  }

  private requestCaptureIfEnabled(): void {
    const flag = (this.cpu.data[TIFR1]! & (1 << ICF1)) !== 0;
    const enabled = (this.cpu.data[TIMSK1]! & (1 << ICIE1)) !== 0;
    if (!flag || !enabled) {
      this.cpu.clearInterrupt(TIMER1_CAPT_VECTOR);
      return;
    }
    this.cpu.requestInterrupt(TIMER1_CAPT_VECTOR, () => {
      this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! & ~(1 << ICF1);
    });
  }

  private increment(): void {
    const mode = this.waveformMode();
    const blocked = this.compareBlocked;
    this.compareBlocked = false;
    this.assertCompareFlags(this.count, blocked);
    if (this.isDualSlopePwmMode(mode)) {
      this.incrementDualSlope(this.modeTop(mode), mode);
      return;
    }

    const top = this.singleSlopeTop(mode);
    // Fast PWM holds TOP for one clock, giving a TOP+1 period. Its buffered
    // compare values transfer when the following clock reaches BOTTOM.
    if (top !== undefined && this.count === top && (!blocked || mode === 5 || mode === 6 || mode === 7)) {
      this.count = 0;
      if (this.isFastPwmMode(mode)) {
        this.updateCompareBuffers();
        this.handleBottom();
        if (top === 0) {
          this.setOverflowFlag();
          this.setTopFlag(mode);
        }
      }
      if (mode === 12 && top === 0) this.setTopFlag(mode);
      if (!this.isFastPwmMode(mode) && top === 0xffff) this.setOverflowFlag();
      this.handleCompare(0, "up");
      return;
    }

    const wasBottom = this.count === 0;
    this.count = (this.count + 1) & 0xffff;
    if (this.count === 0) {
      if (this.isFastPwmMode(mode)) this.updateCompareBuffers();
      this.handleBottom();
    }
    if (wasBottom && !blocked && this.isFastPwmMode(mode)) {
      if (this.activeOcrA === 0) this.handleCompareOutput("A");
      if (this.activeOcrB === 0) this.handleCompareOutput("B");
    }
    this.handleCompare(this.count, "up");

    if (top !== undefined && this.count === top) {
      this.setTopFlag(mode);
      // Fast PWM sets TOV1 at TOP; CTC (modes 4/12) clears without overflow.
      if (this.isFastPwmMode(mode)) {
        this.setOverflowFlag();
      }
      return;
    }

    if (this.count !== 0 || this.isFastPwmMode(mode)) return;
    this.setOverflowFlag();
  }

  private incrementDualSlope(top: number, mode: number): void {
    if (top === 0) {
      this.count = 0;
      this.updateCompareBuffers();
      this.handleBottom();
      this.setOverflowFlag();
      return;
    }

    if (this.countingDown) {
      this.count = (this.count - 1) & 0xffff;
      this.handleCompare(this.count, "down");
      if (this.count === 0) {
        this.countingDown = false;
        if (mode === 8 || mode === 9) this.updateCompareBuffers();
        this.handleBottom();
        this.setOverflowFlag();
      }
      return;
    }

    this.count = (this.count + 1) & 0xffff;
    this.handleCompare(this.count, "up");
    if (this.count === top) {
      this.countingDown = true;
      this.setTopFlag(mode);
      if (mode !== 8 && mode !== 9) {
        this.updateCompareBuffers();
        this.syncPwmAtTop("A");
        this.syncPwmAtTop("B");
      }
    }
  }

  private setTopFlag(mode: number): void {
    // OCR1A-as-TOP PWM has a dedicated TOP flag, unlike an ordinary compare.
    if (mode === 9 || mode === 11 || mode === 15) {
      this.cpu.setInterruptFlag(TIFR1, 1 << OCF1A);
      this.requestCompareIfEnabled("A");
      return;
    }
    if (mode !== 8 && mode !== 10 && mode !== 12 && mode !== 14) return;
    this.cpu.setInterruptFlag(TIFR1, 1 << ICF1);
    this.requestCaptureIfEnabled();
  }

  private setOverflowFlag(): void {
    this.cpu.setInterruptFlag(TIFR1, 1 << TOV1);
    this.requestOverflowIfEnabled();
  }

  private advanceCounter(steps: number): void {
    let remaining = steps;
    while (remaining > 0) {
      const untilEvent = this.stepsUntilNextEvent();
      if (untilEvent > remaining) {
        this.count = (this.count + remaining) & 0xffff;
        return;
      }
      if (untilEvent > 1) {
        this.count = (this.count + untilEvent - 1) & 0xffff;
        remaining -= untilEvent - 1;
      }
      this.increment();
      remaining -= 1;
    }
  }

  private syncToCpuCycle(): void {
    const now = this.cpu.cycles;
    const elapsed = now - this.lastCycle;
    if (elapsed <= 0) return;
    this.lastCycle = now;
    if (this.frozen()) return;
    const prescaler = this.cachedPrescaler;
    if (prescaler === undefined) return;
    const total = this.prescalerRemainder + elapsed;
    const steps = Math.floor(total / prescaler);
    this.prescalerRemainder = total - steps * prescaler;
    if (steps > 0) this.advanceCounter(steps);
  }

  private syncWithOldRegister(addr: number, oldValue: number): number {
    const current = this.cpu.data[addr]!;
    this.cpu.data[addr] = oldValue & 0xff;
    const mode = this.waveformMode();
    this.syncToCpuCycle();
    this.cpu.data[addr] = current;
    return mode;
  }

  private scheduleClockEvent(): void {
    const prescaler = this.cachedPrescaler;
    if (this.frozen() || prescaler === undefined) {
      this.cpu.clearClockEvent(this.onClockEvent);
      return;
    }
    const steps = this.stepsUntilNextEvent();
    const cycles =
      prescaler - this.prescalerRemainder + (steps > 1 ? (steps - 1) * prescaler : 0);
    this.cpu.addClockEvent(this.onClockEvent, cycles);
  }

  private stepsUntilNextEvent(): number {
    const mode = this.waveformMode();
    // Disconnected CTC outputs need no event merely for reaching equality:
    // the A flag and counter clear occur together on the following clock.
    // A latched/masked B flag can also wait until a flag/mask write re-arms it.
    if (mode === 4 && !this.compareBlocked &&
        (this.cpu.data[TCCR1A]! & 0xf0) === 0) {
      const top = this.modeTop(mode);
      const needsB = (this.cpu.data[TIFR1]! & (1 << OCF1B)) === 0 ||
        (this.cpu.data[TIMSK1]! & (1 << OCIE1B)) !== 0;
      return Math.min(
        this.count === top ? 1 : stepsUntil16BitValue(this.count, top) + 1,
        needsB ? stepsUntil16BitValue(this.count, (this.activeOcrB + 1) & 0xffff) : Infinity,
        stepsUntil16BitValue(this.count, 0),
      );
    }
    if (this.compareBlocked || this.isDualSlopePwmMode(mode)) return 1;
    if (this.count === this.activeOcrA || this.count === this.activeOcrB) return 1;
    if (this.count === this.singleSlopeTop(mode) || (this.isFastPwmMode(mode) && this.count === 0)) return 1;

    return Math.min(
      stepsUntil16BitValue(this.count, this.ocrValue("A")),
      stepsUntil16BitValue(this.count, this.ocrValue("B")),
      stepsUntil16BitValue(this.count, this.singleSlopeTop(this.waveformMode()) ?? 0),
      stepsUntil16BitValue(this.count, 0),
    );
  }

  private assertCompareFlags(counter: number, blocked: boolean): void {
    if (blocked) return;
    const mode = this.waveformMode();
    if (counter === this.ocrValue("A") && mode !== 9 && mode !== 11 && mode !== 15) {
      this.cpu.setInterruptFlag(TIFR1, 1 << OCF1A);
      this.requestCompareIfEnabled("A");
    }
    if (counter === this.ocrValue("B")) {
      this.cpu.setInterruptFlag(TIFR1, 1 << OCF1B);
      this.requestCompareIfEnabled("B");
    }
  }

  private handleCompare(counter: number, direction: "up" | "down"): void {
    if (counter === this.activeOcrA) this.handleCompareOutput("A", direction);
    if (counter === this.activeOcrB) this.handleCompareOutput("B", direction);
  }

  private requestCompareIfEnabled(channel: PwmChannel): void {
    const flagBit = channel === "A" ? OCF1A : OCF1B;
    const enableBit = channel === "A" ? OCIE1A : OCIE1B;
    const vector = channel === "A" ? TIMER1_COMPA_VECTOR : TIMER1_COMPB_VECTOR;
    const flag = (this.cpu.data[TIFR1]! & (1 << flagBit)) !== 0;
    const enabled = (this.cpu.data[TIMSK1]! & (1 << enableBit)) !== 0;
    if (!flag || !enabled) {
      this.cpu.clearInterrupt(vector);
      return;
    }
    this.cpu.requestInterrupt(vector, () => {
      this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! & ~(1 << flagBit);
    });
  }

  private requestOverflowIfEnabled(): void {
    const overflowFlag = (this.cpu.data[TIFR1]! & (1 << TOV1)) !== 0;
    const overflowEnabled = (this.cpu.data[TIMSK1]! & (1 << TOIE1)) !== 0;
    if (!overflowFlag || !overflowEnabled) {
      this.cpu.clearInterrupt(TIMER1_OVF_VECTOR);
      return;
    }
    this.cpu.requestInterrupt(TIMER1_OVF_VECTOR, () => {
      this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! & ~(1 << TOV1);
    });
  }

  private prescaler(): number | undefined {
    const bits = this.cpu.data[TCCR1B]! & ((1 << CS12) | (1 << CS11) | (1 << CS10));
    return TIMER1_PRESCALER[bits];
  }

  /** Recompute the cached prescaler from TCCR1B; call on every CS-bit change. */
  private refreshPrescaler(): void {
    this.cachedPrescaler = this.prescaler();
  }

  private notifyPwm(channel: PwmChannel): void {
    this.syncOutput(channel);
    this.emitPwm(channel);
  }

  private emitPwm(channel: PwmChannel): void {
    this.pwm.emit(channel, this.readPwm(channel));
  }

  private updateWaveformMode(oldMode: number): void {
    if (oldMode === this.waveformMode()) return;
    if (!this.isDualSlopePwmMode(this.waveformMode())) this.countingDown = false;
    if (!this.isPwmMode()) {
      this.updateCompareBuffers();
    }
  }

  private updateCompareBuffers(): void {
    const nextA = this.bufferedOcrValue("A");
    const nextB = this.bufferedOcrValue("B");
    if (nextA === this.activeOcrA && nextB === this.activeOcrB) return;
    this.activeOcrA = nextA;
    this.activeOcrB = nextB;
    this.emitPwm("A");
    this.emitPwm("B");
    if (this.isDualSlopePwmMode(this.waveformMode())) {
      this.syncPwmExtremes("A");
      this.syncPwmExtremes("B");
    }
  }

  private pwmTop(): number {
    return this.modeTop(this.waveformMode());
  }

  private pwmMode(): PwmSignal["mode"] {
    const mode = this.waveformMode();
    if (this.isFastPwmMode(mode)) return "fast-pwm";
    if (this.isDualSlopePwmMode(mode)) return "phase-correct-pwm";
    return mode === 0 ? "off" : "other";
  }

  /**
   * TOP for each WGM mode (see the ATmega328P Timer/Counter1 mode table):
   * fixed 8/9/10-bit resolutions, OCR1A, ICR1, or the 16-bit MAX for normal
   * (0) and the reserved mode 13.
   */
  private modeTop(mode: number): number {
    switch (mode) {
      case 1:
      case 5:
        return 0x00ff;
      case 2:
      case 6:
        return 0x01ff;
      case 3:
      case 7:
        return 0x03ff;
      case 4:
      case 9:
      case 11:
      case 15:
        return this.ocrValue("A");
      case 8:
      case 10:
      case 12:
      case 14:
        return this.icrValue();
      default:
        return 0xffff;
    }
  }

  private ocrValue(channel: PwmChannel): number {
    return channel === "A" ? this.activeOcrA : this.activeOcrB;
  }

  private bufferedOcrValue(channel: PwmChannel): number {
    return channel === "A"
      ? (this.cpu.data[OCR1AH]! << 8) | this.cpu.data[OCR1AL]!
      : (this.cpu.data[OCR1BH]! << 8) | this.cpu.data[OCR1BL]!;
  }

  private icrValue(): number {
    return (this.cpu.data[ICR1H]! << 8) | this.cpu.data[ICR1L]!;
  }

  private waveformMode(): number {
    const low = this.cpu.data[TCCR1A]! & ((1 << WGM11) | (1 << WGM10));
    const high =
      (((this.cpu.data[TCCR1B]! >> WGM12) & 1) << 2) |
      (((this.cpu.data[TCCR1B]! >> WGM13) & 1) << 3);
    return high | low;
  }

  // Single-slope modes that clear/wrap at TOP: fast PWM (5/6/7/14/15) and the
  // two CTC modes (4/12). Normal (0) and reserved (13) wrap at MAX instead.
  private singleSlopeTop(mode: number): number | undefined {
    if (this.isFastPwmMode(mode) || mode === 4 || mode === 12) return this.modeTop(mode);
    return undefined;
  }

  private isFastPwmMode(mode: number): boolean {
    return mode === 5 || mode === 6 || mode === 7 || mode === 14 || mode === 15;
  }

  // Dual-slope PWM (phase-correct and phase/frequency-correct): 1/2/3/8/9/10/11.
  private isDualSlopePwmMode(mode: number): boolean {
    return (
      mode === 1 ||
      mode === 2 ||
      mode === 3 ||
      mode === 8 ||
      mode === 9 ||
      mode === 10 ||
      mode === 11
    );
  }

  private handleBottom(): void {
    if (!this.isPwmMode()) return;
    this.syncPwmOutput("A", "bottom");
    this.syncPwmOutput("B", "bottom");
  }

  private handleCompareOutput(channel: PwmChannel, direction: "up" | "down" = "up"): void {
    if (this.isPwmMode()) {
      this.syncPwmOutput(channel, "compare", direction);
      return;
    }

    const mode = this.compareMode(channel);
    if (mode === 0) {
      this.driveOutput(channel, undefined);
    } else if (mode === 1) {
      const pin = this.outputPin(channel);
      this.driveOutput(channel, !this.gpio?.readPin(pin.port, pin.bit));
    } else {
      this.driveOutput(channel, mode === 3);
    }
  }

  private syncOutput(channel: PwmChannel): void {
    if (this.isPwmMode()) {
      // A control write must not manufacture a BOTTOM in the middle of a pulse.
      const compare = this.compareMode(channel);
      if (compare === 0 || (compare === 1 && !this.pwmToggleEnabled(channel))) this.driveOutput(channel, undefined);
      else if (this.count === 0) this.syncPwmOutput(channel, "bottom");
    } else if (this.compareMode(channel) === 0) {
      this.driveOutput(channel, undefined);
    }
  }

  private syncPwmOutput(channel: PwmChannel, edge: "bottom" | "compare", direction: "up" | "down" = "up"): void {
    const mode = this.compareMode(channel);
    const waveform = this.waveformMode();
    if (mode === 1 && this.pwmToggleEnabled(channel)) {
      if (edge === "compare") {
        const pin = this.outputPin(channel);
        this.driveOutput(channel, !this.gpio?.readPin(pin.port, pin.bit));
      }
      return;
    }
    if (!this.isPwmMode() || mode < 2) {
      this.driveOutput(channel, undefined);
      return;
    }
    if (this.syncPwmExtremes(channel)) return;
    if (edge === "compare" && this.isFastPwmMode(waveform) && this.ocrValue(channel) === 0 && this.count === 0) return;
    const inverted = mode === 3;
    if (edge === "bottom" || direction === "down") {
      this.driveOutput(channel, !inverted);
    } else {
      this.driveOutput(channel, inverted);
    }
  }

  private pwmToggleEnabled(channel: PwmChannel): boolean {
    const mode = this.waveformMode();
    return channel === "A" && (mode === 9 || mode === 11 || mode === 14 || mode === 15);
  }

  private syncPwmExtremes(channel: PwmChannel): boolean {
    const mode = this.compareMode(channel);
    if (mode < 2) return false;
    const value = this.ocrValue(channel);
    const waveform = this.waveformMode();
    if (value === this.modeTop(waveform)) {
      this.driveOutput(channel, mode !== 3);
      return true;
    }
    if (value === 0 && this.isDualSlopePwmMode(waveform)) {
      this.driveOutput(channel, mode === 3);
      return true;
    }
    return false;
  }

  private syncPwmAtTop(channel: PwmChannel): void {
    if (this.compareMode(channel) < 2 || this.syncPwmExtremes(channel) || this.ocrValue(channel) > this.modeTop(this.waveformMode())) return;
    this.driveOutput(channel, this.compareMode(channel) === 3);
  }

  private compareMode(channel: PwmChannel): number {
    const value = this.cpu.data[TCCR1A]!;
    return channel === "A"
      ? (value >> COM1A0) & ((1 << (COM1A1 - COM1A0 + 1)) - 1)
      : (value >> COM1B0) & ((1 << (COM1B1 - COM1B0 + 1)) - 1);
  }

  private isPwmMode(): boolean {
    const mode = this.waveformMode();
    return this.isFastPwmMode(mode) || this.isDualSlopePwmMode(mode);
  }

  private outputPin(channel: PwmChannel): { port: PortName; bit: number } {
    return channel === "A" ? { port: "B", bit: 1 } : { port: "B", bit: 2 };
  }

  private driveOutput(channel: PwmChannel, high: boolean | undefined): void {
    const pin = this.outputPin(channel);
    this.gpio?.setPeripheralOutput(pin.port, pin.bit, high);
  }

  // --- Snapshot / restore (Phase 10) ---

  snapshot(): Timer1Snapshot {
    this.syncToCpuCycle();
    return {
      count: this.count,
      countingDown: this.countingDown,
      tempHigh: this.tempHigh,
      activeOcrA: this.activeOcrA,
      activeOcrB: this.activeOcrB,
      compareBlocked: this.compareBlocked,
      prescalerRemainder: this.prescalerRemainder,
      captureDelayRemaining: this.powerReduced || this.sleepPaused ? this.frozenCaptureRemainingCycles
        : this.cpu.clockEventRemainingCycles(this.onCaptureDelayEvent),
      captureInputHigh: this.captureInputHigh,
      filteredCaptureHigh: this.filteredCaptureHigh,
    };
  }

  restore(snap: Timer1Snapshot): void {
    this.powerReduced = false;
    this.prescalerHeld = false;
    this.sleepPaused = false;
    this.count = snap.count & 0xffff;
    this.countingDown = snap.countingDown ?? false;
    this.tempHigh = (snap.tempHigh ?? 0) & 0xff;
    this.activeOcrA = (snap.activeOcrA ?? this.bufferedOcrValue("A")) & 0xffff;
    this.activeOcrB = (snap.activeOcrB ?? this.bufferedOcrValue("B")) & 0xffff;
    this.compareBlocked = snap.compareBlocked ?? false;
    this.prescalerRemainder = snap.prescalerRemainder | 0;
    this.lastCycle = this.cpu.cycles;
    this.cpu.clearClockEvent(this.onCaptureDelayEvent);
    this.frozenCaptureRemainingCycles = 0;
    const captureDelay = snap.captureDelayRemaining ?? 0;
    this.captureInputHigh = snap.captureInputHigh ?? ((this.cpu.data[ACSR]! & (1 << ACIC)) !== 0
      ? (this.cpu.data[ACSR]! & (1 << ACO)) !== 0 : this.gpio?.readPin("B", 0) ?? false);
    this.filteredCaptureHigh = snap.filteredCaptureHigh ?? (captureDelay > 0 ? !this.captureInputHigh : this.captureInputHigh);
    if (captureDelay > 0) this.cpu.addClockEvent(this.onCaptureDelayEvent, captureDelay);
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }
}

function stepsUntil16BitValue(counter: number, target: number): number {
  return ((target - counter + 0xffff) & 0xffff) + 1;
}
