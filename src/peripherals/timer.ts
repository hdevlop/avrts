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
 * Timer0 normal-mode foundation. It models the clock prescaler, TCNT0 overflow,
 * TOV0 flag, TOIE0 enable bit, interrupt request, and TIFR0 write-1-to-clear.
 */
export class Timer0 implements PwmSource {
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
      ocrValue: (channel) => this.cpu.readData(channel === "A" ? OCR0A : OCR0B),
    };
  }

  reset(): void {
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
    this.cpu.data[TIFR0] = oldValue & ~(value & TIMER0_FLAG_MASK);
    this.onWriteTimsk0();
  }

  @OnWrite(TCNT0)
  onWriteTcnt0(): void {
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  @OnWrite(TCCR0B)
  onWriteTccr0b(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(TIMSK0)
  onWriteTimsk0(): void {
    this.requestCompareIfEnabled("A");
    this.requestCompareIfEnabled("B");
    this.requestOverflowIfEnabled();
  }

  @OnWrite(TCCR0A)
  onWriteTccr0a(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(OCR0A)
  onWriteOcr0a(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.scheduleClockEvent();
    this.notifyPwm("A");
  }

  @OnWrite(OCR0B)
  onWriteOcr0b(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.syncWithOldRegister(addr, oldValue);
    this.scheduleClockEvent();
    this.notifyPwm("B");
  }

  @OnRead(TCNT0)
  readTcnt0(): number {
    this.syncToCpuCycle();
    return this.cpu.data[TCNT0]!;
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
    const next = (this.cpu.data[TCNT0]! + 1) & 0xff;
    this.cpu.data[TCNT0] = next;
    if (next === 0) this.handleBottom();
    this.handleCompare(next);
    if (this.isCtcMode() && next === this.cpu.data[OCR0A]!) {
      this.cpu.data[TCNT0] = 0;
      this.handleBottom();
      return;
    }
    if (next !== 0) return;

    this.cpu.data[TIFR0] = this.cpu.data[TIFR0]! | (1 << TOV0);
    this.requestOverflowIfEnabled();
  }

  private advanceCounter(steps: number): void {
    let remaining = steps;
    while (remaining > 0) {
      const untilEvent = this.stepsUntilNextEvent();
      if (untilEvent > remaining) {
        this.cpu.data[TCNT0] = (this.cpu.data[TCNT0]! + remaining) & 0xff;
        return;
      }
      if (untilEvent > 1) {
        this.cpu.data[TCNT0] = (this.cpu.data[TCNT0]! + untilEvent - 1) & 0xff;
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
    this.cpu.addClockEvent(this.onClockEvent, cycles);
  }

  private stepsUntilNextEvent(): number {
    const counter = this.cpu.data[TCNT0]!;
    return Math.min(
      stepsUntil8BitValue(counter, this.cpu.data[OCR0A]!),
      stepsUntil8BitValue(counter, this.cpu.data[OCR0B]!),
      stepsUntil8BitValue(counter, 0),
    );
  }

  private handleCompare(counter: number): void {
    if (counter === this.cpu.data[OCR0A]!) {
      this.handleCompareOutput("A");
      this.cpu.data[TIFR0] = this.cpu.data[TIFR0]! | (1 << OCF0A);
      this.requestCompareIfEnabled("A");
    }
    if (counter === this.cpu.data[OCR0B]!) {
      this.handleCompareOutput("B");
      this.cpu.data[TIFR0] = this.cpu.data[TIFR0]! | (1 << OCF0B);
      this.requestCompareIfEnabled("B");
    }
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

  private isCtcMode(): boolean {
    const low = this.cpu.data[TCCR0A]! & ((1 << WGM01) | (1 << WGM00));
    const high = ((this.cpu.data[TCCR0B]! >> WGM02) & 1) << 2;
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
    const value = this.cpu.data[TCCR0A]!;
    return channel === "A"
      ? (value >> COM0A0) & ((1 << (COM0A1 - COM0A0 + 1)) - 1)
      : (value >> COM0B0) & ((1 << (COM0B1 - COM0B0 + 1)) - 1);
  }

  private isPwmMode(): boolean {
    const low = this.cpu.data[TCCR0A]! & ((1 << WGM01) | (1 << WGM00));
    const high = ((this.cpu.data[TCCR0B]! >> WGM02) & 1) << 2;
    const mode = high | low;
    return mode === 0b001 || mode === 0b011;
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
    return { prescalerRemainder: this.prescalerRemainder };
  }

  restore(snap: Timer0Snapshot): void {
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
