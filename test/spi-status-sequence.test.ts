import { describe, expect, test } from "bun:test";
import * as A from "../src";
import { readFileSync } from "node:fs";

const bit = (n: number) => 1 << n;
const flags = bit(A.SPIF) | bit(A.WCOL);

for (const timing of ["fast", "cycle-exact"] as const) {
  test(`${timing}: compiled SPI status fixture preserves flags and follows access sequences`, () => {
    const hex = readFileSync(new URL("../examples/spi-status-oracle/spi-status-oracle.hex", import.meta.url), "utf8");
    const avr = A.AVR({ timing, hex });
    avr.runCycles(10_000);
    expect([...avr.cpu.data.slice(0x300, 0x308)]).toEqual([0xa7, 0x80, 0x80, 0x40, 0, 0xc0, 0, 0x5c]);
  });
  for (const mode of ["master", "slave"] as const) {
    const setup = () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.DDRB, mode === "master" ? bit(2) : 0);
      avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.SPIE) | (mode === "master" ? bit(A.MSTR) : 0));
      avr.cpu.writeData(A.SPDR, 0x11);
      if (mode === "slave") avr.spi.master().transfer(0x22);
      return avr;
    };
    const start = (avr: ReturnType<typeof A.AVR>) => {
      if (mode === "master") avr.cpu.writeData(A.SPDR, 0x33);
      else avr.spi.master().transfer(0x44);
    };
    const pending = (avr: ReturnType<typeof A.AVR>) => avr.cpu.snapshot().pendingInterrupts;

    describe(`${timing}: SPI ${mode} status sequences`, () => {
      for (const restored of [false, true]) {
        const target = (avr: ReturnType<typeof A.AVR>) => restored ? A.AVR().restore(avr.snapshot()) : avr;
        const path = restored ? "restored" : "direct";

        test(`${path}: a new byte preserves unread completion and collision flags`, () => {
          const source = setup();
          source.cpu.writeData(A.SPDR, 0x55); // Collision without reading SPSR.
          source.runCycles(32);
          const avr = target(source);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(flags);
          expect(pending(avr)).toContain(A.SPI_STC_VECTOR);
          start(avr);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(flags);
          expect(pending(avr)).toContain(A.SPI_STC_VECTOR);
          avr.cpu.readData(A.SPDR); // Unarmed read must not acknowledge either flag.
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(flags);
          avr.runCycles(32);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(flags);
          avr.cpu.readData(A.SPSR);
          avr.cpu.readData(A.SPDR);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(0);
          expect(pending(avr)).not.toContain(A.SPI_STC_VECTOR);
        });

        test(`${path}: reading a clear status before completion does not arm a later data access`, () => {
          const source = setup();
          expect(source.cpu.readData(A.SPSR) & flags).toBe(0);
          source.runCycles(32);
          const avr = target(source);
          avr.cpu.readData(A.SPDR);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(bit(A.SPIF));
          expect(pending(avr)).toContain(A.SPI_STC_VECTOR);
          start(avr);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(bit(A.SPIF));
        });

        test(`${path}: WCOL read before completion arms both flags for a later data read`, () => {
          const source = setup();
          source.cpu.writeData(A.SPDR, 0x55);
          expect(source.cpu.readData(A.SPSR) & flags).toBe(bit(A.WCOL));
          const avr = target(source);
          avr.runCycles(32);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(flags);
          avr.cpu.readData(A.SPDR);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(0);
          expect(pending(avr)).not.toContain(A.SPI_STC_VECTOR);
        });

        test(`${path}: a status/data write clears old flags and a new collision stays latched`, () => {
          const source = setup();
          source.runCycles(32);
          source.cpu.readData(A.SPSR);
          const avr = target(source);
          avr.cpu.writeData(A.SPDR, 0x66); // Acknowledges completion, then starts/preloads.
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(0);
          if (mode === "slave") avr.spi.master().transfer(0x77);
          avr.cpu.writeData(A.SPDR, 0x88);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(bit(A.WCOL));
          avr.cpu.readData(A.SPDR);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(bit(A.WCOL));
          avr.runCycles(32);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(flags);
        });

        test(`${path}: interrupt entry clears SPIF while a new byte preserves WCOL`, () => {
          const source = setup();
          source.cpu.writeData(A.SPDR, 0x55);
          source.runCycles(32);
          const avr = target(source);
          avr.cpu.sreg.I = true;
          avr.step();
          expect(avr.cpu.pc).toBe(A.SPI_STC_VECTOR);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(bit(A.WCOL));
          start(avr);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(bit(A.WCOL));
          expect(pending(avr)).not.toContain(A.SPI_STC_VECTOR);
          avr.runCycles(32);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(flags);
          expect(pending(avr)).toContain(A.SPI_STC_VECTOR);
        });

        test(`${path}: aborting a collided byte does not acknowledge WCOL on restart`, () => {
          const source = setup();
          source.cpu.writeData(A.SPDR, 0x55);
          source.cpu.writeData(A.SPCR, 0);
          const avr = target(source);
          avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.SPIE) | (mode === "master" ? bit(A.MSTR) : 0));
          start(avr);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(bit(A.WCOL));
          avr.runCycles(32);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(flags);
          avr.cpu.readData(A.SPSR);
          avr.cpu.readData(A.SPDR);
          expect(avr.cpu.data[A.SPSR]! & flags).toBe(0);
        });
      }
    });
  }
}
