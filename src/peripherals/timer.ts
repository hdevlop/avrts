import { OnRead, OnWrite } from "../core";
import {
  COM0A0,
  COM0A1,
  COM0B0,
  COM0B1,
  CS00,
  CS01,
  CS02,
  OCF0A,
  OCF0B,
  OCIE0A,
  OCIE0B,
  OCR0A,
  OCR0B,
  TCCR0B,
  TCCR0A,
  TCNT0,
  TIFR0,
  TIMER0_COMPA_VECTOR,
  TIMER0_COMPB_VECTOR,
  TIMER0_OVF_VECTOR,
  TIMSK0,
  TOIE0,
  TOV0,
  WGM00,
  WGM01,
  WGM02,
} from "../cpu";
import type { CPU } from "../cpu";
import type { Gpio } from "./gpio";
import { PwmBroadcaster, pwmSignal } from "./pwm";
import type { PwmConfig } from "./pwm";
import type { Timer0Snapshot } from "../snapshot";
import type { PortName, PwmChannel, PwmSignal, PwmSource } from "./types";

const TIMER0_PRESCALER: Readonly<Record<number, number | undefined>> = {
  0b000: undefined,
  0b001: 1,
  0b010: 8,
  0b011: 64,
  0b100: 256,
  0b101: 1024,
  0b110: undefined,
  0b111: undefined,
};

const TIMER0_FLAG_MASK = (1 << TOV0) | (1 << OCF0A) | (1 << OCF0B);

/**
 * Timer0: normal/CTC, fixed and OCR0A-TOP fast/phase-correct PWM, double-buffered
 * compare words, counter-write compare blocking, and delayed compare flags.
 */
export class Timer0 implements PwmSource {
  private countingDown = false;
  private activeOcrA = 0;
  private activeOcrB = 0;
  private compareBlocked = false;
  private prescalerRemainder = 0;
  private lastCycle = 0;
  private powerReduced = false;
  // GTCCR TSM+PSRSYNC holds the shared prescaler in reset (counter frozen).
  private prescalerHeld = false;
  private sleepPaused = false;
  // Cached prescaler divisor, recomputed only when the CS bits (TCCR0B) change.
  // tick() runs every instruction, so it must not re-read/re-map the register.
  private cachedPrescaler: number | undefined = undefined;
  private readonly pwm = new PwmBroadcaster();
  private readonly onClockEvent = (): void => {
    this.syncToCpuCycle();
    this.scheduleClockEvent();
  };

  constructor(
    private readonly cpu: CPU,
    private readonly gpio?: Gpio,
  ) {}

  private get pwmConfig(): PwmConfig {
    return {
      tccrA: TCCR0A,
      tccrB: TCCR0B,
      wgm2Bit: WGM02,
      max: 255,
      topValue: () => this.modeTop(),
      mode: () => this.pwmMode(),
      ocrValue: (channel) => this.ocrValue(channel),
    };
  }

  reset(): void {
    this.countingDown = false;
    this.activeOcrA = 0;
    this.activeOcrB = 0;
    this.compareBlocked = false;
    this.powerReduced = false;
    this.prescalerHeld = false;
    this.sleepPaused = false;
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
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
      this.incrementCounter();
    }
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  @OnWrite(TIFR0)
  onWriteTifr0(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.cpu.data[TIFR0] = oldValue & TIMER0_FLAG_MASK & ~value;
    this.onWriteTimsk0();
  }

