import { describe, expect, test } from "bun:test";
import { AVR, PORTB, type DataWatchEvent } from "../src";
import { UnknownOpcodeError } from "../src/cpu";

/** Build an Intel HEX record from a list of 16-bit words (little-endian). */
function record(words: number[], address = 0): string {
  const bytes: number[] = [];
  for (const w of words) {
    bytes.push(w & 0xff);
    bytes.push((w >> 8) & 0xff);
  }
  const count = bytes.length;
  const addrHi = (address >> 8) & 0xff;
  const addrLo = address & 0xff;
  const body = [count, addrHi, addrLo, 0x00, ...bytes];
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xff;
  const checksum = (-sum) & 0xff;
  const hex = [...body, checksum].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("");
  return `:${hex}`;
}

const EOF = ":00000001FF";

/** LDI Rd, K (d = R - 16, so R must be 16..31). */
const ldi = (r: number, k: number): number => {
  if (r < 16 || r > 31) throw new Error("LDI needs R16..R31");
  const d = r - 16;
  return 0xe000 | ((k & 0xf0) << 4) | (d << 4) | (k & 0x0f);
};

/** OUT A, Rr. */
const out = (a: number, r: number): number =>
  0xb800 |
  ((a & 0x30) << 5) | // A[5:4] -> bits 10:9
  ((r & 0x10) << 4) | // R[4] -> bit 8
  ((r & 0x0f) << 4) | // R[3:0] -> bits 7:4
  (a & 0x0f); // A[3:0] -> bits 3:0

const RJMP_SELF = 0xcfff;
const NOP = 0x0000;

describe("Phase 11 — breakpoints", () => {
  test("breakpoint pauses before executing the instruction at that PC", () => {
    // ldi r16, 0x20 ; out PORTB, r16 ; ldi r16, 0x00 ; out PORTB, r16 ; rjmp -1
    // PC 0 = LDI, PC 1 = OUT, PC 2 = LDI, PC 3 = OUT, PC 4 = RJMP
    const program =
      record([ldi(16, 0x20), out(0x05, 16), ldi(16, 0), out(0x05, 16), RJMP_SELF]) +
      "\n" +
      EOF;
    const avr = AVR(program);
    avr.breakpoint({ pc: 2 }); // pause before second LDI

    avr.runCycles(2); // executes LDI + OUT, halts before LDI at PC 2
    expect(avr.cpu.pc).toBe(2);
    expect(avr.cpu.data[16]).toBe(0x20);
    expect(avr.cpu.data[PORTB]).toBe(0x20);
  });

  test("breakpoint emits a 'breakpoint' event with the hit PC", () => {
    const program =
      record([ldi(16, 0x20), out(0x05, 16), ldi(16, 0), out(0x05, 16), RJMP_SELF]) +
      "\n" +
      EOF;
    const avr = AVR(program);
    avr.breakpoint({ pc: 1 });

    const events: Array<{ pc?: number }> = [];
    avr.on("breakpoint", (event) => events.push({ pc: event.pc }));

    avr.runCycles(10);
    expect(events).toEqual([{ pc: 1 }]);
  });

  test("clearing a breakpoint lets execution continue", () => {
    const program =
      record([ldi(16, 0x20), out(0x05, 16), ldi(16, 0), out(0x05, 16), RJMP_SELF]) +
      "\n" +
      EOF;
    const avr = AVR(program);
    avr.breakpoint({ pc: 1 });
    avr.runCycles(2);
    expect(avr.cpu.pc).toBe(1);

    avr.clearBreakpoint(1);
    avr.runCycles(10);
    expect(avr.cpu.pc).toBe(4);
  });

  test("clearBreakpoints() removes all breakpoints", () => {
    const program =
      record([ldi(16, 0x20), out(0x05, 16), ldi(16, 0), out(0x05, 16), RJMP_SELF]) +
      "\n" +
      EOF;
    const avr = AVR(program);
    avr.breakpoint({ pc: 1 });
    avr.breakpoint({ pc: 2 });
    avr.breakpoint({ pc: 3 });
    avr.runCycles(2);
    expect(avr.cpu.pc).toBe(1);

    avr.clearBreakpoints();
    avr.runCycles(20);
    expect(avr.cpu.pc).toBe(4);
  });

  test("multiple breakpoints can be set and each fires once", () => {
    const program =
      record([ldi(16, 0x20), out(0x05, 16), ldi(16, 0), out(0x05, 16), RJMP_SELF]) +
      "\n" +
      EOF;
    const avr = AVR(program);
    avr.breakpoint({ pc: 1 });
    avr.breakpoint({ pc: 3 });

    const hits: number[] = [];
    avr.on("breakpoint", (event) => hits.push(event.pc ?? -1));

    avr.runCycles(2); // stops at PC 1
    expect(hits).toEqual([1]);

    avr.clearBreakpoint(1);
    avr.runCycles(10); // now hits PC 3
    expect(hits).toEqual([1, 3]);
  });

  test("step() also respects breakpoints", () => {
    const program = record([ldi(16, 0), ldi(16, 0), RJMP_SELF]) + "\n" + EOF;
    const avr = AVR(program);
    avr.breakpoint({ pc: 1 });
    avr.step(); // executes PC 0
    expect(avr.cpu.pc).toBe(1);

    const events: number[] = [];
    avr.on("breakpoint", (event) => events.push(event.pc ?? -1));

    avr.step(); // hits breakpoint at PC 1, does not execute
    expect(avr.cpu.pc).toBe(1);
    expect(events).toEqual([1]);
  });

  test("breakpoint that is never reached produces no event", () => {
    const program = record([ldi(16, 0), ldi(16, 0), RJMP_SELF]) + "\n" + EOF;
    const avr = AVR(program);
    avr.breakpoint({ pc: 100 });
    const events: unknown[] = [];
    avr.on("breakpoint", (event) => events.push(event));
    avr.runCycles(50);
    expect(events).toHaveLength(0);
    expect(avr.cpu.pc).toBe(2);
  });

  test("breakpoint pauses a running runtime instead of stopping it", () => {
    const program = record([NOP, RJMP_SELF]) + "\n" + EOF;
    const avr = AVR(program);
    const events: string[] = [];

    avr.breakpoint({ pc: 1 });
    avr.on("pause", (event) => events.push(`${event.type}:${event.status.running}/${event.status.paused}`));
    avr.on("stop", (event) => events.push(`${event.type}:${event.status.running}/${event.status.paused}`));
    avr.on("breakpoint", (event) => events.push(`${event.type}:${event.status.running}/${event.status.paused}:${event.pc}`));

    avr.start();
    avr.runCycles(2);

    expect(avr.status().running).toBe(true);
    expect(avr.status().paused).toBe(true);
    expect(events).toEqual(["pause:true/true", "breakpoint:true/true:1"]);
    avr.stop();
  });
});

