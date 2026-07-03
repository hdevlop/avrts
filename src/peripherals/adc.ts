import { OnWrite } from "../core";
import {
  ADC_VECTOR,
  ADCH,
  ADCL,
  ADATE,
  ADCSRA,
  ADCSRB,
  ADEN,
  ADIF,
  ADIE,
  ADLAR,
  ADMUX,
  ADPS0,
  ADPS1,
  ADPS2,
  ADSC,
  ADTS0,
  ADTS1,
  ADTS2,
  EIFR,
  ICF1,
  INTF0,
  OCF0A,
  OCF1B,
  REFS0,
  REFS1,
  TIFR0,
  TIFR1,
  TOV0,
  TOV1,
} from "../cpu";
import type { CPU } from "../cpu";
import type { AdcSnapshot } from "../snapshot";

const ADC_PRESCALER: Readonly<Record<number, number>> = {
  0b000: 2,
  0b001: 2,
  0b010: 4,
  0b011: 8,
  0b100: 16,
  0b101: 32,
  0b110: 64,
  0b111: 128,
};

const CONVERSION_ADC_CLOCKS = 13;
const DEFAULT_EXTERNAL_REFERENCE_VOLTS = 5;
const DEFAULT_AVCC_REFERENCE_VOLTS = 5;
const DEFAULT_INTERNAL_REFERENCE_VOLTS = 1.1;

const enum AdcTriggerSource {
  FreeRunning = 0,
  AnalogComparator = 1,
  ExternalInterrupt0 = 2,
  Timer0CompareA = 3,
  Timer0Overflow = 4,
  Timer1CompareB = 5,
  Timer1Overflow = 6,
  Timer1Capture = 7,
}

/**
 * Minimal ADC model for analogRead-style firmware. The UI/test code supplies a
 * 10-bit value per channel; firmware starts a conversion through ADCSRA.ADSC.
 */
export class Adc {
  private readonly channels = new Uint16Array(8);
  private readonly channelVoltages = new Float64Array(8);
  private readonly voltageEnabled = new Uint8Array(8);
  private remainingCycles = 0;
  private converting = false;
  private triggerSource = -1;
  private triggerWasHigh = false;
  private autoTriggerArmed = false;
  private readonly onConversionEvent = (): void => {
    if (!this.converting) {
      this.scheduleEvents();
      return;
    }
    this.remainingCycles = 0;
    this.completeConversion();
    this.scheduleEvents();
  };
  private readonly onAutoTriggerEvent = (): void => {
    this.pollAutoTrigger();
    this.scheduleEvents();
  };

  constructor(private readonly cpu: CPU) {}

  reset(): void {
    this.remainingCycles = 0;
    this.converting = false;
    this.triggerSource = -1;
    this.triggerWasHigh = false;
    this.refreshAutoTriggerArmed();
    this.scheduleEvents();
  }

  tick(cycles: number): void {
    if (this.converting) {
      this.remainingCycles -= cycles;
      if (this.remainingCycles <= 0) {
        this.completeConversion();
        this.scheduleEvents();
      } else {
        if (this.autoTriggerArmed) this.resyncTriggerLatch();
        this.scheduleEvents();
        return;
      }
    }
    if (this.autoTriggerArmed) this.pollAutoTrigger();
    this.scheduleEvents();
  }

  setChannelValue(channel: number, value: number): void {
    const normalized = this.normalizeChannel(channel);
    this.channels[normalized] = clamp10(value);
    this.voltageEnabled[normalized] = 0;
  }

  readChannelValue(channel: number): number {
    const normalized = this.normalizeChannel(channel);
    if (this.voltageEnabled[normalized] === 0) return this.channels[normalized]!;
    return clamp10((this.channelVoltages[normalized]! / DEFAULT_AVCC_REFERENCE_VOLTS) * 1023);
  }

  setChannelVoltage(channel: number, volts: number, referenceVolts = 5): void {
    const normalized = this.normalizeChannel(channel);
    const ratio = referenceVolts <= 0 ? 0 : volts / referenceVolts;
    this.channelVoltages[normalized] = Number.isFinite(volts) ? Math.max(0, volts) : 0;
    this.voltageEnabled[normalized] = 1;
    this.channels[normalized] = clamp10(Math.round(ratio * 1023));
  }

