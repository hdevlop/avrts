import { OnRead, OnWrite } from "../core";
import {
  COM1A0,
  COM1A1,
  COM1B0,
  COM1B1,
  CS10,
  CS11,
  CS12,
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
  TCNT1H,
  TCNT1L,
  TIFR1,
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

const TIMER1_FLAG_MASK = (1 << TOV1) | (1 << OCF1A) | (1 << OCF1B);

/**
 * Timer1 (16-bit). Models the prescaler, a 16-bit free-running counter, TOV1
 * overflow + the TOIE1 interrupt, and 8-bit PWM duty reporting for OC1A (Arduino
 * pin 9) and OC1B (pin 10) — the analogWrite mode the Arduino core uses. The
 * 16-bit TCNT1 is read back through hooks; the hardware TEMP-register protocol is
 * simplified away since the simulator stores each byte directly.
 */
export class Timer1 implements PwmSource {
  private count = 0;
  private prescalerRemainder = 0;
  private readonly pwm = new PwmBroadcaster();

  constructor(
    private readonly cpu: CPU,
    private readonly gpio?: Gpio,
  ) {}

  private get pwmConfig(): PwmConfig {
    return {
      tccrA: TCCR1A,
      tccrB: TCCR1B,
      wgm2Bit: WGM12,
      max: 255,
      ocrValue: (channel) =>
        channel === "A"
          ? (this.cpu.readData(OCR1AH) << 8) | this.cpu.readData(OCR1AL)
          : (this.cpu.readData(OCR1BH) << 8) | this.cpu.readData(OCR1BL),
    };
  }

  reset(): void {
    this.count = 0;
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
      this.increment();
    }
  }

  // 16-bit counter readback: low byte then high byte (AVR access order).
  @OnRead(TCNT1L) readTcnt1l(): number {
    return this.count & 0xff;
  }
  @OnRead(TCNT1H) readTcnt1h(): number {
    return (this.count >> 8) & 0xff;
  }

  // A 16-bit write stores high then low; either byte updates the live counter.
  @OnWrite(TCNT1H) onWriteTcnt1h(_cpu: CPU, _addr: number, value: number): void {
    this.count = ((value & 0xff) << 8) | (this.count & 0xff);
    this.prescalerRemainder = 0;
  }
  @OnWrite(TCNT1L) onWriteTcnt1l(_cpu: CPU, _addr: number, value: number): void {
    this.count = (this.count & 0xff00) | (value & 0xff);
    this.prescalerRemainder = 0;
  }

  @OnWrite(TIFR1)
  onWriteTifr1(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.cpu.data[TIFR1] = oldValue & ~(value & TIMER1_FLAG_MASK);
  }

  @OnWrite(TCCR1B)
  onWriteTccr1b(): void {
    this.prescalerRemainder = 0;
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(TCCR1A)
  onWriteTccr1a(): void {
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(TIMSK1)
  onWriteTimsk1(): void {
    this.requestCompareIfEnabled("A");
    this.requestCompareIfEnabled("B");
    this.requestOverflowIfEnabled();
  }

  @OnWrite(OCR1AL) onWriteOcr1al(): void {
    this.notifyPwm("A");
  }
  @OnWrite(OCR1AH) onWriteOcr1ah(): void {
    this.notifyPwm("A");
  }
  @OnWrite(OCR1BL) onWriteOcr1bl(): void {
    this.notifyPwm("B");
  }
  @OnWrite(OCR1BH) onWriteOcr1bh(): void {
    this.notifyPwm("B");
  }

  readPwm(channel: PwmChannel): PwmSignal {
    return pwmSignal(this.cpu, this.pwmConfig, channel);
  }

  onPwmChange(channel: PwmChannel, listener: (signal: PwmSignal) => void): () => void {
    return this.pwm.on(channel, listener);
  }

  private increment(): void {
    this.count = (this.count + 1) & 0xffff;
    if (this.count === 0) this.handleBottom();
    this.handleCompare(this.count);
    if (this.isCtcMode() && this.count === this.ocrValue("A")) {
      this.count = 0;
      this.handleBottom();
      return;
    }
    if (this.count !== 0) return;

    this.cpu.data[TIFR1] = this.cpu.readData(TIFR1) | (1 << TOV1);
    this.requestOverflowIfEnabled();
  }

  private handleCompare(counter: number): void {
    if (counter === this.ocrValue("A")) {
      this.handleCompareOutput("A");
      this.cpu.data[TIFR1] = this.cpu.readData(TIFR1) | (1 << OCF1A);
      this.requestCompareIfEnabled("A");
    }
    if (counter === this.ocrValue("B")) {
      this.handleCompareOutput("B");
      this.cpu.data[TIFR1] = this.cpu.readData(TIFR1) | (1 << OCF1B);
      this.requestCompareIfEnabled("B");
    }
  }

  private requestCompareIfEnabled(channel: PwmChannel): void {
    const flagBit = channel === "A" ? OCF1A : OCF1B;
    const enableBit = channel === "A" ? OCIE1A : OCIE1B;
    const vector = channel === "A" ? TIMER1_COMPA_VECTOR : TIMER1_COMPB_VECTOR;
    const flag = (this.cpu.readData(TIFR1) & (1 << flagBit)) !== 0;
    const enabled = (this.cpu.readData(TIMSK1) & (1 << enableBit)) !== 0;
    if (!flag || !enabled) return;
    this.cpu.requestInterrupt(vector, () => {
      this.cpu.data[TIFR1] = this.cpu.readData(TIFR1) & ~(1 << flagBit);
    });
  }

  private requestOverflowIfEnabled(): void {
    const overflowFlag = (this.cpu.readData(TIFR1) & (1 << TOV1)) !== 0;
    const overflowEnabled = (this.cpu.readData(TIMSK1) & (1 << TOIE1)) !== 0;
    if (!overflowFlag || !overflowEnabled) return;
    this.cpu.requestInterrupt(TIMER1_OVF_VECTOR, () => {
      this.cpu.data[TIFR1] = this.cpu.readData(TIFR1) & ~(1 << TOV1);
    });
  }

  private prescaler(): number | undefined {
    const bits = this.cpu.readData(TCCR1B) & ((1 << CS12) | (1 << CS11) | (1 << CS10));
    return TIMER1_PRESCALER[bits];
  }

  private notifyPwm(channel: PwmChannel): void {
    this.syncOutput(channel);
    this.pwm.emit(channel, this.readPwm(channel));
  }

  private ocrValue(channel: PwmChannel): number {
    return channel === "A"
      ? (this.cpu.readData(OCR1AH) << 8) | this.cpu.readData(OCR1AL)
      : (this.cpu.readData(OCR1BH) << 8) | this.cpu.readData(OCR1BL);
  }

  private isCtcMode(): boolean {
    const low = this.cpu.readData(TCCR1A) & ((1 << WGM11) | (1 << WGM10));
    const high =
      (((this.cpu.readData(TCCR1B) >> WGM12) & 1) << 2) |
      (((this.cpu.readData(TCCR1B) >> WGM13) & 1) << 3);
    return (high | low) === 0b0100;
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
    const value = this.cpu.readData(TCCR1A);
    return channel === "A"
      ? (value >> COM1A0) & ((1 << (COM1A1 - COM1A0 + 1)) - 1)
      : (value >> COM1B0) & ((1 << (COM1B1 - COM1B0 + 1)) - 1);
  }

  private isPwmMode(): boolean {
    const low = this.cpu.readData(TCCR1A) & ((1 << WGM11) | (1 << WGM10));
    const high =
      (((this.cpu.readData(TCCR1B) >> WGM12) & 1) << 2) |
      (((this.cpu.readData(TCCR1B) >> WGM13) & 1) << 3);
    const mode = high | low;
    return mode === 0b0001 || mode === 0b0011 || mode === 0b0101 || mode === 0b0111;
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
    return { count: this.count, prescalerRemainder: this.prescalerRemainder };
  }

  restore(snap: Timer1Snapshot): void {
    this.count = snap.count & 0xffff;
    this.prescalerRemainder = snap.prescalerRemainder | 0;
  }
}
