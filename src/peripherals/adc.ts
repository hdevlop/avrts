import { OnRead, OnWrite } from "../core";
import {
  ACI,
  ACSR,
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
  DIDR0,
  EIFR,
  ICF1,
  INTF0,
  OCF0A,
  OCF1B,
  REFS0,
  REFS1,
  SM0,
  SM1,
  SM2,
  SMCR,
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
const FIRST_CONVERSION_ADC_CLOCKS = 25;
const ADC_CHANNEL_COUNT = 16;
const TEMPERATURE_CHANNEL = 8;
const BANDGAP_CHANNEL = 14;
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
  private readonly channels = new Uint16Array(ADC_CHANNEL_COUNT);
  private readonly channelVoltages = new Float64Array(ADC_CHANNEL_COUNT);
  private readonly voltageEnabled = new Uint8Array(ADC_CHANNEL_COUNT);
  private readonly channelListeners = new Set<(channel: number) => void>();
  private remainingCycles = 0;
  private converting = false;
  private firstConversion = true;
  private conversionMux = 0;
  private resultLocked = false;
  private sampleRemainingCycles = 0;
  private sampledResult: number | null = null;
  private triggerSource = -1;
  private triggerWasHigh = false;
  private autoTriggerArmed = false;
  private powerReduced = false;
  private sleepPaused = false;
  private readonly onSampleEvent = (): void => {
    this.sampleRemainingCycles = 0;
    this.sampledResult = this.sampleSelectedChannel();
  };
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

  constructor(private readonly cpu: CPU) {
    this.channelVoltages[BANDGAP_CHANNEL] = DEFAULT_INTERNAL_REFERENCE_VOLTS;
    this.voltageEnabled[BANDGAP_CHANNEL] = 1;
    this.cpu.onSleep(() => this.onSleep());
    const triggers = [
      [ACSR, ACI, AdcTriggerSource.AnalogComparator],
      [EIFR, INTF0, AdcTriggerSource.ExternalInterrupt0],
      [TIFR0, OCF0A, AdcTriggerSource.Timer0CompareA],
      [TIFR0, TOV0, AdcTriggerSource.Timer0Overflow],
      [TIFR1, OCF1B, AdcTriggerSource.Timer1CompareB],
      [TIFR1, TOV1, AdcTriggerSource.Timer1Overflow],
      [TIFR1, ICF1, AdcTriggerSource.Timer1Capture],
    ] as const;
    for (const [address, flag, source] of triggers) {
      this.cpu.onInterruptFlag(address, (raised) => {
        if ((raised & (1 << flag)) === 0 || this.selectedTriggerSource() !== source) return;
        this.triggerSource = source;
        this.triggerWasHigh = true;
        if (this.autoTriggerArmed && !this.clockPaused()) this.startConversion(true);
      });
    }
  }

  reset(): void {
    this.powerReduced = false;
    this.sleepPaused = false;
    this.remainingCycles = 0;
    this.converting = false;
    this.firstConversion = true;
    this.conversionMux = 0;
    this.resultLocked = false;
    this.sampleRemainingCycles = 0;
    this.sampledResult = null;
    this.triggerSource = -1;
    this.triggerWasHigh = false;
    this.refreshAutoTriggerArmed();
    this.scheduleEvents();
  }

  tick(cycles: number): void {
    if (this.clockPaused()) return;
    if (this.converting) {
      if (this.sampledResult === null) {
        this.sampleRemainingCycles -= cycles;
        if (this.sampleRemainingCycles <= 0) this.onSampleEvent();
      }
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
    for (const listener of this.channelListeners) listener(normalized);
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
    for (const listener of this.channelListeners) listener(normalized);
  }

  /** Notify analog consumers after a host changes a channel's input level. */
  onChannelChange(listener: (channel: number) => void): () => void {
    this.channelListeners.add(listener);
    return () => { this.channelListeners.delete(listener); };
  }

  readChannelVoltage(channel: number): number {
    const normalized = this.normalizeChannel(channel);
    if (this.voltageEnabled[normalized] !== 0) return this.channelVoltages[normalized]!;
    return (this.channels[normalized]! / 1023) * DEFAULT_AVCC_REFERENCE_VOLTS;
  }

  setPowerReduced(reduced: boolean): void {
    this.refreshRemainingCycles();
    this.powerReduced = reduced;
    this.scheduleEvents();
  }

  setSleepPaused(paused: boolean): void {
    this.refreshRemainingCycles();
    this.sleepPaused = paused;
    this.scheduleEvents();
  }

  private clockPaused(): boolean {
    return this.powerReduced || this.sleepPaused;
  }

  @OnWrite(ADCSRA)
  onWriteAdcsra(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.refreshRemainingCycles();
    let next = (value & ~(1 << ADIF)) | (oldValue & (1 << ADIF));
    if ((value & (1 << ADIF)) !== 0) {
      next &= ~(1 << ADIF);
    }
    if ((value & (1 << ADEN)) === 0) {
      this.converting = false;
      this.remainingCycles = 0;
      this.sampleRemainingCycles = 0;
      this.sampledResult = null;
      this.firstConversion = true;
      next &= ~(1 << ADSC);
    } else {
      // ADSC is hardware-cleared: writing zero cannot clear an active start.
      next |= oldValue & (1 << ADSC);
    }
    this.cpu.data[ADCSRA] = next;
    this.refreshAutoTriggerArmed();
    if ((value & (1 << ADSC)) !== 0) this.startConversion();
    this.pollAutoTrigger();
    this.updateInterrupt();
    this.scheduleEvents();
  }

  @OnWrite(ADCSRB)
  onWriteAdcsrb(): void {
    this.cpu.data[ADCSRB] = this.cpu.data[ADCSRB]! & 0x47;
    this.refreshRemainingCycles();
    this.refreshAutoTriggerArmed();
    this.resyncTriggerLatch();
    this.pollAutoTrigger();
    this.scheduleEvents();
  }

  @OnWrite(ADMUX)
  onWriteAdmux(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.cpu.data[ADMUX] = value & 0xef;
    if (((value ^ oldValue) & (1 << ADLAR)) !== 0) {
      const result = (oldValue & (1 << ADLAR)) !== 0
        ? (this.cpu.data[ADCH]! << 2) | (this.cpu.data[ADCL]! >> 6)
        : this.cpu.data[ADCL]! | (this.cpu.data[ADCH]! << 8);
      this.writeResult(result);
    }
    this.resyncTriggerLatch();
  }

  @OnWrite(DIDR0)
  onWriteDidr0(): void {
    this.cpu.data[DIDR0] = this.cpu.data[DIDR0]! & 0x3f;
  }

  @OnRead(ADCL)
  onReadAdcl(): number {
    this.resultLocked = true;
    return this.cpu.data[ADCL]!;
  }

  @OnRead(ADCH)
  onReadAdch(): number {
    this.resultLocked = false;
    return this.cpu.data[ADCH]!;
  }

  @OnWrite(ADCL)
  @OnWrite(ADCH)
  onWriteAdcResult(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    this.cpu.data[addr] = oldValue; // Conversion results are read-only.
  }

  private startConversion(autoTriggered = false): void {
    if (this.converting) return;
    if ((this.cpu.data[ADCSRA]! & (1 << ADEN)) === 0) {
      this.cpu.data[ADCSRA] = this.cpu.data[ADCSRA]! & ~(1 << ADSC);
      this.converting = false;
      this.remainingCycles = 0;
      this.refreshAutoTriggerArmed();
      this.scheduleEvents();
      return;
    }
    this.converting = true;
    this.conversionMux = this.cpu.data[ADMUX]!;
    this.cpu.data[ADCSRA] = this.cpu.data[ADCSRA]! | (1 << ADSC);
    this.refreshAutoTriggerArmed();
    const adcClocks = this.firstConversion ? FIRST_CONVERSION_ADC_CLOCKS : autoTriggered ? 13.5 : CONVERSION_ADC_CLOCKS;
    const sampleClocks = this.firstConversion ? 13.5 : autoTriggered ? 2 : 1.5;
    const synchronizationCycles = autoTriggered ? 3 : 0;
    this.sampleRemainingCycles = sampleClocks * this.prescaler() + synchronizationCycles;
    this.sampledResult = null;
    this.firstConversion = false;
    this.remainingCycles = adcClocks * this.prescaler() + synchronizationCycles;
    this.scheduleEvents();
  }

  private completeConversion(): void {
    this.converting = false;
    this.remainingCycles = 0;
    const result = this.sampledResult ?? this.sampleSelectedChannel();
    this.sampleRemainingCycles = 0;
    this.sampledResult = null;
    // An ADCL read locks both bytes; a conversion completed while locked is lost.
    if (!this.resultLocked) this.writeResult(result);
    const keepArmed = this.autoTriggerArmed && this.selectedTriggerSource() === AdcTriggerSource.FreeRunning;
    this.cpu.data[ADCSRA] =
      (this.cpu.data[ADCSRA]! & (keepArmed ? 0xff : ~(1 << ADSC))) | (1 << ADIF);
    this.refreshAutoTriggerArmed();
    // Edges that occurred while busy must not start a second conversion.
    this.resyncTriggerLatch();
    this.updateInterrupt();
    if (this.autoTriggerArmed && this.selectedTriggerSource() === AdcTriggerSource.FreeRunning) {
      this.startConversion();
    }
  }

  private writeResult(result: number): void {
    if ((this.cpu.data[ADMUX]! & (1 << ADLAR)) !== 0) {
      this.cpu.data[ADCL] = (result & 0x03) << 6;
      this.cpu.data[ADCH] = result >> 2;
    } else {
      this.cpu.data[ADCL] = result & 0xff;
      this.cpu.data[ADCH] = result >> 8;
    }
  }

  private updateInterrupt(): void {
    const control = this.cpu.data[ADCSRA]!;
    if ((control & ((1 << ADIE) | (1 << ADIF))) === ((1 << ADIE) | (1 << ADIF))) {
      this.cpu.requestInterrupt(ADC_VECTOR, () => {
        this.cpu.data[ADCSRA] = this.cpu.data[ADCSRA]! & ~(1 << ADIF);
      });
    } else {
      this.cpu.clearInterrupt(ADC_VECTOR);
    }
  }

  private selectedChannel(): number {
    return this.conversionMux & 0x0f;
  }

  private sampleSelectedChannel(): number {
    const channel = this.selectedChannel();
    if (!this.isSupportedChannel(channel)) return 0;
    if (this.voltageEnabled[channel] === 0) return this.channels[channel]!;
    return clamp10((this.channelVoltages[channel]! / this.referenceVoltage()) * 1023);
  }

  private referenceVoltage(): number {
    const refs = (this.conversionMux >> REFS0) & ((1 << (REFS1 - REFS0 + 1)) - 1);
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
      (control & (1 << ADEN)) !== 0 && (control & (1 << ADATE)) !== 0 &&
      (this.selectedTriggerSource() !== AdcTriggerSource.FreeRunning || (control & (1 << ADSC)) !== 0);
  }

  private selectedTriggerSource(): AdcTriggerSource {
    return (this.cpu.data[ADCSRB]! & ((1 << ADTS2) | (1 << ADTS1) | (1 << ADTS0))) as AdcTriggerSource;
  }

  private pollAutoTrigger(): void {
    if (!this.autoTriggerArmed || this.converting || this.clockPaused()) {
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
    if (high && !this.triggerWasHigh) this.startConversion(true);
    this.triggerWasHigh = high;
  }

  private scheduleEvents(): void {
    if (this.clockPaused()) {
      this.cpu.clearClockEvent(this.onConversionEvent);
      this.cpu.clearClockEvent(this.onSampleEvent);
      this.cpu.clearClockEvent(this.onAutoTriggerEvent);
      return;
    }
    if (this.converting) {
      this.cpu.addClockEvent(this.onConversionEvent, this.remainingCycles);
      if (this.sampledResult === null) {
        this.cpu.addClockEvent(this.onSampleEvent, this.sampleRemainingCycles);
      } else {
        this.cpu.clearClockEvent(this.onSampleEvent);
      }
      this.cpu.clearClockEvent(this.onAutoTriggerEvent);
      return;
    }
    this.cpu.clearClockEvent(this.onConversionEvent);
    this.cpu.clearClockEvent(this.onSampleEvent);
    if (this.autoTriggerArmed) {
      this.cpu.addClockEvent(this.onAutoTriggerEvent, 1);
    } else {
      this.cpu.clearClockEvent(this.onAutoTriggerEvent);
    }
  }

  private refreshRemainingCycles(): void {
    if (!this.converting || this.clockPaused()) return;
    this.remainingCycles = this.cpu.clockEventRemainingCycles(this.onConversionEvent);
    if (this.sampledResult === null) {
      this.sampleRemainingCycles = this.cpu.clockEventRemainingCycles(this.onSampleEvent);
    }
  }

  private onSleep(): void {
    if (!this.startsConversionOnSleep()) return;
    if (this.converting || this.clockPaused()) return;
    this.startConversion();
  }

  private startsConversionOnSleep(): boolean {
    const mode = (this.cpu.data[SMCR]! >> SM0) & ((1 << (SM2 - SM0 + 1)) - 1);
    return mode === 0b000 || mode === 0b001;
  }

  private resyncTriggerLatch(): void {
    const source = this.selectedTriggerSource();
    this.triggerSource = source;
    this.triggerWasHigh = this.triggerLevel(source);
  }

  private triggerLevel(source: AdcTriggerSource): boolean {
    switch (source) {
      case AdcTriggerSource.AnalogComparator:
        return (this.cpu.data[ACSR]! & (1 << ACI)) !== 0;
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
    if (!this.isSupportedChannel(channel)) {
      throw new Error(`Unknown ADC channel ${channel} (valid channels: 0..8 and 14)`);
    }
    return channel;
  }

  private isSupportedChannel(channel: number): boolean {
    return Number.isInteger(channel) && ((channel >= 0 && channel <= TEMPERATURE_CHANNEL) || channel === BANDGAP_CHANNEL);
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
      firstConversion: this.firstConversion,
      conversionMux: this.conversionMux,
      resultLocked: this.resultLocked,
      sampleRemainingCycles: this.sampleRemainingCycles,
      sampledResult: this.sampledResult,
      triggerSource: this.triggerSource,
      triggerWasHigh: this.triggerWasHigh,
    };
  }

  restore(snap: AdcSnapshot): void {
    this.powerReduced = false;
    this.sleepPaused = false;
    this.channels.set(snap.channels);
    this.channelVoltages.set(snap.channelVoltages);
    this.voltageEnabled.set(snap.voltageEnabled);
    this.remainingCycles = snap.remainingCycles;
    this.converting = snap.converting;
    this.firstConversion = snap.firstConversion ?? ((this.cpu.data[ADCSRA]! & (1 << ADEN)) === 0);
    this.conversionMux = snap.conversionMux ?? this.cpu.data[ADMUX]!;
    this.resultLocked = snap.resultLocked ?? false;
    // Older snapshots have no held input: recover the sampling deadline from
    // the conversion's remaining time, sampling now if it has already passed.
    this.sampleRemainingCycles = snap.sampleRemainingCycles ?? Math.max(0, snap.remainingCycles - 11.5 * this.prescaler());
    this.sampledResult = snap.sampledResult ?? null;
    if (this.converting && this.sampledResult === null && this.sampleRemainingCycles === 0) this.onSampleEvent();
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
