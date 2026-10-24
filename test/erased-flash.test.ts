import { expect, test } from "bun:test";
import { AVR, PGWRT, SELFPRGEN, SPMCSR } from "../src";
import { CPU, FLASH_WORDS } from "../src/cpu";
import { parseHex } from "../src/loader";
import { INTEL_HEX_EOF, record } from "./helpers";

test("new CPUs expose erased flash while preserving caller-supplied program memory", () => {
  const cpu = new CPU();
  expect(cpu.flash.every((word) => word === 0xffff)).toBe(true);
  expect(cpu.readProgramByte(0)).toBe(0xff);
  expect(cpu.readProgramByte(FLASH_WORDS * 2 - 1)).toBe(0xff);
  const program = new Uint16Array([0, 0x1234]);
  expect(new CPU(program).flash).toBe(program);
  expect(Array.from(program)).toEqual([0, 0x1234]);
});

test("sparse HEX images preserve erased gaps and the unwritten half of a word", () => {
  const flash = parseHex(":0100020042BB\n" + INTEL_HEX_EOF);
  expect(flash[0]).toBe(0xffff);
  expect(flash[1]).toBe(0xff42);
  expect(flash[FLASH_WORDS - 1]).toBe(0xffff);
  expect(parseHex(":0100010042BC\n" + INTEL_HEX_EOF)[0]).toBe(0x42ff);
});

test("reset preserves flash, while clear, reload and snapshot keep erased gaps", () => {
  const avr = AVR();
  expect(avr.cpu.flash[0]).toBe(0xffff);
  avr.useHex(record([0xcfff]) + "\n" + INTEL_HEX_EOF);
  avr.reset();
  expect(avr.cpu.flash[0]).toBe(0xcfff);
  expect(avr.cpu.flash[1]).toBe(0xffff);
  const snap = avr.snapshot();
  avr.cpu.flash[1] = 0;
  avr.reload();
  expect(avr.cpu.flash[1]).toBe(0xffff);
  avr.clearProgram();
  expect(avr.cpu.flash.every((word) => word === 0xffff)).toBe(true);
  avr.restore(snap);
  expect(avr.cpu.flash[0]).toBe(0xcfff);
  expect(avr.cpu.flash[1]).toBe(0xffff);
});

for (const timing of ["fast", "cycle-exact"] as const) {
  test(`${timing}: SPM can program a fresh page without an erase command`, () => {
    const avr = AVR({ timing, fuses: { high: 0xfe } });
    avr.cpu.data[30] = 0;
    avr.cpu.data[31] = 2;
    avr.cpu.data[0] = 0x34;
    avr.cpu.data[1] = 0x12;
    avr.cpu.flash[0x3f00] = 0x95e8;
    for (const command of [1 << SELFPRGEN, (1 << SELFPRGEN) | (1 << PGWRT)]) {
      avr.cpu.pc = 0x3f00;
      avr.cpu.writeData(SPMCSR, command);
      avr.cpu.tick();
    }
    avr.cpu.cycles += 65_600;
    expect(avr.cpu.flash[0x100]).toBe(0x1234);
    expect(avr.cpu.flash[0x101]).toBe(0xffff);
  });
}
