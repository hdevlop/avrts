import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AVR } from "../src";
import { compareFloatMath, compareBitbangCrc, createBitbangDriver,
  expectedArithmeticResult, validateResultExpectations } from "../scripts/benchmark-results";

const fixture = (name: string) => readFileSync(new URL(`../examples/arduino-${name}/arduino-${name}.ino.hex`, import.meta.url), "utf8");
const floatHex = fixture("float-math");
const bitbangHex = fixture("bitbang-crc");

// Read linked variable locations from the committed listing so activity checks
// follow a fixture rebuild without guessing which bytes are a progress counter.
function counterAddress(name: string, symbol: string): number {
  const listing = readFileSync(new URL(`../examples/arduino-${name}/arduino-${name}.lst`, import.meta.url), "utf8");
  const match = listing.match(new RegExp(`0x(800[0-9a-f]+) <${symbol}>`));
  if (!match) throw new Error(`Missing ${symbol} in ${name} listing`);
  return Number.parseInt(match[1]!, 16) - 0x800000;
}
const iterationsAddress = counterAddress("float-math", "iterations");
const roundsAddress = counterAddress("bitbang-crc", "rounds");
const counter = (avr: ReturnType<typeof AVR>, address: number) => new DataView(avr.cpu.data.buffer).getUint32(address, true);
const resultBlock = (avr: ReturnType<typeof AVR>) => [...avr.cpu.data.slice(0x300, 0x315)];

test("float-math agrees with avr8js and the compiled AVR-libc golden bytes", () => {
  const comparison = compareFloatMath();
  expect(comparison.differences).toEqual([]);
  expect(comparison.pass).toBe(true);
  for (const outcome of [comparison.avrts, comparison.avr8js]) {
    expect(outcome.completed).toBe(true);
    expect(outcome.result).toEqual([0xa7, 32, 3, 0x82, 0x80, 0x41, 0x70, 0xc8, 0x8e, 0x3e,
      32, 0, 0, 0, 32, 32, 1, 1, 0, 0xf1, 0x5c]);
    expect(outcome.serial).toEqual([]);
  }
});

for (const input of [0, 0x96, 0xa5, 255]) {
  test(`bitbang-crc agrees with avr8js and expected bytes/clock edges at input ${input}`, () => {
    const comparison = compareBitbangCrc({ bitbangInput: input });
    expect(comparison.differences).toEqual([]);
    expect(comparison.pass).toBe(true);
    for (const outcome of [comparison.avrts, comparison.avr8js]) {
      expect(outcome.completed).toBe(true);
      expect(outcome.result).toEqual(expectedArithmeticResult("bitbang-crc", input)!);
      expect(outcome.result.slice(3, 5)).toEqual([0x19, 0x4f]); // CRC-16 of the declared MOSI sequence.
      expect(outcome.result[6]).toBe(input);
      expect(outcome.bitbang?.mosi).toHaveLength(32);
      expect(outcome.bitbang?.risingEdges).toBe(256);
      expect(outcome.bitbang?.fallingEdges).toBe(256);
      expect(outcome.serial).toEqual([]);
    }
  });
}

