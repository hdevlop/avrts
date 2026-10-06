import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AVR } from "../src";
import { measureExecution } from "../scripts/benchmark-compare";
import { comparePeripheralBound } from "../scripts/benchmark-results";

const hex = readFileSync(new URL("../examples/arduino-peripheral-bound/arduino-peripheral-bound.ino.hex", import.meta.url), "utf8");
const expectedSerial = Array.from({ length: 512 }, (_, index) => index & 0xff);
const batches = (avr: ReturnType<typeof AVR>) => avr.cpu.data[0x315]! | (avr.cpu.data[0x316]! << 8);

function expectedResult(analogRaw: number, d2High: boolean) {
  const sum = analogRaw * 32;
  const duty = (analogRaw >> 2) ^ 32;
  return [0xa7, 32, sum & 0xff, sum >> 8, 0, 2, 1, 0, 0xff,
    analogRaw & 0xff, analogRaw >> 8, duty, 255 - duty, 1, 0, 8, 7,
    analogRaw & 0xff, analogRaw >> 8, Number(d2High), 0x5c];
}

for (const [analogRaw, d2High] of [[0, false], [123, true], [512, true], [777, false], [1023, true]] as const) {
  test(`peripheral-bound matches the peer and expected output at ADC ${analogRaw}, D2 ${d2High}`, () => {
    const comparison = comparePeripheralBound({ analogRaw, d2High });
    expect(comparison.differences).toEqual([]);
    expect(comparison.pass).toBe(true);
    for (const outcome of [comparison.avrts, comparison.avr8js]) {
      expect(outcome.completed).toBe(true);
      expect(outcome.result).toEqual(expectedResult(analogRaw, d2High));
      expect(outcome.serial).toEqual(expectedSerial);
    }
  });
}

for (const timing of ["fast", "cycle-exact"] as const) {
  test(`${timing}: peripheral-bound keeps USART, both PWM outputs and ADC batches active after warm-up`, () => {
    const avr = AVR({ timing, hex });
    avr.analog(0).setValue(123);
    let bytes = 0;
    let edgesA = 0;
    let edgesB = 0;
    avr.serial.onByte(() => { bytes++; });
    avr.pin(9).onChange(() => { edgesA++; });
    avr.pin(10).onChange(() => { edgesB++; });
    avr.runCycles(500_000);
    const before = { bytes, edgesA, edgesB, batches: batches(avr) };
    avr.runCycles(500_000);
    expect(bytes - before.bytes).toBeGreaterThan(2_000);
    for (const edges of [edgesA - before.edgesA, edgesB - before.edgesB]) {
      expect(edges).toBeGreaterThan(3_500);
      expect(edges).toBeLessThan(4_100);
    }
    // A batch finishes only after all 32 ADC interrupts and 512 serial bytes.
    expect(batches(avr) - before.batches).toBeGreaterThan(4);
    expect(avr.cpu.data[0x300]).toBe(0);
  });

  test(`${timing}: result mode stops after one complete batch without a serial/PWM tail`, () => {
    const avr = AVR({ timing, hex });
    avr.cpu.data[0x2ff] = 0x42;
    avr.analog(0).setValue(512);
    avr.pin(2).setInput(true);
    const serial: number[] = [];
    let edges = 0;
    avr.serial.onByte((byte) => serial.push(byte));
    avr.pin(9).onChange(() => { edges++; });
    avr.pin(10).onChange(() => { edges++; });
    avr.runCycles(200_000);
    expect([...avr.cpu.data.slice(0x300, 0x315)]).toEqual(expectedResult(512, true));
    expect(serial).toEqual(expectedSerial);
    expect(batches(avr)).toBe(1);
    const stoppedEdges = edges;
    avr.runCycles(200_000);
    expect(serial).toHaveLength(512);
    expect(edges).toBe(stoppedEdges);
    expect(batches(avr)).toBe(1);
  });
}

test("comparison retains measured USART/PWM activity in both isolated engines", () => {
  const child = Bun.spawnSync([process.execPath, "scripts/benchmark-compare.ts", "--isolate", "--case", "peripheral-bound", "--cycles", "200000", "--warmup-cycles", "500000", "--repeats", "1", "--json"], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const report = JSON.parse(child.stdout.toString());
  for (const engine of ["avrts", "avr8js"]) {
    const sample = report.rows[0][engine].samples[0];
    expect(sample.peripheralActivity.serialBytes).toBeGreaterThan(512);
    expect(sample.peripheralActivity.pwmEdges).toBeGreaterThan(2_500);
  }
});

test("activity counters exclude construction and warm-up", () => {
  let clock = 0;
  const sample = measureExecution(() => {
    let cycles = 0;
    let serialBytes = 100;
    let pwmEdges = 200;
    return {
      get cycles() { return cycles; },
      get peripheralActivity() { return { serialBytes, pwmEdges }; },
      run(budget: number) { cycles += budget; serialBytes += budget; pwmEdges += budget * 2; clock += budget; },
    };
  }, 100, 500, () => clock);
  expect(sample.peripheralActivity).toEqual({ serialBytes: 100, pwmEdges: 200 });
});