describe("Phase 11 — unknown opcode handling", () => {
  test("default behavior throws UnknownOpcodeError", () => {
    const avr = AVR();
    // 0xFFFF is unmapped in the decode table -> UnknownOpcodeError.
    avr.cpu.flash[0] = 0xffff;
    expect(() => avr.runCycles(1)).toThrow(UnknownOpcodeError);
  });

  test("pauseOnUnknownOpcode(true) emits an 'error' event and pauses", () => {
    const avr = AVR();
    avr.cpu.flash[0] = 0xffff;
    avr.pauseOnUnknownOpcode(true);

    const errors: unknown[] = [];
    avr.on("error", (event) => errors.push(event.error));

    avr.runCycles(10); // should not throw
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(UnknownOpcodeError);
    expect(avr.cpu.pc).toBe(0); // PC still at the unknown opcode
    expect(avr.cpu.error).toBeNull(); // error was cleared after emitting
  });

  test("pauseOnUnknownOpcode(false) restores throw behavior", () => {
    const avr = AVR();
    avr.cpu.flash[0] = 0xffff;
    avr.pauseOnUnknownOpcode(true);
    avr.pauseOnUnknownOpcode(false);
    expect(() => avr.runCycles(1)).toThrow(UnknownOpcodeError);
  });

  test("step() with pauseOnUnknownOpcode captures but does not throw", () => {
    const avr = AVR();
    avr.cpu.flash[0] = 0xffff;
    avr.pauseOnUnknownOpcode(true);

    const errors: unknown[] = [];
    avr.on("error", (event) => errors.push(event.error));

    expect(() => avr.step()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(UnknownOpcodeError);
  });

  test("pauseOnUnknownOpcode(true) pauses a running runtime instead of stopping it", () => {
    const avr = AVR();
    const events: string[] = [];
    avr.cpu.flash[0] = 0xffff;
    avr.pauseOnUnknownOpcode(true);

    avr.on("pause", (event) => events.push(`${event.type}:${event.status.running}/${event.status.paused}`));
    avr.on("stop", (event) => events.push(`${event.type}:${event.status.running}/${event.status.paused}`));
    avr.on("error", (event) => events.push(`${event.type}:${event.status.running}/${event.status.paused}:${event.error instanceof UnknownOpcodeError}`));

    avr.start();
    avr.runCycles(1);

    expect(avr.status().running).toBe(true);
    expect(avr.status().paused).toBe(true);
    expect(events).toEqual(["pause:true/true", "error:true/true:true"]);
    avr.stop();
  });
});

describe("Phase 11 — watchpoints (avr.watchData)", () => {
  test("watchpoint fires on firmware write to a data-space address", () => {
    const avr = AVR();
    const events: DataWatchEvent[] = [];
    avr.watchData(PORTB, (e) => events.push({ ...e }));

    avr.cpu.writeData(PORTB, 0x42);
    expect(events).toEqual([{ address: PORTB, oldValue: 0, value: 0x42 }]);

    avr.cpu.writeData(PORTB, 0x99);
    expect(events).toEqual([
      { address: PORTB, oldValue: 0, value: 0x42 },
      { address: PORTB, oldValue: 0x42, value: 0x99 },
    ]);
  });

  test("watchpoint fires when firmware executes an OUT to that I/O register", () => {
    // ldi r16, 0x20 ; out PORTB, r16 ; rjmp -1
    const program = record([ldi(16, 0x20), out(0x05, 16), RJMP_SELF]) + "\n" + EOF;
    const avr = AVR(program);
    const events: DataWatchEvent[] = [];
    avr.watchData(PORTB, (e) => events.push({ ...e }));

    avr.runCycles(1); // LDI
    expect(events).toEqual([]); // no write to PORTB yet

    avr.runCycles(1); // OUT -> PORTB = 0x20
    expect(events).toEqual([{ address: PORTB, oldValue: 0, value: 0x20 }]);
  });

  test("multiple handlers can watch the same address; each is called", () => {
    const avr = AVR();
    const a: number[] = [];
    const b: number[] = [];
    avr.watchData(PORTB, (e) => a.push(e.value));
    avr.watchData(PORTB, (e) => b.push(e.value));

    avr.cpu.writeData(PORTB, 0x10);
    expect(a).toEqual([0x10]);
    expect(b).toEqual([0x10]);
  });

  test("returned unsubscribe function removes the handler", () => {
    const avr = AVR();
    const events: number[] = [];
    const unsubscribe = avr.watchData(PORTB, (e) => events.push(e.value));

    avr.cpu.writeData(PORTB, 0x10);
    expect(events).toEqual([0x10]);

    unsubscribe();
    avr.cpu.writeData(PORTB, 0x20);
    expect(events).toEqual([0x10]); // no new event
  });

  test("watching one address does not fire for writes to other addresses", () => {
    const avr = AVR();
    const events: DataWatchEvent[] = [];
    avr.watchData(PORTB, (e) => events.push({ ...e }));

    avr.cpu.writeData(PORTB + 1, 0x55);
    expect(events).toEqual([]);
  });

  test("unsubscribing one of two handlers keeps the other active", () => {
    const avr = AVR();
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = avr.watchData(PORTB, (e) => a.push(e.value));
    avr.watchData(PORTB, (e) => b.push(e.value));

    unsubA();

    avr.cpu.writeData(PORTB, 0x77);
    expect(a).toEqual([]);
    expect(b).toEqual([0x77]);
  });
});

describe("Phase 11 — debugger integration", () => {
  test("trace data still includes pc, opcode, mnemonic, cycles", () => {
    const program = record([ldi(16, 0x0a), RJMP_SELF]) + "\n" + EOF;
    const avr = AVR(program);
    const traces: Array<{ pc: number; mnemonic: string; cycles: number }> = [];
    avr.cpu.onTrace((state) => traces.push(state));

    avr.runCycles(1);
    expect(traces).toHaveLength(1);
    expect(traces[0]!.pc).toBe(0);
    expect(traces[0]!.mnemonic).toBe("LDI");
    expect(traces[0]!.cycles).toBe(1);
  });

  test("breakpoints survive a reset() because they are runtime/debugger state", () => {
    const program = record([ldi(16, 0), ldi(16, 0), RJMP_SELF]) + "\n" + EOF;
    const avr = AVR(program);
    avr.breakpoint({ pc: 2 });
    avr.reset();
    expect(avr.cpu.breakpoints.has(2)).toBe(true);
  });

  test("pauseOnUnknownOpcode setting survives reset()", () => {
    const avr = AVR();
    avr.pauseOnUnknownOpcode(true);
    avr.reset();
    expect(avr.cpu.pauseOnUnknownOpcode).toBe(true);
  });
});