for (const timing of ["fast", "cycle-exact"] as const) {
  test(`${timing}: float-math runs continuously past round 32 after warmup`, () => {
    const avr = AVR({ hex: floatHex, timing });
    avr.runCycles(500_000);
    const before = counter(avr, iterationsAddress);
    expect(before).toBeGreaterThan(32);
    avr.runCycles(500_000);
    expect(counter(avr, iterationsAddress)).toBeGreaterThan(before);
    expect(avr.cpu.data[0x300]).toBe(0);
  });

  test(`${timing}: bitbang-crc keeps clocking and updating CRC rounds after warmup`, () => {
    const avr = AVR({ hex: bitbangHex, timing });
    let edges = 0;
    avr.pin(13).onChange(() => { edges++; });
    avr.runCycles(500_000);
    const before = counter(avr, roundsAddress);
    const beforeEdges = edges;
    expect(before).toBeGreaterThan(32);
    avr.runCycles(500_000);
    expect(counter(avr, roundsAddress)).toBeGreaterThan(before);
    expect(edges).toBeGreaterThan(beforeEdges + 512);
    expect(avr.cpu.data[0x300]).toBe(0);
  });

  test(`${timing}: finite float-math preserves its result after snapshot/restore and halt`, () => {
    const avr = AVR({ hex: floatHex, timing });
    avr.cpu.data[0x2ff] = 0x42;
    avr.runCycles(70_000);
    expect(counter(avr, iterationsAddress)).toBeLessThan(32);
    const resumed = AVR({ timing }).restore(avr.snapshot());
    for (const runtime of [avr, resumed]) {
      runtime.runCycles(250_000);
      expect(resultBlock(runtime)).toEqual(expectedArithmeticResult("float-math")!);
      expect(counter(runtime, iterationsAddress)).toBe(32);
      runtime.runCycles(100_000);
      expect(counter(runtime, iterationsAddress)).toBe(32);
      expect(resultBlock(runtime)).toEqual(expectedArithmeticResult("float-math")!);
    }
  });

  test(`${timing}: finite bitbang-crc halts without extra output edges`, () => {
    const avr = AVR({ hex: bitbangHex, timing });
    avr.cpu.data[0x2ff] = 0x42;
    const driver = createBitbangDriver(0x96, () => avr.pin(11).read(), (high) => avr.pin(12).setInput(high));
    avr.pin(13).onChange((high) => driver.onClock(high));
    avr.runCycles(50_000);
    expect(validateResultExpectations("bitbang-crc", { result: resultBlock(avr), bitbang: driver.trace })).toEqual([]);
    expect(counter(avr, roundsAddress)).toBe(32);
    avr.runCycles(100_000);
    expect(driver.trace.risingEdges).toBe(256);
    expect(driver.trace.fallingEdges).toBe(256);
    expect(counter(avr, roundsAddress)).toBe(32);
  });
}

test("oracle rejects identical-but-corrupt results and an altered or missing pin trace", () => {
  const float = compareFloatMath().avrts;
  const corrupt = { ...float, result: [...float.result] };
  corrupt.result[2]! ^= 1;
  expect(validateResultExpectations("float-math", corrupt)).not.toEqual([]);
  const bitbang = compareBitbangCrc().avrts;
  expect(validateResultExpectations("bitbang-crc", { ...bitbang, bitbang: undefined })).not.toEqual([]);
  const trace = structuredClone(bitbang.bitbang!);
  trace.mosi[0]! ^= 1;
  expect(validateResultExpectations("bitbang-crc", { ...bitbang, bitbang: trace })).not.toEqual([]);
  trace.mosi[0]! ^= 1;
  trace.fallingEdges--;
  expect(validateResultExpectations("bitbang-crc", { ...bitbang, bitbang: trace })).not.toEqual([]);
});

test("result runner does not complete beyond the requested cycle budget", () => {
  const comparison = compareBitbangCrc({ maxCycles: 11_000 });
  expect(comparison.pass).toBe(false);
  expect(comparison.avrts.completed).toBe(false);
  expect(comparison.avr8js.completed).toBe(false);
  expect(comparison.avrts.cycles).toBeLessThan(11_005);
  expect(comparison.differences.some((error) => error.includes("result marker"))).toBe(true);
});

test("result CLI includes both arithmetic cases by default and rejects invalid selections", () => {
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, "scripts/benchmark-results.ts", ...args], { stdout: "pipe", stderr: "pipe" });
  const all = run();
  expect(all.exitCode).toBe(0);
  expect(all.stdout.toString()).toContain("float-math vs avr8js");
  expect(all.stdout.toString()).toContain("bitbang-crc vs avr8js");
  expect(all.stdout.toString().match(/PASS:/g)).toHaveLength(12);
  expect(run("--case", "unknown").exitCode).toBe(1);
  const badInput = run("--case", "bitbang-crc", "--bitbang-input", "256");
  expect(badInput.exitCode).toBe(1);
  expect(badInput.stderr.toString()).toContain("--bitbang-input");
  expect(() => compareBitbangCrc({ bitbangInput: -1 })).toThrow(/byte/);
}, 30_000);
