import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AVR } from "../src";
import { compareSensorFormat, expectedSensorFormat, resultLengthFor,
  validateResultExpectations } from "../scripts/benchmark-results";

const fixture = new URL("../examples/arduino-sensor-format/arduino-sensor-format.ino.hex", import.meta.url);
const hex = readFileSync(fixture, "utf8");
const listing = readFileSync(new URL("../examples/arduino-sensor-format/arduino-sensor-format.lst", import.meta.url), "utf8");
const symbol = listing.match(/0x(800[0-9a-f]+) <sampleIndex>/);
if (!symbol) throw new Error("Missing sampleIndex in sensor-format listing");
const indexAddress = Number.parseInt(symbol[1]!, 16) - 0x800000;
const index = (avr: ReturnType<typeof AVR>) => new DataView(avr.cpu.data.buffer).getUint16(indexAddress, true);
const result = (avr: ReturnType<typeof AVR>) => [...avr.cpu.data.slice(0x300, 0x335)];

for (const start of [0, 128, 65520, 112, 383]) {
  test(`sensor-format: full history, PWM and UART agree with independent specification at start ${start}`, () => {
    const comparison = compareSensorFormat({ sensorStart: start });
    expect(comparison.differences).toEqual([]);
    expect(comparison.pass).toBe(true);
    const expected = expectedSensorFormat(start);
    for (const outcome of [comparison.avrts, comparison.avr8js]) {
      expect(outcome.completed).toBe(true);
      expect(outcome.result).toEqual(expected.result);
      expect(outcome.result).toHaveLength(53);
      expect(outcome.serial).toEqual(expected.serial);
      expect(outcome.result[18]).toBe(0x40); // TXC: the final frame has completed.
      expect(outcome.registers.portB! & 2).toBe(0);
      expect(outcome.registers.portD! & 8).toBe(0);
      expect(outcome.registers.tccr2a).toBe(0);
    }
    if (start === 112 || start === 383) {
      expect(expected.result[7]).toBe(start === 112 ? 255 : 0);
      expect(expected.result.slice(15, 17)).toEqual([1, 1]); // PWM disconnected.
      expect(expected.result[12]).not.toBe(expected.result[7]); // Last buffered duty remains.
    }
  });
}

test("sensor-format specification has explicit normal and wrapped serial text and accumulator", () => {
  const normal = expectedSensorFormat();
  expect(new TextDecoder().decode(new Uint8Array(normal.serial))).toBe(
    "sample=0,raw=12,scaled=-188\r\nsample=128,raw=652,scaled=469\r\n");
  expect(normal.result.slice(1, 8)).toEqual([144, 0, 3, 255, 5, 0, 196]);
  const wrapped = expectedSensorFormat(65520);
  expect(new TextDecoder().decode(new Uint8Array(wrapped.serial))).toBe("sample=0,raw=12,scaled=-188\r\n");
  expect(wrapped.result.slice(1, 3)).toEqual([128, 0]);
  expect(resultLengthFor("sensor-format")).toBe(53);
  expect(resultLengthFor("float-math")).toBe(21);
});

for (const timing of ["fast", "cycle-exact"] as const) {
  test(`${timing}: sensor-format continues sampling and transmitting after warmup`, () => {
    const avr = AVR({ hex, timing });
    const serial: number[] = [];
    avr.serial.onByte((byte) => serial.push(byte));
    avr.runCycles(2_000_000);
    const before = index(avr);
    const beforeBytes = serial.length;
    expect(before).toBeGreaterThan(144);
    avr.runCycles(2_000_000);
    expect(index(avr)).toBeGreaterThan(before);
    expect(serial.length).toBeGreaterThan(beforeBytes);
    expect(avr.cpu.data[0x300]).toBe(0);
  });

  test(`${timing}: snapshot with both UART stages occupied resumes to the same complete result`, () => {
    const avr = AVR({ hex, timing });
    avr.cpu.data[0x2ff] = 0x42;
    const serial: number[] = [];
    avr.serial.onByte((byte) => serial.push(byte));
    avr.runCycles(100_000);
    const snapshot = avr.snapshot();
    expect(snapshot.usart0.txShiftByte).not.toBeNull();
    expect(snapshot.usart0.txBufferByte).not.toBeNull();
    expect(avr.cpu.data[0x334]).toBe(0);
    const resumed = AVR({ timing }).restore(snapshot);
    const resumedSerial = [...serial];
    resumed.serial.onByte((byte) => resumedSerial.push(byte));
    const expected = expectedSensorFormat();
    for (const [runtime, bytes] of [[avr, serial], [resumed, resumedSerial]] as const) {
      runtime.runCycles(2_000_000);
      expect(result(runtime)).toEqual(expected.result);
      expect(bytes).toEqual(expected.serial);
      expect(index(runtime)).toBe(144);
      expect(runtime.snapshot().usart0.txShiftByte).toBeNull();
      expect(runtime.snapshot().usart0.txBufferByte).toBeNull();
      runtime.runCycles(100_000);
      expect(result(runtime)).toEqual(expected.result);
      expect(bytes).toEqual(expected.serial); // No late tail after completion.
      expect(index(runtime)).toBe(144);
    }
  });
}

test("sensor-format oracle rejects corrupted history, missing result bytes and a truncated UART tail", () => {
  const expected = expectedSensorFormat();
  expect(validateResultExpectations("sensor-format", expected)).toEqual([]);
  const history = [...expected.result];
  history[40]! ^= 1;
  expect(validateResultExpectations("sensor-format", { ...expected, result: history })).not.toEqual([]);
  expect(validateResultExpectations("sensor-format", { ...expected, result: expected.result.slice(0, 21) })).not.toEqual([]);
  expect(validateResultExpectations("sensor-format", { ...expected, serial: expected.serial.slice(0, -1) })).not.toEqual([]);
  expect(validateResultExpectations("sensor-format", { result: expected.result })).not.toEqual([]);
});

test("sensor-format runner reports an insufficient cycle budget and validates start inputs", () => {
  const comparison = compareSensorFormat({ maxCycles: 100_000 });
  expect(comparison.pass).toBe(false);
  expect(comparison.avrts.completed).toBe(false);
  expect(comparison.avr8js.completed).toBe(false);
  expect(comparison.avrts.cycles).toBeLessThan(100_005);
  expect(comparison.differences.some((error) => error.includes("result marker"))).toBe(true);
  for (const start of [-1, 65536, 1.5, Number.NaN]) {
    expect(() => compareSensorFormat({ sensorStart: start })).toThrow(/sensorStart/);
  }
});

test("both result CLIs reject invalid sensor starts before executing firmware", () => {
  for (const script of ["scripts/benchmark-results.ts", "scripts/simavr-oracle.ts"]) {
    for (const start of ["-1", "65536", "1.5"]) {
      const run = Bun.spawnSync([process.execPath, script, "--case", "sensor-format", "--sensor-start", start],
        { stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(1);
      expect(run.stderr.toString()).toContain("--sensor-start");
    }
  }
});
