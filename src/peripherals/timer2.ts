import { OnRead, OnWrite } from "../core";
import {
  AS2,
  ASSR,
  COM2A0,
  COM2A1,
  COM2B0,
  COM2B1,
  CS20,
  CS21,
  CS22,
  OCF2A,
  OCF2B,
  OCIE2A,
  OCIE2B,
  OCR2A,
  OCR2AUB,
  OCR2B,
  OCR2BUB,
  TCCR2A,
  TCCR2B,
  TCN2UB,
  TCNT2,
  TCR2AUB,
  TCR2BUB,
  TIFR2,
  TIMER2_COMPA_VECTOR,
  TIMER2_COMPB_VECTOR,
  TIMER2_OVF_VECTOR,
  TIMSK2,
  TOIE2,
  TOV2,
  WGM20,
  WGM21,
  WGM22,
} from "../cpu";
import type { CPU } from "../cpu";
import type { Gpio } from "./gpio";
import { PwmBroadcaster, pwmSignal } from "./pwm";
import type { PwmConfig } from "./pwm";
import type { Timer2Snapshot } from "../snapshot";
import type { PortName, PwmChannel, PwmSignal, PwmSource } from "./types";

// Timer2's prescaler set is richer than Timer0/Timer1 (it adds /32 and /128).
const TIMER2_PRESCALER: Readonly<Record<number, number | undefined>> = {
  0b000: undefined,
  0b001: 1,
  0b010: 8,
  0b011: 32,
  0b100: 64,
  0b101: 128,
  0b110: 256,
  0b111: 1024,
};

const TIMER2_FLAG_MASK = (1 << TOV2) | (1 << OCF2A) | (1 << OCF2B);

// Timer2 asynchronous mode clocks from a 32.768 kHz watch crystal on TOSC.
const TOSC_HZ = 32768;
const ASSR_BUSY_MASK =
  (1 << TCN2UB) | (1 << OCR2AUB) | (1 << OCR2BUB) | (1 << TCR2AUB) | (1 << TCR2BUB);
const DEFAULT_CLOCK_HZ = 16_000_000;

/**
 * Timer2 (8-bit). Same shape as Timer0 — prescaler, TCNT2 overflow, TOV2 flag,
 * TOIE2 interrupt, TIFR2 write-1-to-clear — plus PWM duty reporting for OC2A
 * (Arduino pin 11) and OC2B (pin 3).
 */
export class Timer2 implements PwmSource {
  private prescalerRemainder = 0;
  private lastCycle = 0;
  private powerReduced = false;
  // GTCCR TSM+PSRASY holds the timer2 prescaler in reset (counter frozen).
  private prescalerHeld = false;
  private sleepPaused = false;
  private clockHz = DEFAULT_CLOCK_HZ;
  // Cached prescaler divisor, recomputed only when the CS bits (TCCR2B) change.
  // In async mode (ASSR.AS2) it is scaled by the CPU-cycles-per-TOSC-tick ratio.
  // tick() runs every instruction, so it must not re-read/re-map the register.
  private cachedPrescaler: number | undefined = undefined;
  private readonly pwm = new PwmBroadcaster();
  private readonly onClockEvent = (): void => {
    this.syncToCpuCycle();
    this.scheduleClockEvent();
  };
  // Clears the ASSR update-busy flags one TOSC period after an async write.
  private readonly onAsyncBusyClearEvent = (): void => {
    this.cpu.data[ASSR] = this.cpu.data[ASSR]! & ~ASSR_BUSY_MASK;
  };

  constructor(
    private readonly cpu: CPU,
    private readonly gpio?: Gpio,
  ) {}

  private get pwmConfig(): PwmConfig {
    return {
      tccrA: TCCR2A,
      tccrB: TCCR2B,
      wgm2Bit: WGM22,
      max: 255,
      ocrValue: (channel) => this.cpu.readData(channel === "A" ? OCR2A : OCR2B),
    };
  }

