import { OnRead, OnWrite } from "../core";
import {
  ACBG,
  ACD,
  ACI,
  ACIC,
  ACIE,
  ACIS0,
  ACIS1,
  ACO,
  ACSR,
  ACME,
  ADCSRA,
  ADCSRB,
  ADEN,
  ADMUX,
  ANALOG_COMP_VECTOR,
  ICF1,
  TIFR1,
} from "../cpu";
import type { CPU } from "../cpu";
import type { AnalogComparatorSnapshot } from "../snapshot";
import type { Adc } from "./adc";

const BANDGAP_VOLTS = 1.1;

export class AnalogComparator {
  private ain0Volts = 0;
  private ain1Volts = 0;
  private output = false;
  private initialized = false;
  private captureTrigger?: (high: boolean) => void;

  constructor(
    private readonly cpu: CPU,
    private readonly adc: Adc,
  ) {}

  /**
   * Route ACIC-selected output edges into the Timer1 input-capture unit (the
   * runtime wires this to `timer1.comparatorCaptureEdge`, where ICES1 selects
   * the edge). Without a trigger, ACIC falls back to setting ICF1 directly.
   */
  onCaptureTrigger(trigger: (high: boolean) => void): void {
    this.captureTrigger = trigger;
  }

  reset(): void {
    this.output = this.computeOutput();
    this.initialized = true;
    this.syncAco();
  }

  setInput(input: "ain0" | "ain1", volts: number): void {
    const value = Number.isFinite(volts) ? volts : 0;
    if (input === "ain0") this.ain0Volts = value;
    else this.ain1Volts = value;
    this.evaluate();
  }

  readOutput(): boolean {
    this.evaluate();
    return this.output;
  }

  @OnRead(ACSR)
  onReadAcsr(): number {
    this.evaluate();
    return this.cpu.data[ACSR]!;
  }

  @OnWrite(ACSR)
  onWriteAcsr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    const preservedFlag = (oldValue & (1 << ACI)) !== 0 && (value & (1 << ACI)) === 0;
    this.cpu.data[ACSR] = (value & ~((1 << ACO) | (1 << ACI))) | (preservedFlag ? 1 << ACI : 0);
    this.evaluate();
    this.updateInterrupt();
  }

  @OnWrite(ADMUX)
  onWriteAdmux(): void {
    this.evaluate();
  }

  @OnWrite(ADCSRA)
  onWriteAdcsra(): void {
    this.evaluate();
  }

  @OnWrite(ADCSRB)
  onWriteAdcsrb(): void {
    this.evaluate();
  }

  private evaluate(): void {
    const next = this.computeOutput();
    const previous = this.output;
    this.output = next;
    this.syncAco();
    if (!this.initialized) {
      this.initialized = true;
      return;
    }
    if (next === previous || this.disabled()) return;

    // ACIC: every output transition reaches the capture unit; ICES1 (not
    // ACIS) selects the capture edge there.
    if ((this.cpu.data[ACSR]! & (1 << ACIC)) !== 0) {
      if (this.captureTrigger !== undefined) this.captureTrigger(next);
      else this.cpu.setInterruptFlag(TIFR1, 1 << ICF1);
    }

    if (!this.edgeMatches(previous, next)) return;

    this.cpu.setInterruptFlag(ACSR, 1 << ACI);
    this.updateInterrupt();
  }

  private updateInterrupt(): void {
    const acsr = this.cpu.data[ACSR]!;
    if ((acsr & ((1 << ACIE) | (1 << ACI))) === ((1 << ACIE) | (1 << ACI))) {
      this.cpu.requestInterrupt(ANALOG_COMP_VECTOR, () => {
        this.cpu.data[ACSR] = this.cpu.data[ACSR]! & ~(1 << ACI);
      });
    } else {
      this.cpu.clearInterrupt(ANALOG_COMP_VECTOR);
    }
  }

  private computeOutput(): boolean {
    if (this.disabled()) return false;
    return this.positiveInputVolts() > this.negativeInputVolts();
  }

  private positiveInputVolts(): number {
    return (this.cpu.data[ACSR]! & (1 << ACBG)) !== 0 ? BANDGAP_VOLTS : this.ain0Volts;
  }

  private negativeInputVolts(): number {
    const muxEnabled =
      (this.cpu.data[ADCSRB]! & (1 << ACME)) !== 0 &&
      (this.cpu.data[ADCSRA]! & (1 << ADEN)) === 0;
    if (!muxEnabled) return this.ain1Volts;
    return this.adc.readChannelVoltage(this.cpu.data[ADMUX]! & 0x07);
  }

  private disabled(): boolean {
    return (this.cpu.data[ACSR]! & (1 << ACD)) !== 0;
  }

  private edgeMatches(previous: boolean, next: boolean): boolean {
    const mode = this.cpu.data[ACSR]! & ((1 << ACIS1) | (1 << ACIS0));
    if (mode === 0) return true;
    if (mode === (1 << ACIS1)) return previous && !next;
    if (mode === ((1 << ACIS1) | (1 << ACIS0))) return !previous && next;
    return false;
  }

  private syncAco(): void {
    const value = this.cpu.data[ACSR]!;
    this.cpu.data[ACSR] = this.output ? value | (1 << ACO) : value & ~(1 << ACO);
  }

  snapshot(): AnalogComparatorSnapshot {
    return {
      ain0Volts: this.ain0Volts,
      ain1Volts: this.ain1Volts,
      output: this.output,
      initialized: this.initialized,
    };
  }

  restore(snap: AnalogComparatorSnapshot | undefined): void {
    this.ain0Volts = snap?.ain0Volts ?? 0;
    this.ain1Volts = snap?.ain1Volts ?? 0;
    this.output = snap?.output ?? this.computeOutput();
    this.initialized = snap?.initialized ?? true;
    this.syncAco();
  }
}