  @OnWrite(ADCSRA)
  onWriteAdcsra(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    let next = (value & ~(1 << ADIF)) | (oldValue & (1 << ADIF));
    if ((value & (1 << ADIF)) !== 0) {
      next &= ~(1 << ADIF);
      if (this.converting || (value & (1 << ADSC)) !== 0) next |= 1 << ADSC;
    }
    this.cpu.data[ADCSRA] = next;
    this.refreshAutoTriggerArmed();
    if ((value & (1 << ADSC)) !== 0) this.handleStartRequest();
    this.pollAutoTrigger();
    this.scheduleEvents();
  }

  @OnWrite(ADCSRB)
  onWriteAdcsrb(): void {
    this.resyncTriggerLatch();
    this.pollAutoTrigger();
    this.scheduleEvents();
  }

  @OnWrite(ADMUX)
  onWriteAdmux(): void {
    this.resyncTriggerLatch();
  }

  private handleStartRequest(): void {
    if (!this.autoTriggerArmed || this.selectedTriggerSource() === AdcTriggerSource.FreeRunning) {
      this.startConversion();
    } else {
      this.resyncTriggerLatch();
    }
  }

  private startConversion(): void {
    if ((this.cpu.data[ADCSRA]! & (1 << ADEN)) === 0) {
      this.cpu.data[ADCSRA] = this.cpu.data[ADCSRA]! & ~(1 << ADSC);
      this.converting = false;
      this.remainingCycles = 0;
      this.refreshAutoTriggerArmed();
      this.scheduleEvents();
      return;
    }
    this.converting = true;
    this.cpu.data[ADCSRA] = this.cpu.data[ADCSRA]! | (1 << ADSC);
    this.refreshAutoTriggerArmed();
    this.remainingCycles = CONVERSION_ADC_CLOCKS * this.prescaler();
    this.scheduleEvents();
  }

  private completeConversion(): void {
    this.converting = false;
    this.remainingCycles = 0;
    const result = this.sampleSelectedChannel();
    if ((this.cpu.data[ADMUX]! & (1 << ADLAR)) !== 0) {
      this.cpu.data[ADCL] = (result & 0x03) << 6;
      this.cpu.data[ADCH] = result >> 2;
    } else {
      this.cpu.data[ADCL] = result & 0xff;
      this.cpu.data[ADCH] = result >> 8;
    }
    const keepArmed = this.autoTriggerArmed;
    this.cpu.data[ADCSRA] =
      (this.cpu.data[ADCSRA]! & (keepArmed ? 0xff : ~(1 << ADSC))) | (1 << ADIF);
    this.refreshAutoTriggerArmed();
    if ((this.cpu.data[ADCSRA]! & (1 << ADIE)) !== 0) {
      this.cpu.requestInterrupt(ADC_VECTOR, () => {
        this.cpu.data[ADCSRA] = this.cpu.readData(ADCSRA) & ~(1 << ADIF);
      });
    }
    if (this.autoTriggerArmed && this.selectedTriggerSource() === AdcTriggerSource.FreeRunning) {
      this.startConversion();
    }
  }

  private selectedChannel(): number {
    return this.normalizeChannel(this.cpu.data[ADMUX]! & 0x0f);
  }

  private sampleSelectedChannel(): number {
    const channel = this.selectedChannel();
    if (this.voltageEnabled[channel] === 0) return this.channels[channel]!;
    return clamp10((this.channelVoltages[channel]! / this.referenceVoltage()) * 1023);
  }

  private referenceVoltage(): number {
    const refs = (this.cpu.data[ADMUX]! >> REFS0) & ((1 << (REFS1 - REFS0 + 1)) - 1);
    if (refs === 0b11) return DEFAULT_INTERNAL_REFERENCE_VOLTS;
    if (refs === 0b01) return DEFAULT_AVCC_REFERENCE_VOLTS;
    return DEFAULT_EXTERNAL_REFERENCE_VOLTS;
  }

  private prescaler(): number {
    const bits = this.cpu.data[ADCSRA]! & ((1 << ADPS2) | (1 << ADPS1) | (1 << ADPS0));
    return ADC_PRESCALER[bits] ?? 2;
  }

