import { describe, expect, test } from "bun:test";
import { GENERATED_FAST_CORE_ARM_NAMES } from "../src/cpu/generated/fast-core";
import {
  GENERATED_CORES_PATH,
  GENERATED_FAST_CORE_PATH,
  generateCoresFile,
  generateFastCoreSource,
  generatedFastCoreArmNames,
} from "../scripts/generate-fast-core";
import { createBenchmarkCases, type BenchmarkCase } from "../scripts/benchmark";
import { AVR, TIFR0 } from "../src";

interface RuntimeSignature {
  pc: number;
  cycles: number;
  data: number[];
  serialText: string;
}

function captureSignature(testCase: BenchmarkCase): RuntimeSignature {
  const avr = testCase.create();
  avr.runCycles(testCase.cycles); // fast path: CPU.run() -> generated fast core
  return {
    pc: avr.cpu.pc,
    cycles: avr.cpu.cycles,
    data: Array.from(avr.cpu.data),
    serialText: avr.serial.getText(),
  };
}

function captureViaTick(testCase: BenchmarkCase): RuntimeSignature {
  const avr = testCase.create();
  const target = avr.cpu.cycles + testCase.cycles;
  while (avr.cpu.cycles < target) avr.cpu.tick(); // pure handler path, one instr at a time
  return {
    pc: avr.cpu.pc,
    cycles: avr.cpu.cycles,
    data: Array.from(avr.cpu.data),
    serialText: avr.serial.getText(),
  };
}

describe("generated fast core", () => {
  for (const instruction of ["SBIC", "SBIS"] as const) {
    for (const initial of [0, 1]) {
      test(`${instruction} samples I/O before a flag changes during its first clock (${initial})`, () => {
        const setup = () => {
          const avr = AVR();
          avr.cpu.flash[0] = (instruction === "SBIC" ? 0x9900 : 0x9b00) | (0x15 << 3);
          avr.cpu.data[TIFR0] = initial;
          avr.cpu.addClockEvent(() => { avr.cpu.data[TIFR0] = 1 - initial; }, 1);
          return avr;
        };
        const fast = setup(), handler = setup();
        fast.cpu.run(1);
        handler.cpu.tick();
        const skip = instruction === "SBIC" ? initial === 0 : initial === 1;
        expect(fast.cpu.pc).toBe(skip ? 2 : 1);
        expect(fast.cpu.pc).toBe(handler.cpu.pc);
        expect(fast.cpu.cycles).toBe(handler.cpu.cycles);
        expect(fast.cpu.data[TIFR0]).toBe(handler.cpu.data[TIFR0]);
      });
    }
  }
  test("committed output is fresh", async () => {
    // Windows checkouts (core.autocrlf) get CRLF; that is not drift.
    const readLf = async (path: string | URL) => (await Bun.file(path).text()).replace(/\r\n/g, "\n");
    const generated = await readLf(GENERATED_FAST_CORE_PATH);
    expect(generated).toBe(generateFastCoreSource());
    // The generated cores module (fast ladder, profiled ladder, and the
    // __udivmodsi4 CFG block) must match the generator verbatim — this is what
    // makes the single-sourced cores impossible to drift apart.
    const coresSource = await readLf(GENERATED_CORES_PATH);
    expect(coresSource).toBe(generateCoresFile());
  });

  test("exports the generated inline arm inventory", () => {
    expect(GENERATED_FAST_CORE_ARM_NAMES.join("\n")).toBe(generatedFastCoreArmNames().join("\n"));
  });

  // The real correctness anchor: the generated fast core must reach exactly the
  // same end-state as the plain tick()/handler interpreter on every fixture.
  for (const testCase of createBenchmarkCases()) {
    test(`generated fast core matches the tick()/handler path for ${testCase.name}`, () => {
      expect(captureSignature(testCase)).toEqual(captureViaTick(testCase));
    });
  }

  // The profiled ladder is generated from the same arms as the run() ladder, so
  // it must reach identical end-state and account for every elapsed cycle. This
  // is what keeps `profile:opcodes --mode fast` honest as new arms are added.
  for (const testCase of createBenchmarkCases()) {
    test(`profiled ladder matches run() and bills every cycle for ${testCase.name}`, () => {
      const expected = captureSignature(testCase);
      const avr = testCase.create();
      const start = avr.cpu.cycles;
      let summed = 0;
      avr.cpu.profileRun(testCase.cycles, (event) => {
        summed += event.elapsedCycles;
      });
      expect({
        pc: avr.cpu.pc,
        cycles: avr.cpu.cycles,
        data: Array.from(avr.cpu.data),
        serialText: avr.serial.getText(),
      }).toEqual(expected);
      expect(summed).toBe(avr.cpu.cycles - start);
    });
  }
});
