import { describe, expect, test } from "bun:test";
import { CPU } from "../src/cpu";
import {
  GENERATED_FAST_CORE_ARM_NAMES,
  GENERATED_FAST_CORE_METHOD_NAME,
} from "../src/cpu/generated/fast-core";
import {
  CPU_FAST_CORE_PATH,
  GENERATED_FAST_CORE_PATH,
  generateFastCoreRegion,
  generateFastCoreSource,
  generatedFastCoreArmNames,
} from "../scripts/generate-fast-core";
import { createBenchmarkCases, type BenchmarkCase } from "../scripts/benchmark";

type RunFast = (this: CPU, target: number) => void;

interface RuntimeSignature {
  pc: number;
  cycles: number;
  data: number[];
  serialText: string;
}

function captureSignature(testCase: BenchmarkCase): RuntimeSignature {
  const avr = testCase.create();
  avr.runCycles(testCase.cycles);
  return {
    pc: avr.cpu.pc,
    cycles: avr.cpu.cycles,
    data: Array.from(avr.cpu.data),
    serialText: avr.serial.getText(),
  };
}

function withHandwrittenFastCore<T>(fn: () => T): T {
  const prototype = CPU.prototype as unknown as Record<string, RunFast>;
  const original = prototype[GENERATED_FAST_CORE_METHOD_NAME];
  const handwritten = prototype.runFast;
  if (original === undefined) throw new Error("missing generated fast core method");
  prototype[GENERATED_FAST_CORE_METHOD_NAME] = handwritten;
  try {
    return fn();
  } finally {
    prototype[GENERATED_FAST_CORE_METHOD_NAME] = original;
  }
}

describe("generated fast core", () => {
  test("committed output is fresh", async () => {
    const generated = await Bun.file(GENERATED_FAST_CORE_PATH).text();
    expect(generated).toBe(generateFastCoreSource());
    const cpuSource = await Bun.file(CPU_FAST_CORE_PATH).text();
    expect(cpuSource).toContain(generateFastCoreRegion());
  });

  test("exports the generated inline arm inventory", () => {
    expect(GENERATED_FAST_CORE_ARM_NAMES.join("\n")).toBe(generatedFastCoreArmNames().join("\n"));
  });

  for (const testCase of createBenchmarkCases()) {
    test(`matches handwritten runFast for ${testCase.name}`, () => {
      const handwritten = withHandwrittenFastCore(() => captureSignature(testCase));
      const generated = captureSignature(testCase);
      expect(generated).toEqual(handwritten);
    });
  }
});
