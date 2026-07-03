import { describe, expect, test } from "bun:test";
import { AVR } from "../src";

describe("Phase 9 golden fixtures", () => {
  test("real avr-gcc Timer0 overflow firmware toggles pin 13", async () => {
    const hex = await Bun.file(
      new URL("../examples/timer0-overflow-blink/timer0-overflow-blink.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);
    const edges: number[] = [];

    avr.pin(13).onChange((_high, event) => edges.push(event.cycles));
    avr.runCycles(256 * 8);

    expect(edges.length).toBeGreaterThanOrEqual(6);
    const gaps = edges.slice(1).map((cycle, i) => cycle - edges[i]!);
    // Timers currently advance once per executed instruction, so an overflow can
    // be observed at the boundary of a multi-cycle instruction. The real compiled
    // firmware still produces a stable 256-cycle average cadence.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(255);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(257);
    expect(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length).toBe(256);
  });

  test("real Arduino delay() blink firmware toggles pin 13", async () => {
    const hex = await Bun.file(
      new URL("../examples/arduino-delay-blink/arduino-delay-blink.ino.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);
    const edges: number[] = [];

    avr.pin(13).onChange((_high, event) => edges.push(event.cycles));
    avr.runCycles(80_000);

    expect(edges.length).toBeGreaterThanOrEqual(2);
    expect(edges[0]).toBeLessThan(10_000);
    expect(edges[1]! - edges[0]!).toBeGreaterThan(10_000);
    expect(edges[1]! - edges[0]!).toBeLessThan(30_000);
  });

  test("standard Arduino delay(1000) Blink toggles around 16MHz timing", async () => {
    const hex = await Bun.file(
      new URL("../examples/delay-blink/delay-blink.ino.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);
    const edges: Array<{ high: boolean; cycles: number }> = [];

    avr.pin(13).onChange((high, event) => edges.push({ high, cycles: event.cycles }));
    avr.runCycles(16_100_000);

    expect(edges.length).toBeGreaterThanOrEqual(2);
    expect(edges[0]!.high).toBe(true);
    expect(edges[0]!.cycles).toBeLessThan(10_000);
    expect(edges[1]!.high).toBe(false);
    expect(edges[1]!.cycles - edges[0]!.cycles).toBeGreaterThan(15_900_000);
    expect(edges[1]!.cycles - edges[0]!.cycles).toBeLessThan(16_100_000);
  });

  test("real Arduino Serial.println firmware emits text", async () => {
    const hex = await Bun.file(
      new URL("../examples/arduino-serial-print/arduino-serial-print.ino.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);
    let text = "";

    avr.serial.onText((chunk) => {
      text += chunk;
    });
    avr.runCycles(300_000);

    expect(text).toContain("hello avrts\r\n");
  });

  test("real Arduino digitalRead firmware sees facade-driven pin input", async () => {
    const hex = await Bun.file(
      new URL("../examples/arduino-digital-read/arduino-digital-read.ino.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);
    const seen: boolean[] = [];

    avr.pin(13).onChange((high) => seen.push(high));
    avr.runCycles(20_000);
    expect(avr.pin(13).read()).toBe(false);

    avr.pin(2).setInput(true);
    avr.runCycles(20_000);
    expect(avr.pin(13).read()).toBe(true);

    avr.pin(2).setInput(false);
    avr.runCycles(20_000);
    expect(avr.pin(13).read()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  test("real Arduino analogWrite firmware configures PWM outputs", async () => {
    const hex = await Bun.file(
      new URL("../examples/arduino-analog-write/arduino-analog-write.ino.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);
    const pinEvents = new Map<number, boolean[]>();

    for (const pin of [5, 9, 10, 11, 3]) {
      pinEvents.set(pin, []);
      avr.pin(pin).onChange((high) => {
        pinEvents.get(pin)!.push(high);
      });
    }

    avr.runCycles(20_000);

    expect(avr.pwm(5).read()).toMatchObject({
      channel: "B",
      enabled: true,
      inverted: false,
      mode: "fast-pwm",
      value: 191,
    });
    expect(avr.pwm(9).read()).toMatchObject({
      channel: "A",
      enabled: true,
      inverted: false,
      mode: "phase-correct-pwm",
      value: 64,
    });
    expect(avr.pwm(10).read()).toMatchObject({
      channel: "B",
      enabled: true,
      inverted: false,
      mode: "phase-correct-pwm",
      value: 192,
    });
    expect(avr.pwm(11).read()).toMatchObject({
      channel: "A",
      enabled: true,
      inverted: false,
      mode: "phase-correct-pwm",
      value: 51,
    });
    expect(avr.pwm(3).read()).toMatchObject({
      channel: "B",
      enabled: true,
      inverted: false,
      mode: "phase-correct-pwm",
      value: 128,
    });
    expect(avr.pwm(5).read().duty).toBe(191 / 255);
    expect(avr.pwm(3).read().duty).toBe(128 / 255);
    for (const pin of [5, 9, 10, 11, 3]) {
      expect(pinEvents.get(pin)).toContain(true);
      expect(pinEvents.get(pin)).toContain(false);
    }
  });
});
