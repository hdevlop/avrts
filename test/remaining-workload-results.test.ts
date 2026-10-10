import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AVR } from "../src";
import { compareAnalogWrite, compareDelayBlink, compareSerialPrint, compareTightLoop,
  createPinTrace, defaultResultBudget, tracePinsFor, validatePinTrace, validateResultExpectations } from "../scripts/benchmark-results";

for (const [name, compare] of [["serial-print", compareSerialPrint], ["analog-write", compareAnalogWrite],
  ["delay-blink", compareDelayBlink], ["tight-loop", compareTightLoop]] as const) {
  test(`${name}: complete state agrees with avr8js and independent expectations`, () => {
    const comparison = compare();
    expect(comparison.differences).toEqual([]);
    expect(comparison.pass).toBe(true);
    expect(comparison.avrts.completed).toBe(true);
    expect(comparison.avr8js.completed).toBe(true);
    expect(validateResultExpectations(name, comparison.avrts)).toEqual([]);
  }, 30_000);
}

for (const [scenario, fixture] of [["analog-write", "arduino-analog-write"], ["delay-blink", "delay-blink"]] as const) {
  test(`cycle-exact: ${scenario} actual GPIO satisfies the independent waveform contract`, () => {
    const hex = readFileSync(new URL(`../examples/${fixture}/${fixture}.ino.hex`, import.meta.url), "utf8");
    const avr = AVR({ hex, timing: "cycle-exact" });
    avr.cpu.data[0x2ff] = 0x42;
    const trace = createPinTrace(scenario);
    for (const pin of tracePinsFor(scenario)) avr.pin(pin).onChange((high) => trace.onChange(pin, high, avr.cpu.cycles));
    const budget = defaultResultBudget(scenario);
    while (avr.cpu.cycles < budget && avr.cpu.data[0x314] !== 0x5c) avr.runCycles(10_000);
    expect(avr.cpu.data[0x314]).toBe(0x5c);
    expect(validatePinTrace(scenario, trace.pins)).toEqual([]);
  }, 30_000);
}

for (const timing of ["fast", "cycle-exact"] as const) {
  test(`${timing}: serial-print listeners deliver complete startup bytes and text once`, () => {
    const hex = readFileSync(new URL("../examples/arduino-serial-print/arduino-serial-print.ino.hex", import.meta.url), "utf8");
    const avr = AVR({ hex, timing });
    const bytes: number[] = [];
    const text: string[] = [];
    const stopBytes = avr.serial.onByte((byte) => bytes.push(byte));
    const stopText = avr.serial.onText((value) => text.push(value));
    avr.runCycles(300_000);
    expect(bytes).toEqual([...new TextEncoder().encode("hello avrts\r\n")]);
    expect(text.join("")).toBe("hello avrts\r\n");
    expect(avr.serial.getText()).toBe("hello avrts\r\n");
    const count = text.length;
    avr.runCycles(300_000);
    expect(bytes).toHaveLength(13);
    expect(text).toHaveLength(count);
    expect(avr.cpu.data[0x300]).toBe(0); // Normal one-shot startup behavior.
    stopBytes(); stopText();
    avr.reset().runCycles(300_000);
    expect(bytes).toHaveLength(13);
    expect(text).toHaveLength(count);
  });
}

test("waveform oracle rejects a missing PWM pin, wrong duty and altered blink order", () => {
  const pwm = compareAnalogWrite().avrts;
  const missing = structuredClone(pwm.pins!);
  delete missing[9];
  expect(validatePinTrace("analog-write", missing)).not.toEqual([]);
  const wrongDuty = structuredClone(pwm.pins!);
  wrongDuty[3]![6]!.cycle += 500;
  expect(validatePinTrace("analog-write", wrongDuty)).not.toEqual([]);
  const blink = compareDelayBlink().avrts;
  const order = structuredClone(blink.pins!);
  order[13]![1]!.high = true;
  expect(validatePinTrace("delay-blink", order)).not.toEqual([]);
  expect(validatePinTrace("delay-blink", undefined)).not.toEqual([]);
}, 30_000);

test("startup oracle rejects a truncated UART tail and a forged completion result", () => {
  const serial = compareSerialPrint().avrts;
  expect(validateResultExpectations("serial-print", { ...serial, serial: serial.serial.slice(0, -1) })).not.toEqual([]);
  const corrupt = [...serial.result]; corrupt[1] = 0;
  expect(validateResultExpectations("serial-print", { ...serial, result: corrupt })).not.toEqual([]);
  expect(compareSerialPrint({ maxCycles: 10_000 }).pass).toBe(false);
  expect(compareDelayBlink({ maxCycles: 5_000_000 }).avrts.completed).toBe(false);
});