  @OnWrite(TCNT0)
  onWriteTcnt0(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.compareBlocked = true;
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  @OnWrite(TCCR0B)
  onWriteTccr0b(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    const oldMode = this.syncWithOldRegister(addr, oldValue);
    // FOC strobes read as zero and never set flags or clear CTC.
    const strobes = this.cpu.data[TCCR0B]! & 0xc0;
    this.cpu.data[TCCR0B] = this.cpu.data[TCCR0B]! & 0x0f;
    this.updateWaveformMode(oldMode);
    if (!this.isPwmMode()) {
      if ((strobes & 0x80) !== 0) this.handleCompareOutput("A");
      if ((strobes & 0x40) !== 0) this.handleCompareOutput("B");
    }
    if (((oldValue ^ this.cpu.data[TCCR0B]!) & 7) !== 0) this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(TIMSK0)
  onWriteTimsk0(): void {
    this.cpu.data[TIMSK0] = this.cpu.data[TIMSK0]! & TIMER0_FLAG_MASK;
    this.requestCompareIfEnabled("A");
    this.requestCompareIfEnabled("B");
    this.requestOverflowIfEnabled();
  }

  @OnWrite(TCCR0A)
  onWriteTccr0a(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    const oldMode = this.syncWithOldRegister(addr, oldValue);
    this.cpu.data[TCCR0A] = this.cpu.data[TCCR0A]! & 0xf3;
    this.updateWaveformMode(oldMode);
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(OCR0A)
  @OnWrite(OCR0B)
  onWriteOcr0(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    if (!this.isPwmMode()) {
      this.updateCompareBuffers();
      this.scheduleClockEvent();
    }
  }

  @OnRead(TCNT0)
  readTcnt0(): number {
    this.syncToCpuCycle();
    return this.cpu.data[TCNT0]!;
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

  /** GTCCR TSM+PSRSYNC: hold the shared prescaler in reset (counter frozen). */
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

  private frozen(): boolean {
    return this.powerReduced || this.prescalerHeld || this.sleepPaused;
  }

  private incrementCounter(): void {
    const counter = this.cpu.data[TCNT0]!;
    const mode = this.waveformMode();
    const top = this.modeTop();
    // Equality is sampled before counting: OCF appears on the following clock.
    const blocked = this.compareBlocked;
    this.assertCompareFlags(counter, blocked);
    this.compareBlocked = false;
    if (mode === 1 || mode === 5) {
      if (top === 0) {
        this.cpu.data[TCNT0] = 0;
        this.updateCompareBuffers();
        this.handleBottom();
        this.setOverflowFlag();
        return;
      }
      const next = (counter + (this.countingDown ? -1 : 1)) & 0xff;
      this.cpu.data[TCNT0] = next;
      this.handleCompare(next, this.countingDown ? "down" : "up");
      if (this.countingDown && next === 0) {
        this.countingDown = false;
        this.handleBottom();
        this.setOverflowFlag();
      } else if (!this.countingDown && next === top) {
        this.countingDown = true;
        this.updateCompareBuffers();
        // A new duty after a full-duty period must start the falling slope low.
        this.syncPwmAtTop("A");
        this.syncPwmAtTop("B");
      }
      return;
    }

    if ((mode === 2 || mode === 3 || mode === 7) && counter === top && (!blocked || mode === 3)) {
      this.cpu.data[TCNT0] = 0;
      if (mode !== 2) {
        this.updateCompareBuffers();
        this.handleBottom();
        // The 8-bit fast-PWM overflow edge is TOP -> BOTTOM (timing diagrams).
        this.setOverflowFlag();
      } else if (counter === 0xff) this.setOverflowFlag();
      this.handleCompare(0);
      return;
    }

    const next = (counter + 1) & 0xff;
    this.cpu.data[TCNT0] = next;
    if (next === 0) {
      if (this.isPwmMode()) this.updateCompareBuffers();
      this.handleBottom();
      if (mode !== 3 && mode !== 7) this.setOverflowFlag();
    }
    if (counter === 0 && !blocked && (mode === 3 || mode === 7)) {
      if (this.activeOcrA === 0) this.handleCompareOutput("A");
      if (this.activeOcrB === 0) this.handleCompareOutput("B");
    }
    this.handleCompare(next);
  }

  private setOverflowFlag(): void {
    this.cpu.setInterruptFlag(TIFR0, 1 << TOV0);
    this.requestOverflowIfEnabled();
  }

  private advanceCounter(steps: number): void {
    let remaining = steps;
    while (remaining > 0) {
      const untilEvent = this.stepsUntilNextEvent();
      if (untilEvent > remaining) {
        this.cpu.data[TCNT0] = (this.cpu.data[TCNT0]! + (this.countingDown ? -remaining : remaining)) & 0xff;
        return;
      }
      if (untilEvent > 1) {
        this.cpu.data[TCNT0] = (this.cpu.data[TCNT0]! + (this.countingDown ? 1 - untilEvent : untilEvent - 1)) & 0xff;
        remaining -= untilEvent - 1;
      }
      this.incrementCounter();
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
    const counter = this.cpu.data[TCNT0]!;
    const mode = this.waveformMode();
    if (this.compareBlocked || counter === this.activeOcrA || counter === this.activeOcrB) return 1;
    if ((mode === 2 || this.isPwmMode()) && (counter === this.modeTop() || counter === 0)) return 1;
    if ((mode === 1 || mode === 5) && this.countingDown) {
      return Math.min(
        counter,
        this.activeOcrA < counter ? counter - this.activeOcrA : counter,
        this.activeOcrB < counter ? counter - this.activeOcrB : counter,
      );
    }
    return Math.min(
      stepsUntil8BitValue(counter, this.activeOcrA),
      stepsUntil8BitValue(counter, this.activeOcrB),
      stepsUntil8BitValue(counter, this.modeTop()),
      stepsUntil8BitValue(counter, 0),
    );
  }

  private assertCompareFlags(counter: number, blocked: boolean): void {
    if (blocked) return;
    if (counter === this.activeOcrA) {
      this.cpu.setInterruptFlag(TIFR0, 1 << OCF0A);
      this.requestCompareIfEnabled("A");
    }
    if (counter === this.activeOcrB) {
      this.cpu.setInterruptFlag(TIFR0, 1 << OCF0B);
      this.requestCompareIfEnabled("B");
    }
  }

  private handleCompare(counter: number, direction: "up" | "down" = "up"): void {
    if (counter === this.activeOcrA) this.handleCompareOutput("A", direction);
    if (counter === this.activeOcrB) this.handleCompareOutput("B", direction);
  }

  private requestCompareIfEnabled(channel: PwmChannel): void {
    const flagBit = channel === "A" ? OCF0A : OCF0B;
    const enableBit = channel === "A" ? OCIE0A : OCIE0B;
    const vector = channel === "A" ? TIMER0_COMPA_VECTOR : TIMER0_COMPB_VECTOR;
    const flag = (this.cpu.data[TIFR0]! & (1 << flagBit)) !== 0;
    const enabled = (this.cpu.data[TIMSK0]! & (1 << enableBit)) !== 0;
    if (!flag || !enabled) {
      this.cpu.clearInterrupt(vector);
      return;
    }
    this.cpu.requestInterrupt(vector, () => {
      this.cpu.data[TIFR0] = this.cpu.data[TIFR0]! & ~(1 << flagBit);
    });
  }

  private requestOverflowIfEnabled(): void {
    const overflowFlag = (this.cpu.data[TIFR0]! & (1 << TOV0)) !== 0;
    const overflowEnabled = (this.cpu.data[TIMSK0]! & (1 << TOIE0)) !== 0;
    if (!overflowFlag || !overflowEnabled) {
      this.cpu.clearInterrupt(TIMER0_OVF_VECTOR);
      return;
    }
    this.cpu.requestInterrupt(TIMER0_OVF_VECTOR, () => {
      this.cpu.data[TIFR0] = this.cpu.data[TIFR0]! & ~(1 << TOV0);
    });
  }

  private prescaler(): number | undefined {
    const bits = this.cpu.data[TCCR0B]! & ((1 << CS02) | (1 << CS01) | (1 << CS00));
    return TIMER0_PRESCALER[bits];
  }

  /** Recompute the cached prescaler from TCCR0B; call on every CS-bit change. */
  private refreshPrescaler(): void {
    this.cachedPrescaler = this.prescaler();
  }

  private waveformMode(): number {
    return ((this.cpu.data[TCCR0B]! >> WGM02) & 1) << 2 | (this.cpu.data[TCCR0A]! & 3);
  }

  private modeTop(): number {
    const mode = this.waveformMode();
    return mode === 2 || mode === 5 || mode === 7 ? this.activeOcrA : 255;
  }

  private pwmMode(): PwmSignal["mode"] {
    const mode = this.waveformMode();
    return mode === 1 || mode === 5 ? "phase-correct-pwm"
      : mode === 3 || mode === 7 ? "fast-pwm" : mode === 0 ? "off" : "other";
  }

  private ocrValue(channel: PwmChannel): number {
    return channel === "A" ? this.activeOcrA : this.activeOcrB;
  }

  private updateWaveformMode(oldMode: number): void {
    if (oldMode === this.waveformMode()) return;
    if (this.waveformMode() !== 1 && this.waveformMode() !== 5) this.countingDown = false;
    if (!this.isPwmMode()) this.updateCompareBuffers();
  }

  private updateCompareBuffers(): void {
    const nextA = this.cpu.data[OCR0A]!;
    const nextB = this.cpu.data[OCR0B]!;
    if (nextA === this.activeOcrA && nextB === this.activeOcrB) return;
    this.activeOcrA = nextA;
    this.activeOcrB = nextB;
    this.emitPwm("A");
    this.emitPwm("B");
  }

  private notifyPwm(channel: PwmChannel): void {
    this.syncOutput(channel);
    this.emitPwm(channel);
  }

  private emitPwm(channel: PwmChannel): void {
    this.pwm.emit(channel, this.readPwm(channel));
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
      const compare = this.compareMode(channel);
      if (compare === 0 || (compare === 1 && !this.pwmToggleEnabled(channel))) this.driveOutput(channel, undefined);
      else if (this.cpu.data[TCNT0] === 0) this.syncPwmOutput(channel, "bottom");
    } else if (this.compareMode(channel) === 0) this.driveOutput(channel, undefined);
  }

  private syncPwmOutput(channel: PwmChannel, edge: "bottom" | "compare", direction: "up" | "down" = "up"): void {
    const mode = this.compareMode(channel);
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
    if (edge === "compare" && this.pwmMode() === "fast-pwm" && this.ocrValue(channel) === 0 && this.cpu.data[TCNT0] === 0) return;
    this.driveOutput(channel, edge === "bottom" || direction === "down" ? mode !== 3 : mode === 3);
  }

  private syncPwmAtTop(channel: PwmChannel): void {
    if (this.compareMode(channel) < 2 || this.syncPwmExtremes(channel) || this.ocrValue(channel) > this.modeTop()) return;
    this.driveOutput(channel, this.compareMode(channel) === 3);
  }

  private syncPwmExtremes(channel: PwmChannel): boolean {
    const mode = this.compareMode(channel);
    if (mode < 2) return false;
    if (this.ocrValue(channel) === this.modeTop()) {
      this.driveOutput(channel, mode !== 3);
      return true;
    }
    if (this.ocrValue(channel) === 0 && this.pwmMode() === "phase-correct-pwm") {
      this.driveOutput(channel, mode === 3);
      return true;
    }
    return false;
  }

  private pwmToggleEnabled(channel: PwmChannel): boolean {
    const mode = this.waveformMode();
    return channel === "A" && (mode === 5 || mode === 7);
  }

  private compareMode(channel: PwmChannel): number {
    const value = this.cpu.data[TCCR0A]!;
    return channel === "A"
      ? (value >> COM0A0) & ((1 << (COM0A1 - COM0A0 + 1)) - 1)
      : (value >> COM0B0) & ((1 << (COM0B1 - COM0B0 + 1)) - 1);
  }

  private isPwmMode(): boolean {
    const mode = this.waveformMode();
    return mode === 1 || mode === 3 || mode === 5 || mode === 7;
  }

  private outputPin(channel: PwmChannel): { port: PortName; bit: number } {
    return channel === "A" ? { port: "D", bit: 6 } : { port: "D", bit: 5 };
  }

  private driveOutput(channel: PwmChannel, high: boolean | undefined): void {
    const pin = this.outputPin(channel);
    this.gpio?.setPeripheralOutput(pin.port, pin.bit, high);
  }

  // --- Snapshot / restore (Phase 10) ---

  snapshot(): Timer0Snapshot {
    this.syncToCpuCycle();
    return {
      countingDown: this.countingDown,
      activeOcrA: this.activeOcrA,
      activeOcrB: this.activeOcrB,
      compareBlocked: this.compareBlocked,
      prescalerRemainder: this.prescalerRemainder,
    };
  }

  restore(snap: Timer0Snapshot): void {
    this.countingDown = snap.countingDown ?? false;
    this.activeOcrA = (snap.activeOcrA ?? this.cpu.data[OCR0A]!) & 0xff;
    this.activeOcrB = (snap.activeOcrB ?? this.cpu.data[OCR0B]!) & 0xff;
    this.compareBlocked = snap.compareBlocked ?? false;
    this.prescalerHeld = false;
    this.powerReduced = false;
    this.sleepPaused = false;
    this.prescalerRemainder = snap.prescalerRemainder | 0;
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }
}

function stepsUntil8BitValue(counter: number, target: number): number {
  return ((target - counter + 255) & 0xff) + 1;
}
