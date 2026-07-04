import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import {
  BODSE,
  BODS,
  BORF,
  CLKPR,
  INT0_VECTOR,
  IVCE,
  IVSEL,
  MCUCR,
  MCUSR,
  PORF,
  WDE,
  WDRF,
  WDTCSR,
} from "../src/cpu";

const BOOT_256_WORD_START = 0x3f00;

describe("Phase 6 chip-level tier", () => {
  test("CKDIV8 fuse applies the reset clock divider", () => {
    const avr = AVR().useClock(16_000_000).useFuses({ low: 0x7f }).reset();

    expect(avr.cpu.readData(CLKPR) & 0x0f).toBe(3);
    expect(avr.status().clockHz).toBe(2_000_000);
  });

  test("BOOTRST and BOOTSZ fuses reset into the boot section", () => {
    const avr = AVR().useFuses({ high: 0xfe }).reset();

    expect(avr.cpu.pc).toBe(BOOT_256_WORD_START);
    expect(avr.fuses().high).toBe(0xfe);
  });

  test("MCUCR IVCE/IVSEL relocates interrupt vectors to the boot section", () => {
    const avr = AVR().useFuses({ high: 0xfe }).reset();
    const cpu = avr.cpu;

    cpu.writeData(MCUCR, 1 << IVCE);
    cpu.writeData(MCUCR, 1 << IVSEL);
    expect((cpu.readData(MCUCR) >> IVSEL) & 1).toBe(1);

    cpu.sreg.I = true;
    cpu.requestInterrupt(INT0_VECTOR);
    avr.step();

    expect(cpu.pc).toBe(BOOT_256_WORD_START + INT0_VECTOR);
  });

  test("MCUCR protected windows expire if the second write is too late", () => {
    const avr = AVR().useFuses({ high: 0xfe }).reset();
    const cpu = avr.cpu;

    cpu.writeData(MCUCR, 1 << IVCE);
    avr.runCycles(4);
    cpu.writeData(MCUCR, 1 << IVSEL);

    expect((cpu.readData(MCUCR) >> IVSEL) & 1).toBe(0);
    expect(cpu.interruptVectorBase).toBe(0);
  });

  test("BODS/BODSE follows the protected brown-out sleep-disable handshake", () => {
    const cpu = AVR().cpu;

    cpu.writeData(MCUCR, (1 << BODS) | (1 << BODSE));
    expect(cpu.readData(MCUCR) & ((1 << BODS) | (1 << BODSE))).toBe(
      (1 << BODS) | (1 << BODSE),
    );

    cpu.writeData(MCUCR, 1 << BODS);
    expect((cpu.readData(MCUCR) >> BODS) & 1).toBe(1);
    expect((cpu.readData(MCUCR) >> BODSE) & 1).toBe(0);
  });

  test("brown-out reset sets BORF in MCUSR", () => {
    const avr = AVR().resetBrownOut();

    expect(avr.cpu.readData(MCUSR)).toBe(1 << BORF);
  });

  test("WDTON fuse forces watchdog system-reset mode", () => {
    const avr = AVR().useClock(1_000).useFuses({ high: 0xef }).reset();
    const cpu = avr.cpu;

    expect((cpu.readData(WDTCSR) >> WDE) & 1).toBe(1);
    cpu.writeData(WDTCSR, 0);
    expect((cpu.readData(WDTCSR) >> WDE) & 1).toBe(1);

    avr.runCycles(15);
    expect(cpu.readData(MCUSR)).toBe(1 << PORF);
    avr.step();
    expect((cpu.readData(MCUSR) >> WDRF) & 1).toBe(1);
    expect((cpu.readData(WDTCSR) >> WDE) & 1).toBe(1);
  });

  test("chipErase clears flash and lock bits while EESAVE controls EEPROM erase", () => {
    const erased = AVR().useFuses({ high: 0xff, lockBits: 0x00 });
    erased.cpu.flash[0] = 0x1234;
    erased.eeprom.write(7, 0x42);
    erased.chipErase();

    expect(erased.cpu.flash[0]).toBe(0xffff);
    expect(erased.eeprom.read(7)).toBe(0xff);
    expect(erased.fuses().lockBits).toBe(0xff);

    const preserved = AVR().useFuses({ high: 0xf7 });
    preserved.eeprom.write(7, 0x5a);
    preserved.chipErase();

    expect(preserved.eeprom.read(7)).toBe(0x5a);
  });

  test("explicit SUT/CKSEL low fuse adds reset startup delay cycles", () => {
    const avr = AVR().useClock(1_000).useFuses({ low: 0xa2 }).reset();

    expect(avr.cpu.cycles).toBe(90);
  });

  test("fuses and relocated vector state survive snapshot restore", () => {
    const source = AVR()
      .useFuses({ low: 0x7f, high: 0xfe, extended: 0xfd, lockBits: 0xcf })
      .reset();
    const cpu = source.cpu;
    cpu.writeData(MCUCR, 1 << IVCE);
    cpu.writeData(MCUCR, 1 << IVSEL);

    const restored = AVR().restore(source.snapshot());

    expect(restored.fuses()).toEqual({ low: 0x7f, high: 0xfe, extended: 0xfd, lockBits: 0xcf });
    expect(restored.cpu.interruptVectorBase).toBe(BOOT_256_WORD_START);
  });
});
