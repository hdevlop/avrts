import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AVR, FLASH_WORDS } from "../src";
import { INTEL_HEX_EOF, record } from "./helpers";

const EOF = INTEL_HEX_EOF;
const RJMP_MINUS_2 = 0xcffe;
const UNO_FUSES = { low: 0xff, high: 0xde, extended: 0xfd } as const;
const BLINK_HEX = readFileSync(
  new URL("../examples/arduino-delay-blink/arduino-delay-blink.ino.hex", import.meta.url),
  "utf8",
);

describe("program counter wraps at the flash boundary", () => {
  test("RJMP backwards from word 0 lands on the last flash word", () => {
    const avr = AVR(`${record([RJMP_MINUS_2])}\n${EOF}`);
    avr.step();
    expect(avr.cpu.pc).toBe(FLASH_WORDS - 1);

    avr.step(); // Erased word at the last address, then the PC wraps to 0.
    expect(avr.cpu.pc).toBe(0);
  });

  for (const timing of ["fast", "cycle-exact"] as const) {
    test(`${timing}: an erased boot section wraps into the app (BOOTRST, no bootloader)`, () => {
      const avr = AVR({ timing }).useFuses(UNO_FUSES).useHex(BLINK_HEX);
      const bootStart = 0x3f00;
      expect(avr.cpu.pc).toBe(bootStart);
      expect(avr.cpu.flash.slice(bootStart).every((word) => word === 0xffff)).toBe(true);

      const startCycles = avr.cpu.cycles;
      let hit: number | undefined;
      avr.on("breakpoint", (event) => { hit = event.pc; });
      avr.breakpoint({ pc: 0 });
      avr.runCycles(FLASH_WORDS - bootStart + 10);
      expect(hit).toBe(0);
      expect(avr.cpu.pc).toBe(0);
      expect(avr.cpu.cycles - startCycles).toBe(FLASH_WORDS - bootStart);

      avr.clearBreakpoint(0);
      const levels: boolean[] = [];
      avr.pin(13).onChange((high) => levels.push(high));
      avr.runFor(5);
      expect(levels).toContain(true);
      expect(levels).toContain(false);
      expect(avr.cpu.pc).toBeLessThan(bootStart);
    });
  }

  test("the slow (debug) path wraps the same way as the fast core", () => {
    const fast = AVR().useFuses(UNO_FUSES).useHex(BLINK_HEX);
    const debug = AVR().useFuses(UNO_FUSES).useHex(BLINK_HEX);
    debug.breakpoint({ pc: 0x1fff }); // never hit; forces the per-tick path

    fast.runCycles(5_000);
    debug.runCycles(5_000);
    expect(debug.cpu.pc).toBe(fast.cpu.pc);
    expect(debug.status().cycles).toBe(fast.status().cycles);
  });

  test("a breakpoint on the wrapped PC still fires", () => {
    const avr = AVR(`${record([RJMP_MINUS_2])}\n${EOF}`);
    avr.breakpoint({ pc: FLASH_WORDS - 1 });
    let hit: number | undefined;
    avr.on("breakpoint", (event) => {
      hit = event.pc;
    });

    avr.runCycles(10);
    expect(hit).toBe(FLASH_WORDS - 1);
  });
});
