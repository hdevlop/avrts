import { OnRead, OnWrite } from "../core";
import {
  ACIC,
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
 * 16-bit TCNT1 is read back through hooks; the hardware TEMP-register protocol is
 * simplified away since the simulator stores each byte directly.
 */
export class Timer1 implements PwmSource {
  private count = 0;
  private countingDown = false;
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
  private readonly onCaptureDelayEvent = (): void => {
    this.performCapture();
  };

  constructor(
    private readonly cpu: CPU,
    private readonly gpio?: Gpio,
  ) {
    // ICP1 is PB0 (Arduino pin 8). The pin edge triggers capture unless the
    // comparator owns the trigger (ACSR.ACIC set).
    this.gpio?.onPinChange("B", 0, (high) => {
      if ((this.cpu.data[ACSR]! & (1 << ACIC)) !== 0) return;
      this.onCaptureEdge(high);
    });
  }

  private get pwmConfig(): PwmConfig {
    return {
      tccrA: TCCR1A,
      tccrB: TCCR1B,
      wgm2Bit: WGM12,
      max: 255,
      topValue: () => this.pwmTop(),
      mode: () => this.pwmMode(),
      ocrValue: (channel) =>
        channel === "A"
          ? (this.cpu.readData(OCR1AH) << 8) | this.cpu.readData(OCR1AL)
          : (this.cpu.readData(OCR1BH) << 8) | this.cpu.readData(OCR1BL),
    };
  }

  reset(): void {
    this.powerReduced = false;
    this.prescalerHeld = false;
    this.sleepPaused = false;
    this.count = 0;
    this.countingDown = false;
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.cpu.clearClockEvent(this.onCaptureDelayEvent);
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
    return this.count & 0xff;
  }
  @OnRead(TCNT1H) readTcnt1h(): number {
    this.syncToCpuCycle();
    return (this.count >> 8) & 0xff;
  }

  // A 16-bit write stores high then low; either byte updates the live counter.
  @OnWrite(TCNT1H) onWriteTcnt1h(_cpu: CPU, _addr: number, value: number): void {
    this.count = ((value & 0xff) << 8) | (this.count & 0xff);
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }
  @OnWrite(TCNT1L) onWriteTcnt1l(_cpu: CPU, _addr: number, value: number): void {
    this.count = (this.count & 0xff00) | (value & 0xff);
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  @OnWrite(TIFR1)
  onWriteTifr1(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.cpu.data[TIFR1] = oldValue & ~(value & TIMER1_FLAG_MASK);
  }

  @OnWrite(TCCR1B)
  onWriteTccr1b(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(TCCR1A)
  onWriteTccr1a(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(TIMSK1)
  onWriteTimsk1(): void {
    this.requestCompareIfEnabled("A");
    this.requestCompareIfEnabled("B");
    this.requestOverflowIfEnabled();
    this.requestCaptureIfEnabled();
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

  @OnWrite(OCR1AL) onWriteOcr1al(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.scheduleClockEvent();
    this.notifyPwm("A");
  }
  @OnWrite(OCR1AH) onWriteOcr1ah(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.scheduleClockEvent();
    this.notifyPwm("A");
  }
  @OnWrite(OCR1BL) onWriteOcr1bl(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.scheduleClockEvent();
    this.notifyPwm("B");
  }
  @OnWrite(OCR1BH) onWriteOcr1bh(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.scheduleClockEvent();
    this.notifyPwm("B");
  }

  @OnWrite(ICR1L) onWriteIcr1l(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }
  @OnWrite(ICR1H) onWriteIcr1h(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  readPwm(channel: PwmChannel): PwmSignal {
    return pwmSignal(this.cpu, this.pwmConfig, channel);
  }

  onPwmChange(channel: PwmChannel, listener: (signal: PwmSignal) => void): () => void {
    return this.pwm.on(channel, listener);
  }

  setPowerReduced(reduced: boolean): void {
    if (this.powerReduced === reduced) return;
    if (reduced) {
      this.syncToCpuCycle();
      this.powerReduced = true;
      this.cpu.clearClockEvent(this.onClockEvent);
      return;
    }
    this.powerReduced = false;
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
    if (paused) {
      this.syncToCpuCycle();
      this.sleepPaused = true;
      this.cpu.clearClockEvent(this.onClockEvent);
      return;
    }
    this.sleepPaused = false;
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
    if (this.powerReduced) return;
    const risingSelected = (this.cpu.data[TCCR1B]! & (1 << ICES1)) !== 0;
    if (high !== risingSelected) return;
    this.cpu.clearClockEvent(this.onCaptureDelayEvent);
    if ((this.cpu.data[TCCR1B]! & (1 << ICNC1)) !== 0) {
      // Noise canceler: the capture lands four system cycles after the edge.
      // A new qualifying edge inside the window restarts the filter.
      this.cpu.addClockEvent(this.onCaptureDelayEvent, NOISE_CANCELER_CYCLES);
      return;
    }
    this.performCapture();
  }

  private performCapture(): void {
    if (this.powerReduced) return;
    this.syncToCpuCycle();
    this.cpu.data[ICR1L] = this.count & 0xff;
    this.cpu.data[ICR1H] = (this.count >> 8) & 0xff;
    this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! | (1 << ICF1);
    this.requestCaptureIfEnabled();
  }

  private requestCaptureIfEnabled(): void {
    const flag = (this.cpu.data[TIFR1]! & (1 << ICF1)) !== 0;
    const enabled = (this.cpu.data[TIMSK1]! & (1 << ICIE1)) !== 0;
    if (!flag || !enabled) return;
    this.cpu.requestInterrupt(TIMER1_CAPT_VECTOR, () => {
      this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! & ~(1 << ICF1);
    });
  }

  private increment(): void {
    const mode = this.waveformMode();
    if (this.isDualSlopePwmMode(mode)) {
      this.incrementDualSlope(this.modeTop(mode));
      return;
    }

    this.count = (this.count + 1) & 0xffff;
    if (this.count === 0) this.handleBottom();
    this.handleCompare(this.count, "up");

    const top = this.singleSlopeTop(mode);
    if (top !== undefined && this.count === top) {
      // Fast PWM sets TOV1 at TOP; CTC (modes 4/12) clears without overflow.
      if (this.isFastPwmMode(mode)) this.setOverflowFlag();
      this.count = 0;
      this.handleBottom();
      return;
    }

    if (this.count !== 0) return;
    this.setOverflowFlag();
  }

  private incrementDualSlope(top: number): void {
    if (top === 0) {
      this.count = 0;
      this.handleBottom();
      this.setOverflowFlag();
      return;
    }

    if (this.countingDown) {
      this.count = Math.max(0, this.count - 1);
      this.handleCompare(this.count, "down");
      if (this.count === 0) {
        this.countingDown = false;
        this.handleBottom();
        this.setOverflowFlag();
      }
      return;
    }

    this.count = (this.count + 1) & 0xffff;
    this.handleCompare(this.count, "up");
    if (this.count >= top) {
      this.count = top;
      this.countingDown = true;
    }
  }

  private setOverflowFlag(): void {
    this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! | (1 << TOV1);
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

  private syncWithOldRegister(addr: number, oldValue: number): void {
    const current = this.cpu.data[addr]!;
    this.cpu.data[addr] = oldValue & 0xff;
    this.syncToCpuCycle();
    this.cpu.data[addr] = current;
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
    if (this.isDualSlopePwmMode(this.waveformMode())) return 1;

    return Math.min(
      stepsUntil16BitValue(this.count, this.ocrValue("A")),
      stepsUntil16BitValue(this.count, this.ocrValue("B")),
      stepsUntil16BitValue(this.count, this.singleSlopeTop(this.waveformMode()) ?? 0),
      stepsUntil16BitValue(this.count, 0),
    );
  }

  private handleCompare(counter: number, direction: "up" | "down"): void {
    if (counter === this.ocrValue("A")) {
      this.handleCompareOutput("A", direction);
      this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! | (1 << OCF1A);
      this.requestCompareIfEnabled("A");
    }
    if (counter === this.ocrValue("B")) {
      this.handleCompareOutput("B", direction);
      this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! | (1 << OCF1B);
      this.requestCompareIfEnabled("B");
    }
  }

  private requestCompareIfEnabled(channel: PwmChannel): void {
    const flagBit = channel === "A" ? OCF1A : OCF1B;
    const enableBit = channel === "A" ? OCIE1A : OCIE1B;
    const vector = channel === "A" ? TIMER1_COMPA_VECTOR : TIMER1_COMPB_VECTOR;
    const flag = (this.cpu.data[TIFR1]! & (1 << flagBit)) !== 0;
    const enabled = (this.cpu.data[TIMSK1]! & (1 << enableBit)) !== 0;
    if (!flag || !enabled) return;
    this.cpu.requestInterrupt(vector, () => {
      this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! & ~(1 << flagBit);
    });
  }

  private requestOverflowIfEnabled(): void {
    const overflowFlag = (this.cpu.data[TIFR1]! & (1 << TOV1)) !== 0;
    const overflowEnabled = (this.cpu.data[TIMSK1]! & (1 << TOIE1)) !== 0;
    if (!overflowFlag || !overflowEnabled) return;
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
    this.pwm.emit(channel, this.readPwm(channel));
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
      this.syncPwmOutput(channel, "bottom");
    } else if (this.compareMode(channel) === 0) {
      this.driveOutput(channel, undefined);
    }
  }

  private syncPwmOutput(channel: PwmChannel, edge: "bottom" | "compare", direction: "up" | "down" = "up"): void {
    const mode = this.compareMode(channel);
    if (!this.isPwmMode() || mode < 2) {
      this.driveOutput(channel, undefined);
      return;
    }
    const inverted = mode === 3;
    if (edge === "bottom" || direction === "down") {
      this.driveOutput(channel, !inverted);
    } else {
      this.driveOutput(channel, inverted);
    }
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
      prescalerRemainder: this.prescalerRemainder,
      captureDelayRemaining: this.cpu.clockEventRemainingCycles(this.onCaptureDelayEvent),
    };
  }

  restore(snap: Timer1Snapshot): void {
    this.powerReduced = false;
    this.prescalerHeld = false;
    this.sleepPaused = false;
    this.count = snap.count & 0xffff;
    this.countingDown = snap.countingDown ?? false;
    this.prescalerRemainder = snap.prescalerRemainder | 0;
    this.lastCycle = this.cpu.cycles;
    this.cpu.clearClockEvent(this.onCaptureDelayEvent);
    const captureDelay = snap.captureDelayRemaining ?? 0;
    if (captureDelay > 0) this.cpu.addClockEvent(this.onCaptureDelayEvent, captureDelay);
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }
}

function stepsUntil16BitValue(counter: number, target: number): number {
  return ((target - counter + 0xffff) & 0xffff) + 1;
}
