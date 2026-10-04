import { describe, expect, test } from "bun:test";
import {
  ADC_VECTOR,
  ADCH,
  ADCL,
  ADATE,
  ADCSRA,
  ADCSRB,
  ADEN,
  ADIE,
  ADIF,
  ADLAR,
  ADMUX,
  ADSC,
  ADTS2,
  AVR,
  CPU,
  Decoder,
  FLASH_WORDS,
  RAMEND,
  TIFR0,
  TOV0,
} from "../src";
import { Adc, attachPeripheral } from "../src/peripherals";

function makeCpu(program: number[] = []): CPU {
  const flash = new Uint16Array(FLASH_WORDS);
  flash.set(program);
  const cpu = new CPU(flash);
  cpu.setExecutor(new Decoder());
  return cpu;
}

describe("ADC", () => {
  test("conversion writes a right-adjusted 10-bit result and sets ADIF", () => {
    const cpu = makeCpu();
    const adc = new Adc(cpu);
    attachPeripheral(cpu, adc);

    adc.setChannelValue(2, 0x02ab);
    cpu.writeData(ADMUX, 2);
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADSC)); // prescaler defaults to /2
    adc.tick(25);
    expect(cpu.readData(ADCSRA) & (1 << ADSC)).toBe(1 << ADSC);

    adc.tick(1);
    expect(cpu.readData(ADCL)).toBe(0xab);
    expect(cpu.readData(ADCH)).toBe(0x02);
    expect(cpu.readData(ADCSRA) & (1 << ADSC)).toBe(0);
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(1 << ADIF);
  });

  test("left-adjusted conversion puts the top 8 bits in ADCH", () => {
    const cpu = makeCpu();
    const adc = new Adc(cpu);
    attachPeripheral(cpu, adc);

    adc.setChannelValue(0, 0x02ab);
    cpu.writeData(ADMUX, 1 << ADLAR);
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADSC));
    adc.tick(26);

    expect(cpu.readData(ADCH)).toBe(0xaa);
    expect(cpu.readData(ADCL)).toBe(0xc0);
  });

  test("ADIF is write-1-to-clear", () => {
    const cpu = makeCpu();
    const adc = new Adc(cpu);
    attachPeripheral(cpu, adc);

    adc.setChannelValue(0, 1);
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADSC));
    adc.tick(26);
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(1 << ADIF);

    cpu.writeData(ADCSRA, cpu.readData(ADCSRA) | (1 << ADIF));
    expect(cpu.readData(ADCSRA) & (1 << ADIF)).toBe(0);
  });

  test("facade analog input drives firmware-visible ADC registers", () => {
    const avr = AVR();

    avr.analog(3).setVoltage(2.5, 5);
    avr.cpu.writeData(ADMUX, 3);
    avr.cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADSC));
    avr.runCycles(26);

    expect(avr.cpu.readData(ADCL) | (avr.cpu.readData(ADCH) << 8)).toBe(512);
    expect(avr.analog(3).read()).toBe(512);
  });

  test("ADC interrupt jumps to the ADC vector and RETI resumes", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.flash[0] = 0x9478; // sei
    cpu.flash[1] = 0x0000; // nop stream until ADC completes
    cpu.flash[ADC_VECTOR] = 0x9518; // reti

    avr.analog(0).setValue(123);
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADIE) | (1 << ADSC));
    avr.runCycles(27);

    expect(cpu.pc).toBe(ADC_VECTOR);
    expect(cpu.sreg.I).toBe(false);
    expect(cpu.SP).toBe(RAMEND - 2);

    avr.step();
    expect(cpu.sreg.I).toBe(true);
    expect(cpu.SP).toBe(RAMEND);
  });

  test("restored auto-trigger state starts conversion from restored register data", () => {
    const source = AVR();
    const cpu = source.cpu;

    source.analog(0).setValue(321);
    cpu.writeData(ADCSRB, 1 << ADTS2); // Timer0 overflow trigger source.
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADATE) | (1 << ADSC));

    const restored = AVR();
    restored.restore(source.snapshot());
    restored.cpu.data[TIFR0] = restored.cpu.data[TIFR0]! | (1 << TOV0);
    restored.runCycles(27);

    expect(restored.cpu.readData(ADCL) | (restored.cpu.readData(ADCH) << 8)).toBe(321);
    expect(restored.cpu.readData(ADCSRA) & (1 << ADIF)).toBe(1 << ADIF);
  });
});