  private refreshAutoTriggerArmed(): void {
    const control = this.cpu.data[ADCSRA]!;
    this.autoTriggerArmed =
      (control & (1 << ADEN)) !== 0 && (control & (1 << ADATE)) !== 0 && (control & (1 << ADSC)) !== 0;
  }

  private selectedTriggerSource(): AdcTriggerSource {
    return (this.cpu.data[ADCSRB]! & ((1 << ADTS2) | (1 << ADTS1) | (1 << ADTS0))) as AdcTriggerSource;
  }

  private pollAutoTrigger(): void {
    if (!this.autoTriggerArmed || this.converting) {
      this.resyncTriggerLatch();
      return;
    }

    const source = this.selectedTriggerSource();
    if (source === AdcTriggerSource.FreeRunning) {
      this.startConversion();
      return;
    }

    const high = this.triggerLevel(source);
    if (this.triggerSource !== source) {
      this.triggerSource = source;
      this.triggerWasHigh = high;
      return;
    }
    if (high && !this.triggerWasHigh) this.startConversion();
    this.triggerWasHigh = high;
  }

  private scheduleEvents(): void {
    if (this.converting) {
      this.cpu.addClockEvent(this.onConversionEvent, this.remainingCycles);
      this.cpu.clearClockEvent(this.onAutoTriggerEvent);
      return;
    }
    this.cpu.clearClockEvent(this.onConversionEvent);
    if (this.autoTriggerArmed) {
      this.cpu.addClockEvent(this.onAutoTriggerEvent, 1);
    } else {
      this.cpu.clearClockEvent(this.onAutoTriggerEvent);
    }
  }

  private refreshRemainingCycles(): void {
    if (!this.converting) return;
    this.remainingCycles = this.cpu.clockEventRemainingCycles(this.onConversionEvent);
  }

  private resyncTriggerLatch(): void {
    const source = this.selectedTriggerSource();
    this.triggerSource = source;
    this.triggerWasHigh = this.triggerLevel(source);
  }

  private triggerLevel(source: AdcTriggerSource): boolean {
    switch (source) {
      case AdcTriggerSource.ExternalInterrupt0:
        return (this.cpu.data[EIFR]! & (1 << INTF0)) !== 0;
      case AdcTriggerSource.Timer0CompareA:
        return (this.cpu.data[TIFR0]! & (1 << OCF0A)) !== 0;
      case AdcTriggerSource.Timer0Overflow:
        return (this.cpu.data[TIFR0]! & (1 << TOV0)) !== 0;
      case AdcTriggerSource.Timer1CompareB:
        return (this.cpu.data[TIFR1]! & (1 << OCF1B)) !== 0;
      case AdcTriggerSource.Timer1Overflow:
        return (this.cpu.data[TIFR1]! & (1 << TOV1)) !== 0;
      case AdcTriggerSource.Timer1Capture:
        return (this.cpu.data[TIFR1]! & (1 << ICF1)) !== 0;
      default:
        return false;
    }
  }

  private normalizeChannel(channel: number): number {
    if (!Number.isInteger(channel) || channel < 0 || channel > 7) {
      throw new Error(`Unknown ADC channel ${channel} (valid channels: 0..7)`);
    }
    return channel;
  }

  // --- Snapshot / restore (Phase 10) ---

  snapshot(): AdcSnapshot {
    this.refreshRemainingCycles();
    return {
      channels: new Uint16Array(this.channels),
      channelVoltages: new Float64Array(this.channelVoltages),
      voltageEnabled: new Uint8Array(this.voltageEnabled),
      remainingCycles: this.remainingCycles,
      converting: this.converting,
      triggerSource: this.triggerSource,
      triggerWasHigh: this.triggerWasHigh,
    };
  }

  restore(snap: AdcSnapshot): void {
    this.channels.set(snap.channels);
    this.channelVoltages.set(snap.channelVoltages);
    this.voltageEnabled.set(snap.voltageEnabled);
    this.remainingCycles = snap.remainingCycles;
    this.converting = snap.converting;
    this.triggerSource = snap.triggerSource;
    this.triggerWasHigh = snap.triggerWasHigh;
    this.refreshAutoTriggerArmed();
    this.scheduleEvents();
  }
}

function clamp10(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1023, Math.round(value)));
}
