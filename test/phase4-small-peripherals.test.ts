import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import {
  ACI,
  ACIC,
  ACIE,
  ACIS0,
  ACIS1,
  ACO,
  ACSR,
  ACME,
  ADCH,
  ADCL,
  ADCSRA,
  ADCSRB,
  ADEN,
  ADIF,
  ADMUX,
  ADSC,
  ANALOG_COMP_VECTOR,
  CLKPR,
  CLKPCE,
  CS00,
  DDRB,
  EXTRF,
  ICES1,
  ICF1,
  MSTR,
  MCUSR,
  PORF,
  PRADC,
  PRR,
  PRSPI,
  PRTIM0,
  PRTWI,
  PRUSART0,
  REFS0,
  SE,
  SM0,
  SMCR,
  SPCR,
  SPDR,
  SPE,
  SPIF,
  SPSR,
  TCCR0B,
  TCCR1B,
  TCNT0,
  TIFR1,
  TWCR,
  TWEN,
  TWINT,
  TWSTA,
  TWSR,
  TXEN0,
  UCSR0B,
  UDR0,
  WDE,
  WDRF,
  WDTCSR,
} from "../src/cpu";
import { DEFAULT_SPI_TRANSFER_CYCLES, DEFAULT_USART_FRAME_CYCLES } from "./helpers";

function readAdcResult(avr: ReturnType<typeof AVR>): number {
  return avr.cpu.readData(ADCL) | (avr.cpu.readData(ADCH) << 8);
}