  reset(): void {
    this.powerReduced = false;
    this.prescalerHeld = false;
    this.sleepPaused = false;
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.cpu.clearClockEvent(this.onAsyncBusyClearEvent);
    this.refreshPrescaler();
    this.scheduleClockEvent();
    this.driveOutput("A", undefined);
    this.driveOutput("B", undefined);
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  /** The async TOSC ratio depends on the system clock; wired from useClock(). */
  setClock(clockHz: number): void {
    this.clockHz = clockHz;
    this.syncToCpuCycle();
    this.refreshPrescaler();
    this.scheduleClockEvent();
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

  @OnWrite(TIFR2)
  onWriteTifr2(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.cpu.data[TIFR2] = oldValue & ~(value & TIMER2_FLAG_MASK);
  }

  @OnWrite(TCNT2)
  onWriteTcnt2(): void {
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.markAsyncBusy(TCN2UB);
    this.scheduleClockEvent();
  }

  @OnWrite(ASSR)
  onWriteAssr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    // AS2/EXCLK are writable; the update-busy flags are hardware-owned.
    this.cpu.data[ASSR] = (value & ~ASSR_BUSY_MASK) | (oldValue & ASSR_BUSY_MASK);
    if (((value ^ oldValue) & (1 << AS2)) === 0) return;
    // Clock-domain switch: settle elapsed time at the old cached rate first.
    this.syncToCpuCycle();
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }

  @OnWrite(TCCR2B)
  onWriteTccr2b(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.markAsyncBusy(TCR2BUB);
    this.refreshPrescaler();
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(TIMSK2)
  onWriteTimsk2(): void {
    this.requestCompareIfEnabled("A");
    this.requestCompareIfEnabled("B");
    this.requestOverflowIfEnabled();
  }

  @OnWrite(TCCR2A)
  onWriteTccr2a(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.markAsyncBusy(TCR2AUB);
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(OCR2A)
  onWriteOcr2a(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.markAsyncBusy(OCR2AUB);
    this.scheduleClockEvent();
    this.notifyPwm("A");
  }

  @OnWrite(OCR2B)
  onWriteOcr2b(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.markAsyncBusy(OCR2BUB);
    this.scheduleClockEvent();
    this.notifyPwm("B");
  }

  @OnRead(TCNT2)
  readTcnt2(): number {
    this.syncToCpuCycle();
    return this.cpu.data[TCNT2]!;
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

  /** GTCCR TSM+PSRASY: hold the timer2 prescaler in reset (counter frozen). */
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

  /** GTCCR PSRASY: reset the timer2 prescaler (counter value untouched). */
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

  private asyncMode(): boolean {
    return (this.cpu.data[ASSR]! & (1 << AS2)) !== 0;
  }

  /**
   * CPU cycles per timer2 clock-source tick: 1 in sync mode, or the exact
   * `clockHz / 32768` ratio in async mode. The ratio is deliberately fractional
   * (488.28125 at 16 MHz) so the counter tracks the 32.768 kHz TOSC crystal
   * without accumulating rounding drift over a long run — the prescaler
   * remainder carries the fraction, matching native simavr's virtual TOSC.
   */
  private asyncScale(): number {
    return this.asyncMode() ? this.clockHz / TOSC_HZ : 1;
  }

  /** Integer cycles in one TOSC period, used to time the ASSR busy-flag clear. */
  private toscPeriodCycles(): number {
    return Math.max(1, Math.round(this.clockHz / TOSC_HZ));
  }

  /**
   * Async-register write protocol: the corresponding ASSR update-busy flag
   * stays set for one TOSC period. The written value applies immediately
   * (the hardware temp-register latch is approximated away); firmware that
   * follows the datasheet polls the flag before the next write.
   */
  private markAsyncBusy(bit: number): void {
    if (!this.asyncMode()) return;
    this.cpu.data[ASSR] = this.cpu.data[ASSR]! | (1 << bit);
    this.cpu.addClockEvent(this.onAsyncBusyClearEvent, this.toscPeriodCycles());
  }

  private incrementCounter(): void {
    const next = (this.cpu.data[TCNT2]! + 1) & 0xff;
    this.cpu.data[TCNT2] = next;
    if (next === 0) this.handleBottom();
    this.handleCompare(next);
    if (this.isCtcMode() && next === this.cpu.data[OCR2A]!) {
      this.cpu.data[TCNT2] = 0;
      this.handleBottom();
      return;
    }
    if (next !== 0) return;

    this.cpu.data[TIFR2] = this.cpu.data[TIFR2]! | (1 << TOV2);
    this.requestOverflowIfEnabled();
  }

  private advanceCounter(steps: number): void {
    let remaining = steps;
    while (remaining > 0) {
      const untilEvent = this.stepsUntilNextEvent();
      if (untilEvent > remaining) {
        this.cpu.data[TCNT2] = (this.cpu.data[TCNT2]! + remaining) & 0xff;
        return;
      }
      if (untilEvent > 1) {
        this.cpu.data[TCNT2] = (this.cpu.data[TCNT2]! + untilEvent - 1) & 0xff;
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
    this.cpu.addClockEvent(this.onClockEvent, Math.ceil(cycles));
  }

  private stepsUntilNextEvent(): number {
    const counter = this.cpu.data[TCNT2]!;
    return Math.min(
      stepsUntil8BitValue(counter, this.cpu.data[OCR2A]!),
      stepsUntil8BitValue(counter, this.cpu.data[OCR2B]!),
      stepsUntil8BitValue(counter, 0),
    );
  }

  private handleCompare(counter: number): void {
    if (counter === this.cpu.data[OCR2A]!) {
      this.handleCompareOutput("A");
      this.cpu.data[TIFR2] = this.cpu.data[TIFR2]! | (1 << OCF2A);
      this.requestCompareIfEnabled("A");
    }
    if (counter === this.cpu.data[OCR2B]!) {
      this.handleCompareOutput("B");
      this.cpu.data[TIFR2] = this.cpu.data[TIFR2]! | (1 << OCF2B);
      this.requestCompareIfEnabled("B");
    }
  }

  private requestCompareIfEnabled(channel: PwmChannel): void {
    const flagBit = channel === "A" ? OCF2A : OCF2B;
    const enableBit = channel === "A" ? OCIE2A : OCIE2B;
    const vector = channel === "A" ? TIMER2_COMPA_VECTOR : TIMER2_COMPB_VECTOR;
    const flag = (this.cpu.data[TIFR2]! & (1 << flagBit)) !== 0;
    const enabled = (this.cpu.data[TIMSK2]! & (1 << enableBit)) !== 0;
    if (!flag || !enabled) return;
    this.cpu.requestInterrupt(vector, () => {
      this.cpu.data[TIFR2] = this.cpu.data[TIFR2]! & ~(1 << flagBit);
    });
  }

  private requestOverflowIfEnabled(): void {
    const overflowFlag = (this.cpu.data[TIFR2]! & (1 << TOV2)) !== 0;
    const overflowEnabled = (this.cpu.data[TIMSK2]! & (1 << TOIE2)) !== 0;
    if (!overflowFlag || !overflowEnabled) return;
    this.cpu.requestInterrupt(TIMER2_OVF_VECTOR, () => {
      this.cpu.data[TIFR2] = this.cpu.data[TIFR2]! & ~(1 << TOV2);
    });
  }

  private prescaler(): number | undefined {
    const bits = this.cpu.data[TCCR2B]! & ((1 << CS22) | (1 << CS21) | (1 << CS20));
    return TIMER2_PRESCALER[bits];
  }

  /**
   * Recompute the cached prescaler from TCCR2B (scaled by the TOSC ratio in
   * async mode); call on every CS-bit, AS2, or clock change.
   */
  private refreshPrescaler(): void {
    const base = this.prescaler();
    this.cachedPrescaler = base === undefined ? undefined : base * this.asyncScale();
  }

  private isCtcMode(): boolean {
    const low = this.cpu.data[TCCR2A]! & ((1 << WGM21) | (1 << WGM20));
    const high = ((this.cpu.data[TCCR2B]! >> WGM22) & 1) << 2;
    return (high | low) === 0b010;
  }

  private notifyPwm(channel: PwmChannel): void {
    this.syncOutput(channel);
    this.pwm.emit(channel, this.readPwm(channel));
  }

  private handleBottom(): void {
    if (!this.isPwmMode()) return;
    this.syncPwmOutput("A", "bottom");
    this.syncPwmOutput("B", "bottom");
  }

  private handleCompareOutput(channel: PwmChannel): void {
    if (this.isPwmMode()) {
      this.syncPwmOutput(channel, "compare");
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

  private syncPwmOutput(channel: PwmChannel, edge: "bottom" | "compare"): void {
    const mode = this.compareMode(channel);
    if (!this.isPwmMode() || mode < 2) {
      this.driveOutput(channel, undefined);
      return;
    }
    const inverted = mode === 3;
    this.driveOutput(channel, edge === "bottom" ? !inverted : inverted);
  }

  private compareMode(channel: PwmChannel): number {
    const value = this.cpu.data[TCCR2A]!;
    return channel === "A"
      ? (value >> COM2A0) & ((1 << (COM2A1 - COM2A0 + 1)) - 1)
      : (value >> COM2B0) & ((1 << (COM2B1 - COM2B0 + 1)) - 1);
  }

  private isPwmMode(): boolean {
    const low = this.cpu.data[TCCR2A]! & ((1 << WGM21) | (1 << WGM20));
    const high = ((this.cpu.data[TCCR2B]! >> WGM22) & 1) << 2;
    const mode = high | low;
    return mode === 0b001 || mode === 0b011;
  }

  private outputPin(channel: PwmChannel): { port: PortName; bit: number } {
    return channel === "A" ? { port: "B", bit: 3 } : { port: "D", bit: 3 };
  }

  private driveOutput(channel: PwmChannel, high: boolean | undefined): void {
    const pin = this.outputPin(channel);
    this.gpio?.setPeripheralOutput(pin.port, pin.bit, high);
  }

  // --- Snapshot / restore (Phase 10) ---

  snapshot(): Timer2Snapshot {
    this.syncToCpuCycle();
    return {
      prescalerRemainder: this.prescalerRemainder,
      asyncBusyMask: this.cpu.data[ASSR]! & ASSR_BUSY_MASK,
      asyncBusyRemaining: this.cpu.clockEventRemainingCycles(this.onAsyncBusyClearEvent),
    };
  }

  restore(snap: Timer2Snapshot): void {
    this.powerReduced = false;
    this.prescalerHeld = false;
    this.sleepPaused = false;
    this.prescalerRemainder = snap.prescalerRemainder ?? 0;
    this.lastCycle = this.cpu.cycles;
    this.cpu.clearClockEvent(this.onAsyncBusyClearEvent);
    if ((snap.asyncBusyRemaining ?? 0) > 0 && (snap.asyncBusyMask ?? 0) !== 0) {
      this.cpu.addClockEvent(this.onAsyncBusyClearEvent, snap.asyncBusyRemaining!);
    }
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }
}

function stepsUntil8BitValue(counter: number, target: number): number {
  return ((target - counter + 255) & 0xff) + 1;
}
