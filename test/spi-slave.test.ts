import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import { DDRB, DORD, MSTR, SPCR, SPDR, SPE, SPIF, SPSR, WCOL } from "../src/cpu";
import { DEFAULT_SPI_TRANSFER_CYCLES } from "./helpers";

describe("SPI slave mode", () => {
  test("host master clocks a byte into firmware configured as SPI slave", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    const master = avr.spi.master();

    avr.pin(10).setInput(false); // PB2 / SS selected.
    cpu.writeData(SPCR, 1 << SPE);
    cpu.writeData(SPDR, 0xa5);

    expect(master.transfer(0x3c)).toBe(0xa5);
    expect((cpu.data[SPSR]! >> SPIF) & 1).toBe(0);
    avr.runCycles(DEFAULT_SPI_TRANSFER_CYCLES - 1);
    expect((cpu.data[SPSR]! >> SPIF) & 1).toBe(0);
    avr.runCycles(1);
    expect(cpu.readData(SPDR)).toBe(0x3c);
    expect((cpu.data[SPSR]! >> SPIF) & 1).toBe(1);
  });

  test("host master transfer requires SS low", () => {
    const avr = AVR();
    avr.cpu.writeData(SPCR, 1 << SPE);
    avr.pin(10).setInput(true);

    expect(() => avr.spi.master().transfer(0x12)).toThrow("SS/PB2 low");
  });

  test("SS falling while configured as input clears MSTR and sets SPIF", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(DDRB, cpu.readData(DDRB) & ~(1 << 2));
    avr.pin(10).setInput(true);
    cpu.writeData(SPCR, (1 << SPE) | (1 << MSTR));

    avr.pin(10).setInput(false);
    expect((cpu.readData(SPCR) >> MSTR) & 1).toBe(0);
    expect((cpu.data[SPSR]! >> SPIF) & 1).toBe(1);
  });

  test("SPIF uses the documented SPSR then SPDR clear sequence", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(DDRB, 1 << 2);
    cpu.writeData(SPCR, (1 << SPE) | (1 << MSTR));
    cpu.writeData(SPDR, 0x10);
    avr.runCycles(DEFAULT_SPI_TRANSFER_CYCLES);
    expect((cpu.data[SPSR]! >> SPIF) & 1).toBe(1);

    cpu.readData(SPDR);
    expect((cpu.data[SPSR]! >> SPIF) & 1).toBe(1);

    cpu.readData(SPSR);
    cpu.readData(SPDR);
    expect((cpu.data[SPSR]! >> SPIF) & 1).toBe(0);
  });

  test("SPDR write preserves stale SPIF/WCOL without a preceding SPSR read", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(DDRB, 1 << 2);
    cpu.writeData(SPCR, (1 << SPE) | (1 << MSTR));
    cpu.data[SPSR] = (1 << SPIF) | (1 << WCOL);
    cpu.writeData(SPDR, 0x22);
    expect((cpu.data[SPSR]! >> SPIF) & 1).toBe(1);
    expect((cpu.data[SPSR]! >> WCOL) & 1).toBe(1);
  });

  test("DORD is exposed as transfer metadata without serializing bit order", () => {
    const avr = AVR();
    const seen: string[] = [];
    avr.spi.onByte((_byte, meta) => seen.push(`${meta.mode}:${meta.bitOrder}`));
    avr.spi.respondWith((_byte, meta) => (meta.bitOrder === "lsb-first" ? 0x5a : 0xa5));

    avr.cpu.writeData(DDRB, 1 << 2);
    avr.cpu.writeData(SPCR, (1 << SPE) | (1 << MSTR) | (1 << DORD));
    avr.cpu.writeData(SPDR, 0x81);
    avr.runCycles(DEFAULT_SPI_TRANSFER_CYCLES);

    expect(seen).toEqual(["master:lsb-first"]);
    expect(avr.cpu.readData(SPDR)).toBe(0x5a);
  });

  test("snapshot restores an in-flight host-master slave transfer", () => {
    const source = AVR();
    source.pin(10).setInput(false);
    source.cpu.writeData(SPCR, 1 << SPE);
    source.cpu.writeData(SPDR, 0x44);
    expect(source.spi.master().transfer(0x99)).toBe(0x44);
    source.runCycles(10);

    const restored = AVR();
    restored.restore(source.snapshot());
    restored.runCycles(DEFAULT_SPI_TRANSFER_CYCLES - 10 - 1);
    expect((restored.cpu.data[SPSR]! >> SPIF) & 1).toBe(0);
    restored.runCycles(1);
    expect(restored.cpu.readData(SPDR)).toBe(0x99);
    expect((restored.cpu.data[SPSR]! >> SPIF) & 1).toBe(1);
  });
});
