import { describe, expect, test } from "bun:test";
import { CPU } from "../src/cpu";
import {
  GENERATED_FAST_CORE_ARM_NAMES,
  runGeneratedFastCore,
} from "../src/cpu/generated/fast-core";
import {
  GENERATED_FAST_CORE_PATH,
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

function withGeneratedFastCore<T>(fn: () => T): T {
  const prototype = CPU.prototype as unknown as { runFast: RunFast };
  const original = prototype.runFast;
  prototype.runFast = runGeneratedFastCore as RunFast;
  try {
    return fn();
  } finally {
    prototype.runFast = original;
  }
}

describe("generated fast core", () => {
  test("committed output is fresh", async () => {
    const generated = await Bun.file(GENERATED_FAST_CORE_PATH).text();
    expect(generated).toBe(generateFastCoreSource());
  });

  test("exports the generated inline arm inventory", () => {
    expect(GENERATED_FAST_CORE_ARM_NAMES.join("\n")).toBe(generatedFastCoreArmNames().join("\n"));
  });

  for (const testCase of createBenchmarkCases()) {
    test(`matches handwritten runFast for ${testCase.name}`, () => {
      const handwritten = captureSignature(testCase);
      const generated = withGeneratedFastCore(() => captureSignature(testCase));
      expect(generated).toEqual(handwritten);
    });
  }
});
