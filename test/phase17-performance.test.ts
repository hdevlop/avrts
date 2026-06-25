import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import { createBenchmarkCases, runBenchmarkCase } from "../scripts/benchmark";

interface BenchmarkBaseline {
  cases: Record<string, { reference: number; floor: number }>;
}

const baseline = (await Bun.file(
  new URL("../scripts/benchmark-baseline.json", import.meta.url),
).json()) as BenchmarkBaseline;

/** Best throughput over a few short runs — using the max damps single-run noise. */
function bestCyclesPerSecond(name: string, cycles: number, runs = 3): number {
  const testCase = createBenchmarkCases(cycles).find((c) => c.name === name);
  if (!testCase) throw new Error(`missing benchmark case "${name}"`);
  let best = 0;
  for (let i = 0; i < runs; i += 1) {
    best = Math.max(best, runBenchmarkCase(testCase, 1).cyclesPerSecond);
  }
  return best;
}

function ldiR16(value: number): number {
  return 0xe000 | ((value & 0xf0) << 4) | (value & 0x0f);
}

function out(ioAddr: number, register = 16): number {
  return (
    0xb800 |
    ((ioAddr & 0x30) << 5) |
    ((register & 0x10) << 4) |
    ((register & 0x0f) << 4) |
    (ioAddr & 0x0f)
  );
}

function loadPin13ToggleProgram(avr: ReturnType<typeof AVR>): void {
  avr.cpu.flash.set([
    ldiR16(0x20),
    out(0x04), // DDRB: pin 13 output
    ldiR16(0x20),
    out(0x05), // PORTB: high
    ldiR16(0x00),
    out(0x05), // PORTB: low
    ldiR16(0x20),
    out(0x05), // PORTB: high again
    0xcfff, // rjmp -1
  ]);
}

describe("Phase 17 — browser performance", () => {
  test("pin events stay exact for deterministic runCycles()", () => {
    const avr = AVR({ eventCoalescing: { pins: true } });
    loadPin13ToggleProgram(avr);
    const events: boolean[] = [];
    avr.pin(13).onChange((high) => events.push(high));

    avr.runCycles(8);

    expect(events).toEqual([true, false, true]);
  });

  test("frame() can coalesce high-frequency pin events to the latest state per pin", () => {
    const avr = AVR({ eventCoalescing: { pins: true } });
    loadPin13ToggleProgram(avr);
    const events: boolean[] = [];
    avr.pin(13).onChange((high) => events.push(high));

    avr.frame(1);

    expect(events).toEqual([true]);
  });

  test("benchmark harness covers the Phase 17 workloads", () => {
    const names = createBenchmarkCases(10).map((testCase) => testCase.name);

    expect(names).toEqual([
      "tight-loop",
      "delay-blink",
      "serial-print",
      "serial-print-listener",
      "analog-write",
      "sensor-format",
      "float-math",
      "bitbang-crc",
      "isr-heavy",
      "string-heavy",
      "dsp-fixed",
    ]);
  });

  test("benchmark harness returns throughput numbers", () => {
    const tightLoop = createBenchmarkCases(20).find((testCase) => testCase.name === "tight-loop");
    if (!tightLoop) throw new Error("missing tight-loop benchmark");

    const result = runBenchmarkCase(tightLoop, 1);

    expect(result.cycles).toBe(20);
    expect(result.repeats).toBe(1);
    expect(result.elapsedMs).toBeGreaterThan(0);
    expect(result.cyclesPerSecond).toBeGreaterThan(0);
    expect(result.realtimeFactor).toBeGreaterThan(0);
  });

  // Regression floors: catch large dispatch-throughput drops (e.g. a reintroduced
  // per-instruction allocation) without flaking on machine/CI variance. Floors
  // live in scripts/benchmark-baseline.json, set ~2.5-3x below measured numbers.
  describe("throughput stays above the regression floor", () => {
    // Moderate cycle counts: enough to be representative, fast enough for CI.
    const CYCLES: Record<string, number> = {
      "tight-loop": 1_000_000,
      "delay-blink": 1_000_000,
      "serial-print": 250_000,
      "serial-print-listener": 250_000,
      "analog-write": 500_000,
      "sensor-format": 1_000_000,
      "float-math": 1_000_000,
      "bitbang-crc": 1_000_000,
      "isr-heavy": 1_000_000,
      "string-heavy": 1_000_000,
      "dsp-fixed": 1_000_000,
    };
    for (const [name, { floor }] of Object.entries(baseline.cases)) {
      test(name, () => {
        const measured = bestCyclesPerSecond(name, CYCLES[name]!);
        expect(measured).toBeGreaterThan(floor);
      });
    }
  });
});
