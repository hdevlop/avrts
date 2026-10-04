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

    avr.step(); // NOP at the last word, then the PC wraps to 0
    expect(avr.cpu.pc).toBe(0);
  });

  test("an empty boot section slides into the application (BOOTRST, no bootloader)", () => {
    const avr = AVR().useFuses(UNO_FUSES).useHex(BLINK_HEX);
    expect(avr.cpu.pc).toBe(0x3f00);

    let edges = 0;
    avr.pin(13).onChange(() => {
      edges += 1;
    });
    avr.runFor(20);
    expect(edges).toBeGreaterThan(0);
    expect(avr.cpu.pc).toBeGreaterThanOrEqual(0);
    expect(avr.cpu.pc).toBeLessThan(FLASH_WORDS);
  });

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
