import { describe, expect, test } from "bun:test";
import { AVR, FLASH_WORDS, WGM01 } from "../src";
import {
  CS00,
  CS01,
  CS10,
  CS20,
  OCR0A,
  OCR1AH,
  OCR1AL,
  OCR2A,
  OCF0A,
  OCF1A,
  OCF2A,
  TCCR0A,
  TCCR0B,
  TCCR1B,
  TCCR2A,
  TCCR2B,
  TCNT0,
  TIFR0,
  TIFR1,
  TIFR2,
  TIMSK0,
  TOIE0,
  TOV0,
  WGM12,
  WGM21,
  WGM02,
} from "../src/cpu";
import { INTEL_HEX_EOF, record } from "./helpers";

const EOF = INTEL_HEX_EOF;
const NOP = 0x0000;

describe("Phase 12 — timing mode API", () => {
  test("default timing is 'fast'", () => {
    const avr = AVR();
    expect(avr.cpu.timing).toBe("fast");
  });

  test("constructor option sets timing to cycle-exact", () => {
    const avr = AVR({ timing: "cycle-exact" });
    expect(avr.cpu.timing).toBe("cycle-exact");
  });

  test("useTiming() switches timing mode at runtime", () => {
    const avr = AVR();
    avr.useTiming("cycle-exact");
    expect(avr.cpu.timing).toBe("cycle-exact");
    avr.useTiming("fast");
    expect(avr.cpu.timing).toBe("fast");
  });

  test("useTiming() rejects unknown modes", () => {
    const avr = AVR();
    expect(() => avr.useTiming("bogus" as never)).toThrow();
  });

  test("AVROptions.timing is wired through use()", () => {
    const avr = AVR();
    avr.use({ timing: "cycle-exact" });
    expect(avr.cpu.timing).toBe("cycle-exact");
  });
});

describe("Phase 12 — fast vs cycle-exact notification granularity", () => {
  test("fast mode coalesces multi-cycle instructions into one listener call", () => {
    const avr = AVR(); // fast mode default
    const calls: number[] = [];
    avr.cpu.onCycles((cycles) => calls.push(cycles));

    // CALL is a 4-cycle instruction.
    avr.cpu.flash[0] = 0x940e;
    avr.cpu.tick();

    expect(calls).toEqual([4]);
  });

  test("cycle-exact mode emits one listener call per simulated cycle", () => {
    const avr = AVR({ timing: "cycle-exact" });
    const calls: number[] = [];
    avr.cpu.onCycles((cycles) => calls.push(cycles));

    // CALL is a 4-cycle instruction.
    avr.cpu.flash[0] = 0x940e;
    avr.cpu.tick();

    expect(calls).toEqual([1, 1, 1, 1]);
  });

  test("NOP is still 1 cycle in cycle-exact mode (1 listener call)", () => {
    const avr = AVR({ timing: "cycle-exact" });
    const calls: number[] = [];
    avr.cpu.onCycles((cycles) => calls.push(cycles));
    avr.cpu.tick(); // NOP at flash[0]
    expect(calls).toEqual([1]);
  });

  test("interrupt dispatch bills 4 cycles per-cycle in cycle-exact mode", () => {
    const avr = AVR({ timing: "cycle-exact" });
    // Configure a simple Timer0 overflow on a fresh AVR.
    avr.cpu.writeData(TCCR0B, 1 << CS00); // /1
    avr.cpu.writeData(TIMSK0, 1 << TOIE0);
    avr.cpu.sreg.I = true;

    const calls: number[] = [];
    avr.cpu.onCycles((cycles) => calls.push(cycles));

    avr.runCycles(256);

    // 256 single-cycle ticks (NOPs), then the 256th overflows the timer and
    // the interrupt dispatch adds 4 more cycles inside serviceInterrupts.
    expect(calls.length).toBe(260);
    expect(calls.slice(-4)).toEqual([1, 1, 1, 1]);
  });
});