describe("Phase 4 small peripherals", () => {
  test("CLKPR uses the CLKPCE protocol and updates effective runtime clock", () => {
    const avr = AVR().useClock(16_000_000);
    const cpu = avr.cpu;

    cpu.writeData(CLKPR, 3);
    expect(cpu.readData(CLKPR) & 0x0f).toBe(0);
    expect(avr.status().clockHz).toBe(16_000_000);

    cpu.writeData(CLKPR, 1 << CLKPCE);
    cpu.writeData(CLKPR, 3);
    expect(cpu.readData(CLKPR)).toBe(3);
    expect(avr.status().clockHz).toBe(2_000_000);

    avr.runFor(1);
    expect(cpu.cycles).toBe(2_000);
  });

  test("CLKPR unlock expires after four cycles", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(CLKPR, 1 << CLKPCE);
    avr.runCycles(4);
    expect((cpu.readData(CLKPR) >> CLKPCE) & 1).toBe(0);

    cpu.writeData(CLKPR, 1);
    expect(cpu.readData(CLKPR) & 0x0f).toBe(0);
  });

  test("CLKPR unlock expiry preserves the previous divider", () => {
    const avr = AVR().useClock(16_000_000);
    const cpu = avr.cpu;

    cpu.writeData(CLKPR, 1 << CLKPCE);
    cpu.writeData(CLKPR, 3);
    expect(avr.status().clockHz).toBe(2_000_000);

    cpu.writeData(CLKPR, 1 << CLKPCE);
    avr.runCycles(4);

    expect(cpu.readData(CLKPR) & 0x0f).toBe(3);
    expect(avr.status().clockHz).toBe(2_000_000);
  });

  test("MCUSR reset-source flags cover power-on, external reset, and watchdog reset", () => {
    const powerOn = AVR();
    expect((powerOn.cpu.readData(MCUSR) >> PORF) & 1).toBe(1);

    powerOn.resetExternal();
    expect((powerOn.cpu.readData(MCUSR) >> EXTRF) & 1).toBe(1);
    expect((powerOn.cpu.readData(MCUSR) >> PORF) & 1).toBe(1);

    const watchdog = AVR();
    watchdog.cpu.flash[0] = 0xcfff; // rjmp .-0, keep firmware alive until WDT expires.
    watchdog.cpu.writeData(WDTCSR, 1 << WDE);
    watchdog.runCycles(256_000);
    expect((watchdog.cpu.readData(MCUSR) >> WDRF) & 1).toBe(1);
  });

  test("ADC supports temperature and bandgap internal channels", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    avr.analog(8).setValue(456);
    cpu.writeData(ADMUX, 8);
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADSC));
    avr.runCycles(50);
    expect(readAdcResult(avr)).toBe(456);

    cpu.writeData(ADMUX, (1 << REFS0) | 14);
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADSC));
    avr.runCycles(26);
    expect(readAdcResult(avr)).toBe(Math.round((1.1 / 5) * 1023));
  });

  test("PRR gates Timer0 counting until power is restored", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(TCCR0B, 1 << CS00);
    avr.runCycles(10);
    expect(cpu.readData(TCNT0)).toBe(10);

    cpu.writeData(PRR, 1 << PRTIM0);
    avr.runCycles(40);
    expect(cpu.readData(TCNT0)).toBe(10);

    cpu.writeData(PRR, 0);
    avr.runCycles(5);
    expect(cpu.readData(TCNT0)).toBe(15);
  });

  test("PRR pauses scheduled USART, SPI, and TWI operations", () => {
    const serial = AVR();
    const serialBytes: number[] = [];
    serial.serial.onByte((byte) => serialBytes.push(byte));
    serial.cpu.writeData(UCSR0B, 1 << TXEN0);
    serial.cpu.writeData(UDR0, 0x51);
    serial.runCycles(10);
    serial.cpu.writeData(PRR, 1 << PRUSART0);
    serial.runCycles(DEFAULT_USART_FRAME_CYCLES);
    expect(serialBytes).toEqual([]);
    serial.cpu.writeData(PRR, 0);
    serial.runCycles(DEFAULT_USART_FRAME_CYCLES - 10);
    expect(serialBytes).toEqual([0x51]);

    const spi = AVR();
    spi.cpu.writeData(DDRB, 1 << 2);
    spi.cpu.writeData(SPCR, (1 << SPE) | (1 << MSTR));
    spi.cpu.writeData(SPDR, 0x33);
    spi.runCycles(10);
    spi.cpu.writeData(PRR, 1 << PRSPI);
    spi.runCycles(DEFAULT_SPI_TRANSFER_CYCLES);
    expect((spi.cpu.data[SPSR]! >> SPIF) & 1).toBe(0);
    spi.cpu.writeData(PRR, 0);
    spi.runCycles(DEFAULT_SPI_TRANSFER_CYCLES - 10);
    expect((spi.cpu.data[SPSR]! >> SPIF) & 1).toBe(1);

    const twi = AVR();
    twi.cpu.writeData(TWCR, (1 << TWEN) | (1 << TWINT) | (1 << TWSTA));
    twi.cpu.writeData(PRR, 1 << PRTWI);
    twi.runCycles(5);
    expect((twi.cpu.readData(TWCR) >> TWINT) & 1).toBe(0);
    twi.cpu.writeData(PRR, 0);
    twi.runCycles(1);
    expect((twi.cpu.readData(TWCR) >> TWINT) & 1).toBe(1);
    expect(twi.cpu.readData(TWSR) & 0xf8).toBe(0x08);
  });

  test("PRR pauses an in-flight ADC conversion", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    avr.analog(0).setValue(321);
    cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADSC));
    avr.runCycles(10);
    cpu.writeData(PRR, 1 << PRADC);
    avr.runCycles(100);
    expect((cpu.readData(ADCSRA) >> ADIF) & 1).toBe(0);

    cpu.writeData(PRR, 0);
    avr.runCycles(39); // 40 of the first conversion's 50 cycles remain.
    expect((cpu.readData(ADCSRA) >> ADIF) & 1).toBe(0);
    avr.runCycles(1);
    expect((cpu.readData(ADCSRA) >> ADIF) & 1).toBe(1);
    expect(readAdcResult(avr)).toBe(321);
  });

  test("PRR-frozen peripheral state survives snapshot restore", () => {
    const source = AVR();
    const cpu = source.cpu;

    cpu.writeData(TCCR0B, 1 << CS00);
    source.runCycles(12);
    cpu.writeData(PRR, 1 << PRTIM0);
    source.runCycles(50);
    expect(cpu.readData(TCNT0)).toBe(12);

    const restored = AVR();
    restored.restore(source.snapshot());
    restored.runCycles(50);
    expect(restored.cpu.readData(TCNT0)).toBe(12);

    restored.cpu.writeData(PRR, 0);
    restored.runCycles(3);
    expect(restored.cpu.readData(TCNT0)).toBe(15);
  });

  test("ADC noise-reduction sleep starts a conversion on sleep entry", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    avr.analog(0).setValue(654);
    cpu.writeData(ADCSRA, 1 << ADEN);
    cpu.writeData(SMCR, (1 << SE) | (1 << SM0));
    cpu.sleep();

    expect((cpu.readData(ADCSRA) >> ADSC) & 1).toBe(1);
    avr.runCycles(49);
    expect((cpu.readData(ADCSRA) >> ADIF) & 1).toBe(0);
    avr.runCycles(1);
    expect((cpu.readData(ADCSRA) >> ADIF) & 1).toBe(1);
    expect(readAdcResult(avr)).toBe(654);
  });

  test("analog comparator sets ACO, ACI, ACIC, and dispatches ACIE interrupt", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(ACSR, (1 << ACIE) | (1 << ACIS1) | (1 << ACIS0));
    cpu.sreg.I = true;
    avr.comparator.setInput("ain1", 1);
    avr.comparator.setInput("ain0", 0.5);
    expect(avr.comparator.readOutput()).toBe(false);

    avr.comparator.setInput("ain0", 2);
    expect((cpu.readData(ACSR) >> ACO) & 1).toBe(1);
    expect((cpu.readData(ACSR) >> ACI) & 1).toBe(1);

    avr.step();
    expect(cpu.pc).toBe(ANALOG_COMP_VECTOR);
    expect((cpu.readData(ACSR) >> ACI) & 1).toBe(0);

    const capture = AVR();
    capture.cpu.writeData(ACSR, 1 << ACIC);
    // ACIC routes ACO into the Timer1 capture unit; ICES1 selects the edge.
    capture.cpu.writeData(TCCR1B, 1 << ICES1);
    capture.comparator.setInput("ain1", 1);
    capture.comparator.setInput("ain0", 2);
    expect((capture.cpu.readData(TIFR1) >> ICF1) & 1).toBe(1);
  });

  test("analog comparator ACME uses ADC mux when ADC is disabled", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    avr.analog(2).setVoltage(2, 5);
    avr.comparator.setInput("ain0", 3);
    avr.comparator.setInput("ain1", 5);
    cpu.writeData(ADCSRB, 1 << ACME);
    cpu.writeData(ADMUX, 2);

    expect(avr.comparator.readOutput()).toBe(true);
    expect((cpu.readData(ACSR) >> ACO) & 1).toBe(1);

    cpu.writeData(ADCSRA, 1 << ADEN);
    expect(avr.comparator.readOutput()).toBe(false);
  });

  test("clock and comparator state survive snapshot restore", () => {
    const source = AVR().useClock(16_000_000);
    source.cpu.writeData(CLKPR, 1 << CLKPCE);
    source.cpu.writeData(CLKPR, 2);
    source.comparator.setInput("ain0", 3);
    source.comparator.setInput("ain1", 1);

    const restored = AVR();
    restored.restore(source.snapshot());

    expect(restored.status().clockHz).toBe(4_000_000);
    expect(restored.comparator.readOutput()).toBe(true);
  });
});
