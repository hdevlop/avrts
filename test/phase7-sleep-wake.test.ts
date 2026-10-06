import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import {
  ADCSRA,
  ADEN,
  ADIF,
  ADIE,
  ADSC,
  ADC_VECTOR,
  AS2,
  ASSR,
  CS00,
  CS20,
  INT0_VECTOR,
  PCICR,
  PCIE0,
  PCINT0_VECTOR,
  PCMSK0,
  SE,
  SM0,
  SMCR,
  TCCR0B,
  TCCR2B,
  TCNT0,
  TCNT2,
  TWAR,
  TWCR,
  TWEA,
  TWEN,
  TWIE,
  TWI_VECTOR,
  TWSR,
  WDT_VECTOR,
  WDTCSR,
  WDIE,
} from "../src/cpu";
import { DEFAULT_TWI_BYTE_CYCLES } from "./helpers";

const MODE_IDLE = 0b000;
const MODE_ADC_NOISE_REDUCTION = 0b001;
const MODE_POWER_DOWN = 0b010;
const MODE_POWER_SAVE = 0b011;
const MODE_STANDBY = 0b110;
const MODE_EXTENDED_STANDBY = 0b111;

function sleepMode(mode: number): number {
  return (1 << SE) | (mode << SM0);
}

describe("Phase 7 sleep and wake fidelity", () => {
  test("idle sleep leaves synchronous timer clocks running", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(TCCR0B, 1 << CS00);
    cpu.writeData(SMCR, sleepMode(MODE_IDLE));
    cpu.sleep();
    avr.runCycles(5);

    expect(cpu.isSleeping).toBe(true);
    expect(cpu.readData(TCNT0)).toBe(5);
  });

  test("power-down sleep gates synchronous timer clocks until wake", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(TCCR0B, 1 << CS00);
    cpu.writeData(SMCR, sleepMode(MODE_POWER_DOWN));
    cpu.sreg.I = true;
    cpu.sleep();
    avr.runCycles(20);
    expect(cpu.readData(TCNT0)).toBe(0);

    cpu.requestInterrupt(INT0_VECTOR);
    cpu.tick();
    expect(cpu.isSleeping).toBe(false);
    expect(cpu.readData(TCNT0)).toBe(8); // Four wake clocks plus four dispatch clocks.
    avr.runCycles(3);
    expect(cpu.readData(TCNT0)).toBe(11);
  });

  test("power-save keeps asynchronous Timer2 running but gates sync Timer2", () => {
    const asyncAvr = AVR().useClock(16_000_000);
    asyncAvr.cpu.writeData(ASSR, 1 << AS2);
    asyncAvr.cpu.writeData(TCCR2B, 1 << CS20);
    asyncAvr.cpu.writeData(SMCR, sleepMode(MODE_POWER_SAVE));
    asyncAvr.cpu.sleep();
    asyncAvr.runCycles(1465); // Two CS transfer edges, then one timer tick.
    expect(asyncAvr.cpu.readData(TCNT2)).toBe(1);

    const syncAvr = AVR();
    syncAvr.cpu.writeData(TCCR2B, 1 << CS20);
    syncAvr.cpu.writeData(SMCR, sleepMode(MODE_POWER_SAVE));
    syncAvr.cpu.sleep();
    syncAvr.runCycles(20);
    expect(syncAvr.cpu.readData(TCNT2)).toBe(0);
  });

  test("ADC noise-reduction sleep starts ADC conversion and gates sync timers", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(TCCR0B, 1 << CS00);
    cpu.writeData(ADCSRA, 1 << ADEN);
    cpu.writeData(SMCR, sleepMode(MODE_ADC_NOISE_REDUCTION));
    cpu.sleep();

    expect((cpu.readData(ADCSRA) >> ADSC) & 1).toBe(1);
    avr.runCycles(50);

    expect(cpu.isSleeping).toBe(true);
    expect(cpu.readData(TCNT0)).toBe(0);
    expect((cpu.readData(ADCSRA) >> ADIF) & 1).toBe(1);
    expect((cpu.readData(ADCSRA) >> ADSC) & 1).toBe(0);
  });

  test("standby gates synchronous timers like power-down", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(TCCR0B, 1 << CS00);
    cpu.writeData(SMCR, sleepMode(MODE_STANDBY));
    cpu.sleep();
    avr.runCycles(20);

    expect(cpu.isSleeping).toBe(true);
    expect(cpu.readData(TCNT0)).toBe(0);
  });

  test("extended standby keeps asynchronous Timer2 running", () => {
    const avr = AVR().useClock(16_000_000);
    const cpu = avr.cpu;

    cpu.writeData(ASSR, 1 << AS2);
    cpu.writeData(TCCR2B, 1 << CS20);
    cpu.writeData(SMCR, sleepMode(MODE_EXTENDED_STANDBY));
    cpu.sleep();
    avr.runCycles(1465); // Two CS transfer edges, then one timer tick.

    expect(cpu.isSleeping).toBe(true);
    expect(cpu.readData(TCNT2)).toBe(1);
  });

  test("snapshot restore reapplies sleep timer gating", () => {
    const source = AVR();
    source.cpu.writeData(TCCR0B, 1 << CS00);
    source.cpu.writeData(SMCR, sleepMode(MODE_POWER_DOWN));
    source.cpu.sreg.I = true;
    source.cpu.sleep();
    source.runCycles(10);
    expect(source.cpu.readData(TCNT0)).toBe(0);

    const restored = AVR().restore(source.snapshot());
    restored.runCycles(10);
    expect(restored.cpu.isSleeping).toBe(true);
    expect(restored.cpu.readData(TCNT0)).toBe(0);

    restored.cpu.requestInterrupt(INT0_VECTOR);
    restored.cpu.tick();
    expect(restored.cpu.readData(TCNT0)).toBe(8);
    restored.runCycles(2);
    expect(restored.cpu.isSleeping).toBe(false);
    expect(restored.cpu.readData(TCNT0)).toBe(10);
  });

  test("pin-change interrupt wakes power-down sleep", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.sreg.I = true;
    cpu.writeData(PCICR, 1 << PCIE0);
    cpu.writeData(PCMSK0, 1 << 0);
    cpu.writeData(SMCR, sleepMode(MODE_POWER_DOWN));
    cpu.sleep();

    avr.pin(8).setInput(true);
    cpu.tick();

    expect(cpu.isSleeping).toBe(false);
    expect(cpu.pc).toBe(PCINT0_VECTOR);
  });

  test("ADC interrupt wakes ADC noise-reduction sleep", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.sreg.I = true;
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADIE));
    cpu.writeData(SMCR, sleepMode(MODE_ADC_NOISE_REDUCTION));
    cpu.sleep();
    avr.runCycles(50);

    expect(cpu.isSleeping).toBe(false);
    expect(cpu.pc).toBe(ADC_VECTOR);
  });

  test("TWI address match wakes power-down sleep", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    const master = avr.twi.master();

    cpu.sreg.I = true;
    cpu.writeData(TWAR, 0x42 << 1);
    cpu.writeData(TWCR, (1 << TWEN) | (1 << TWEA) | (1 << TWIE));
    cpu.writeData(SMCR, sleepMode(MODE_POWER_DOWN));
    cpu.sleep();

    expect(master.start(0x42, false)).toBe(true);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);

    expect(cpu.isSleeping).toBe(false);
    expect(cpu.pc).toBe(TWI_VECTOR);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x60);
  });

  test("watchdog interrupt wakes power-down sleep", () => {
    const avr = AVR().useClock(16_000_000);
    const cpu = avr.cpu;

    cpu.flash[WDT_VECTOR] = 0xcfff;
    cpu.sreg.I = true;
    cpu.writeData(WDTCSR, 1 << WDIE);
    cpu.writeData(SMCR, sleepMode(MODE_POWER_DOWN));
    cpu.sleep();

    avr.runCycles(256_000);

    expect(cpu.isSleeping).toBe(false);
    expect(cpu.pc).toBe(WDT_VECTOR);
    expect((cpu.readData(WDTCSR) >> WDIE) & 1).toBe(1);
  });

  test("sleep wake adds four cycles beyond normal interrupt entry", () => {
    const awake = AVR();
    awake.cpu.sreg.I = true;
    awake.cpu.requestInterrupt(INT0_VECTOR);
    awake.cpu.tick();
    const awakeElapsed = awake.cpu.cycles;

    const sleeping = AVR();
    sleeping.cpu.sreg.I = true;
    sleeping.cpu.writeData(SMCR, sleepMode(MODE_POWER_DOWN));
    sleeping.cpu.sleep();
    sleeping.cpu.requestInterrupt(INT0_VECTOR);
    sleeping.cpu.tick();

    expect(sleeping.cpu.pc).toBe(INT0_VECTOR);
    expect(sleeping.cpu.cycles - awakeElapsed).toBe(4);
  });
});