describe("Phase 12 — Timer0 cycle-exact boundaries", () => {
  test("Timer0 overflow flag is set at exact cycle 256 with prescaler /1", () => {
    const avr = AVR({ timing: "cycle-exact" });
    avr.cpu.writeData(TCCR0B, 1 << CS00); // /1
    avr.cpu.sreg.I = false; // do not dispatch — keep the flag set

    // Track the absolute cycle when TOV0 first becomes 1.
    let overflowCycle = -1;
    avr.cpu.onCycles(() => {
      if (overflowCycle === -1 && (avr.cpu.readData(TIFR0) & (1 << TOV0)) !== 0) {
        overflowCycle = avr.cpu.cycles;
      }
    });

    avr.runCycles(300);
    expect(overflowCycle).toBe(256);
  });

  test("Timer0 overflow flag is set at exact cycle 2048 with prescaler /8", () => {
    const avr = AVR({ timing: "cycle-exact" });
    avr.cpu.writeData(TCCR0B, 1 << CS01); // /8
    avr.cpu.sreg.I = false;

    let overflowCycle = -1;
    avr.cpu.onCycles(() => {
      if (overflowCycle === -1 && (avr.cpu.readData(TIFR0) & (1 << TOV0)) !== 0) {
        overflowCycle = avr.cpu.cycles;
      }
    });

    avr.runCycles(2100);
    expect(overflowCycle).toBe(2048);
  });

  test("Timer0 compare flag A follows equality by one /1 timer clock", () => {
    const avr = AVR({ timing: "cycle-exact" });
    avr.cpu.writeData(TCCR0A, 1 << WGM01); // CTC mode
    avr.cpu.writeData(TCCR0B, 1 << CS00); // /1
    avr.cpu.writeData(OCR0A, 100);
    avr.cpu.writeData(TIMSK0, 0); // no interrupt dispatch
    avr.cpu.sreg.I = false;

    let compareCycle = -1;
    avr.cpu.onCycles(() => {
      if (compareCycle === -1 && (avr.cpu.readData(TIFR0) & (1 << OCF0A)) !== 0) {
        compareCycle = avr.cpu.cycles;
      }
    });

    avr.runCycles(150);
    expect(compareCycle).toBe(101); // OCF follows equality by one timer clock.
  });

  test("Timer0 compare flag A follows equality by one /8 timer clock", () => {
    const avr = AVR({ timing: "cycle-exact" });
    avr.cpu.writeData(TCCR0A, 1 << WGM01); // CTC mode
    avr.cpu.writeData(TCCR0B, 1 << CS01); // /8
    avr.cpu.writeData(OCR0A, 50);
    avr.cpu.writeData(TIMSK0, 0);
    avr.cpu.sreg.I = false;

    let compareCycle = -1;
    avr.cpu.onCycles(() => {
      if (compareCycle === -1 && (avr.cpu.readData(TIFR0) & (1 << OCF0A)) !== 0) {
        compareCycle = avr.cpu.cycles;
      }
    });

    avr.runCycles(500);
    expect(compareCycle).toBe(408); // (50 + 1) ticks * 8 cycles.
  });
});

describe("Phase 12 — Timer1/Timer2 cycle-exact boundaries", () => {
  test("Timer1 compare flag A follows equality by one timer clock", () => {
    const avr = AVR({ timing: "cycle-exact" });
    avr.cpu.writeData(TCCR1B, (1 << WGM12) | (1 << CS10)); // CTC, /1
    avr.cpu.writeData(OCR1AH, 0);
    avr.cpu.writeData(OCR1AL, 50);
    avr.cpu.sreg.I = false;

    let compareCycle = -1;
    avr.cpu.onCycles(() => {
      if (compareCycle === -1 && (avr.cpu.readData(TIFR1) & (1 << OCF1A)) !== 0) {
        compareCycle = avr.cpu.cycles;
      }
    });

    avr.runCycles(80);
    expect(compareCycle).toBe(51);
  });

  test("Timer2 compare flag A follows equality by one timer clock", () => {
    const avr = AVR({ timing: "cycle-exact" });
    avr.cpu.writeData(TCCR2A, 1 << WGM21); // CTC
    avr.cpu.writeData(TCCR2B, 1 << CS20); // /1
    avr.cpu.writeData(OCR2A, 50);
    avr.cpu.sreg.I = false;

    let compareCycle = -1;
    avr.cpu.onCycles(() => {
      if (compareCycle === -1 && (avr.cpu.readData(TIFR2) & (1 << OCF2A)) !== 0) {
        compareCycle = avr.cpu.cycles;
      }
    });

    avr.runCycles(80);
    expect(compareCycle).toBe(51);
  });
});

describe("Phase 12 — golden Timer0 fixture (existing fast-mode tests stay green)", () => {
  test("timer0-overflow-blink fixture still passes in fast mode", async () => {
    const hex = await Bun.file(
      new URL("../examples/timer0-overflow-blink/timer0-overflow-blink.hex", import.meta.url),
    ).text();
    const avr = AVR(hex); // fast mode default
    const edges: number[] = [];
    avr.pin(13).onChange((_high, event) => edges.push(event.cycles));
    avr.runCycles(256 * 8);
    // Each overflow should be at least 256 cycles apart, and the average
    // should be exactly 256 cycles.
    expect(edges.length).toBeGreaterThanOrEqual(6);
    const gaps = edges.slice(1).map((cycle, i) => cycle - edges[i]!);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(255);
      expect(gap).toBeLessThanOrEqual(257);
    }
    expect(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length).toBe(256);
  });

  test("timer0-overflow-blink fixture also passes in cycle-exact mode", async () => {
    const hex = await Bun.file(
      new URL("../examples/timer0-overflow-blink/timer0-overflow-blink.hex", import.meta.url),
    ).text();
    const avr = AVR({ hex, timing: "cycle-exact" });
    const edges: number[] = [];
    avr.pin(13).onChange((_high, event) => edges.push(event.cycles));
    avr.runCycles(256 * 8);
    // Same shape: overflow every ~256 cycles, average 256.
    expect(edges.length).toBeGreaterThanOrEqual(6);
    const gaps = edges.slice(1).map((cycle, i) => cycle - edges[i]!);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(255);
    expect(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length).toBe(256);
  });
});

describe("Phase 12 — snapshot / restore for timing mode", () => {
  test("snapshot captures timing; restore re-applies it", () => {
    const avr = AVR();
    avr.useTiming("cycle-exact");
    const snap = avr.snapshot();
    expect(snap.runtime.timing).toBe("cycle-exact");

    avr.useTiming("fast");
    avr.restore(snap);
    expect(avr.cpu.timing).toBe("cycle-exact");
  });
});
