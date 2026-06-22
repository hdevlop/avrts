import { OnWrite } from "../core";
import {
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
  OCR2B,
  TCCR2A,
  TCCR2B,
  TCNT2,
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

/**
 * Timer2 (8-bit). Same shape as Timer0 — prescaler, TCNT2 overflow, TOV2 flag,
 * TOIE2 interrupt, TIFR2 write-1-to-clear — plus PWM duty reporting for OC2A
 * (Arduino pin 11) and OC2B (pin 3).
 */
export class Timer2 implements PwmSource {
  private prescalerRemainder = 0;
  private readonly pwm = new PwmBroadcaster();

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
    this.prescalerRemainder = 0;
    this.driveOutput("A", undefined);
    this.driveOutput("B", undefined);
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  tick(cycles: number): void {
    const prescaler = this.prescaler();
    if (prescaler === undefined) return;
    this.prescalerRemainder += cycles;
    while (this.prescalerRemainder >= prescaler) {
      this.prescalerRemainder -= prescaler;
      this.incrementCounter();
    }
  }

  @OnWrite(TIFR2)
  onWriteTifr2(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.cpu.data[TIFR2] = oldValue & ~(value & TIMER2_FLAG_MASK);
  }

  @OnWrite(TCNT2)
  onWriteTcnt2(): void {
    this.prescalerRemainder = 0;
  }

  @OnWrite(TCCR2B)
  onWriteTccr2b(): void {
    this.prescalerRemainder = 0;
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
  onWriteTccr2a(): void {
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(OCR2A)
  onWriteOcr2a(): void {
    this.notifyPwm("A");
  }

  @OnWrite(OCR2B)
  onWriteOcr2b(): void {
    this.notifyPwm("B");
  }

  readPwm(channel: PwmChannel): PwmSignal {
    return pwmSignal(this.cpu, this.pwmConfig, channel);
  }

  onPwmChange(channel: PwmChannel, listener: (signal: PwmSignal) => void): () => void {
    return this.pwm.on(channel, listener);
  }

  private incrementCounter(): void {
    const next = (this.cpu.readData(TCNT2) + 1) & 0xff;
    this.cpu.data[TCNT2] = next;
    if (next === 0) this.handleBottom();
    this.handleCompare(next);
    if (this.isCtcMode() && next === this.cpu.readData(OCR2A)) {
      this.cpu.data[TCNT2] = 0;
      this.handleBottom();
      return;
    }
    if (next !== 0) return;

    this.cpu.data[TIFR2] = this.cpu.readData(TIFR2) | (1 << TOV2);
    this.requestOverflowIfEnabled();
  }

  private handleCompare(counter: number): void {
    if (counter === this.cpu.readData(OCR2A)) {
      this.handleCompareOutput("A");
      this.cpu.data[TIFR2] = this.cpu.readData(TIFR2) | (1 << OCF2A);
      this.requestCompareIfEnabled("A");
    }
    if (counter === this.cpu.readData(OCR2B)) {
      this.handleCompareOutput("B");
      this.cpu.data[TIFR2] = this.cpu.readData(TIFR2) | (1 << OCF2B);
      this.requestCompareIfEnabled("B");
    }
  }

  private requestCompareIfEnabled(channel: PwmChannel): void {
    const flagBit = channel === "A" ? OCF2A : OCF2B;
    const enableBit = channel === "A" ? OCIE2A : OCIE2B;
    const vector = channel === "A" ? TIMER2_COMPA_VECTOR : TIMER2_COMPB_VECTOR;
    const flag = (this.cpu.readData(TIFR2) & (1 << flagBit)) !== 0;
    const enabled = (this.cpu.readData(TIMSK2) & (1 << enableBit)) !== 0;
    if (!flag || !enabled) return;
    this.cpu.requestInterrupt(vector, () => {
      this.cpu.data[TIFR2] = this.cpu.readData(TIFR2) & ~(1 << flagBit);
    });
  }

  private requestOverflowIfEnabled(): void {
    const overflowFlag = (this.cpu.readData(TIFR2) & (1 << TOV2)) !== 0;
    const overflowEnabled = (this.cpu.readData(TIMSK2) & (1 << TOIE2)) !== 0;
    if (!overflowFlag || !overflowEnabled) return;
    this.cpu.requestInterrupt(TIMER2_OVF_VECTOR, () => {
      this.cpu.data[TIFR2] = this.cpu.readData(TIFR2) & ~(1 << TOV2);
    });
  }

  private prescaler(): number | undefined {
    const bits = this.cpu.readData(TCCR2B) & ((1 << CS22) | (1 << CS21) | (1 << CS20));
    return TIMER2_PRESCALER[bits];
  }

  private isCtcMode(): boolean {
    const low = this.cpu.readData(TCCR2A) & ((1 << WGM21) | (1 << WGM20));
    const high = ((this.cpu.readData(TCCR2B) >> WGM22) & 1) << 2;
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
    const value = this.cpu.readData(TCCR2A);
    return channel === "A"
      ? (value >> COM2A0) & ((1 << (COM2A1 - COM2A0 + 1)) - 1)
      : (value >> COM2B0) & ((1 << (COM2B1 - COM2B0 + 1)) - 1);
  }

  private isPwmMode(): boolean {
    const low = this.cpu.readData(TCCR2A) & ((1 << WGM21) | (1 << WGM20));
    const high = ((this.cpu.readData(TCCR2B) >> WGM22) & 1) << 2;
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
    return { prescalerRemainder: this.prescalerRemainder };
  }

  restore(snap: Timer2Snapshot): void {
    this.prescalerRemainder = snap.prescalerRemainder | 0;
  }
}
