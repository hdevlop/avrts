import { expect, test } from "bun:test";
import { AVR, PGWRT, SELFPRGEN, SPMCSR } from "../src";
import { CPU, Decoder, FLASH_WORDS, SREG_ADDR, UnknownOpcodeError } from "../src/cpu";
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
  for (const path of ["handler", "generated", "profiled"] as const) {
    test(`${timing}/${path}: erased words advance one cycle without changing state or skipping`, () => {
      for (const r31 of [0, 0x80]) {
        const cpu = new CPU();
        cpu.setExecutor(new Decoder());
        cpu.timing = timing;
        cpu.data[31] = r31;
        cpu.data[SREG_ADDR] = 0x55;
        const before = cpu.data.slice();
        const events: number[] = [];
        cpu.addClockEvent(() => events.push(cpu.cycles), 1);
        if (path === "handler") cpu.tick();
        else if (path === "generated") cpu.run(1);
        else cpu.profileRun(1, (event) => {
          expect(event.opcode).toBe(0xffff);
          expect(event.mnemonic).toBe("NOP");
          expect(event.elapsedCycles).toBe(1);
        });
        expect(cpu.pc).toBe(1);
        expect(cpu.cycles).toBe(1);
        expect(cpu.data).toEqual(before);
        expect(events).toEqual([1]);
        expect(cpu.flash[0]).toBe(0xffff);
        expect(cpu.readProgramByte(0)).toBe(0xff);
        expect(cpu.readProgramByte(1)).toBe(0xff);

        // Only the erased word has the compatibility fallback.
        cpu.flash[1] = 0xfffe;
        expect(() => cpu.tick()).toThrow(UnknownOpcodeError);
      }
    });
  }

  test(`${timing}: an empty runtime executes and wraps without programming flash`, () => {
    const avr = AVR({ timing });
    avr.runCycles(FLASH_WORDS + 3);
    expect(avr.cpu.pc).toBe(3);
    expect(avr.cpu.cycles).toBe(FLASH_WORDS + 3);
    expect(avr.cpu.flash.every((word) => word === 0xffff)).toBe(true);
  });

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
