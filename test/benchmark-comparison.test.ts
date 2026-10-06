import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AVR } from "../src";
import { measureExecution } from "../scripts/benchmark-compare";

test("comparison excludes construction and warm-up and reports actual execution cycles", () => {
  let clock = 0;
  const sample = measureExecution(() => {
    clock += 1_000; // Deliberately dominant construction cost.
    let cycles = 0;
    return {
      get cycles() { return cycles; },
      run(budget: number) { cycles += budget + 1; clock += budget + 1; },
    };
  }, 100, 500, () => clock);
  expect(sample.constructionMs).toBe(1_000);
  expect(sample.elapsedMs).toBe(101);
  expect(sample.cycles).toBe(101);
  expect(sample.cyclesPerSecond).toBeCloseTo(1_000, 8);
});

test("both comparison engines keep completing TWI work after warm-up", () => {
  const processResult = Bun.spawnSync([process.execPath, "scripts/benchmark-compare.ts", "--isolate", "--case", "peripheral-mix", "--cycles", "200000", "--warmup-cycles", "500000", "--repeats", "1", "--json"], { stdout: "pipe", stderr: "pipe" });
  expect(processResult.exitCode).toBe(0);
  const report = JSON.parse(processResult.stdout.toString());
  for (const engine of ["avrts", "avr8js"]) expect(report.rows[0][engine].samples[0].twiStops).toBeGreaterThan(12);
});

for (const args of [["--case"], ["--output"], ["--warmup-cycles", "-1"]]) {
  test(`comparison rejects incomplete/invalid arguments: ${args.join(" ")}`, () => {
    const processResult = Bun.spawnSync([process.execPath, "scripts/benchmark-compare.ts", ...args], { stdout: "pipe", stderr: "pipe" });
    expect(processResult.exitCode).not.toBe(0);
    expect(processResult.stderr.toString()).toContain("expects");
  });
}

test("isolated comparison preserves requested budget, warm-up and raw samples", () => {
  const processResult = Bun.spawnSync([process.execPath, "scripts/benchmark-compare.ts", "--isolate", "--case", "tight-loop", "--cycles", "1001", "--warmup-cycles", "101", "--repeats", "2", "--json"], { stdout: "pipe", stderr: "pipe" });
  expect(processResult.exitCode).toBe(0);
  const report = JSON.parse(processResult.stdout.toString());
  expect(report.includesConstruction).toBe(false);
  expect(report.isolate).toBe(true);
  expect(report.warmupCycles).toBe(101);
  expect(report.rows).toHaveLength(1);
  expect(report.rows[0].cycles).toBe(1001);
  for (const engine of ["avrts", "avr8js"]) {
    expect(report.rows[0][engine].samples).toHaveLength(2);
    for (const sample of report.rows[0][engine].samples) {
      expect(sample.cycles).toBeGreaterThanOrEqual(1001);
      expect(sample.cycles).toBeLessThanOrEqual(1002);
      expect(sample.elapsedMs).toBeGreaterThan(0);
    }
  }
});

for (const timing of ["fast", "cycle-exact"] as const) {
  test(`${timing}: peripheral-mix keeps exercising the bus after its first result`, () => {
    const hex = readFileSync(new URL("../examples/arduino-peripheral-mix/arduino-peripheral-mix.ino.hex", import.meta.url), "utf8");
    const avr = AVR({ timing, hex });
    let stops = 0;
    avr.twi.connect(0x50, { start: () => true, write: () => true, read: () => 0, stop: () => { stops++; } });
    avr.runCycles(200_000);
    expect(stops).toBeGreaterThan(12);
    const before = stops;
    avr.runCycles(200_000);
    expect(stops).toBeGreaterThan(before);
  });
}
