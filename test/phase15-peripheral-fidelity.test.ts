import { describe, expect, test } from "bun:test";
import {
  ADATE,
  ADCH,
  ADCL,
  ADCSRA,
  ADCSRB,
  ADEN,
  ADIF,
  ADMUX,
  ADSC,
  ADTS0,
  ADTS1,
  AVR,
  CS00,
  OCF0A,
  OCR0A,
  REFS0,
  REFS1,
  TCCR0A,
  TCCR0B,
  TIFR0,
  WGM01,
} from "../src";

function adcResult(avr: ReturnType<typeof AVR>): number {
  return avr.cpu.readData(ADCL) | (avr.cpu.readData(ADCH) << 8);
}

describe("Phase 15 peripheral fidelity", () => {
  test("ADC ADIF is sticky until firmware writes one to clear it", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    avr.analog(0).setValue(321);
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADSC));
    avr.runCycles(50);
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(1 << ADIF);

    cpu.writeData(ADCSRA, 1 << ADEN);
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(1 << ADIF);

    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADIF));
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(0);
  });

  test("ADC voltage inputs are sampled against the ADMUX reference selection", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    avr.analog(0).setVoltage(1.1);
    cpu.writeData(ADMUX, (1 << REFS1) | (1 << REFS0)); // internal 1.1V reference
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADSC));
    avr.runCycles(50);
    expect(adcResult(avr)).toBe(1023);

    cpu.writeData(ADCSRA, cpu.readData(ADCSRA) | (1 << ADIF));
    cpu.writeData(ADMUX, 1 << REFS0); // AVCC / 5V reference
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADSC));
    avr.runCycles(26);
    expect(adcResult(avr)).toBe(225);
  });

  test("ADC free-running auto-trigger keeps sampling after each conversion", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    avr.analog(0).setValue(111);
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADATE) | (1 << ADSC));
    avr.runCycles(50);
    expect(adcResult(avr)).toBe(111);
    expect(cpu.readData(ADCSRA) & (1 << ADSC)).toBe(1 << ADSC);

    cpu.writeData(ADCSRA, cpu.readData(ADCSRA) | (1 << ADIF));
    avr.analog(0).setValue(222);
    avr.runCycles(26);
    expect(adcResult(avr)).toBe(222);
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(1 << ADIF);
  });

  test("ADC Timer0 compare auto-trigger starts on a fresh OCF0A edge", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    avr.analog(0).setValue(123);
    cpu.writeData(OCR0A, 3);
    cpu.writeData(TCCR0A, 1 << WGM01); // CTC, OCR0A top
    cpu.writeData(ADCSRB, (1 << ADTS1) | (1 << ADTS0)); // Timer0 Compare Match A
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADATE));
    cpu.writeData(TCCR0B, 1 << CS00);

    avr.runCycles(3);
    expect(cpu.readData(TIFR0) & (1 << OCF0A)).toBe(1 << OCF0A);
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(0);

    avr.runCycles(53); // Three synchronization cycles plus the first 25 ADC clocks at /2.
    expect(adcResult(avr)).toBe(123);
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(1 << ADIF);

    cpu.writeData(ADCSRA, cpu.readData(ADCSRA) | (1 << ADIF));
    avr.analog(0).setValue(777);
    avr.runCycles(40);
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(0);
    expect(adcResult(avr)).toBe(123);

    cpu.writeData(TIFR0, 1 << OCF0A);
    avr.runCycles(33); // Next compare edge (3 cycles), then 13.5 ADC clocks at /2 + 3 sync cycles.
    expect(adcResult(avr)).toBe(777);
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(1 << ADIF);
  });
});
