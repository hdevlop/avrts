import { describe, expect, test } from "bun:test";
import { AVR } from "../src";

const SOFTWARE_SERIAL_BIT_CYCLES = Math.round(16_000_000 / 9600);

function driveSoftwareSerialByte(avr: ReturnType<typeof AVR>, byte: number): void {
  const rx = avr.pin(8);

  rx.setInput(false);
  avr.runCycles(SOFTWARE_SERIAL_BIT_CYCLES);
  for (let bit = 0; bit < 8; bit++) {
    rx.setInput(((byte >> bit) & 1) !== 0);
    avr.runCycles(SOFTWARE_SERIAL_BIT_CYCLES);
  }
  rx.setInput(true);
  avr.runCycles(SOFTWARE_SERIAL_BIT_CYCLES * 2);
}

function levelAt(
  events: Array<{ high: boolean; cycles: number }>,
  cycle: number,
): boolean {
  let high = true;
  for (const event of events) {
    if (event.cycles > cycle) break;
    high = event.high;
  }
  return high;
}

function decodeSoftwareSerialByte(events: Array<{ high: boolean; cycles: number }>): number {
  const start = events.find((event) => !event.high);
  expect(start).toBeDefined();

  let value = 0;
  for (let bit = 0; bit < 8; bit++) {
    const sampleCycle = start!.cycles + Math.round(SOFTWARE_SERIAL_BIT_CYCLES * (1.5 + bit));
    if (levelAt(events, sampleCycle)) value |= 1 << bit;
  }
  expect(levelAt(events, start!.cycles + Math.round(SOFTWARE_SERIAL_BIT_CYCLES * 9.5))).toBe(true);
  return value;
}

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

  test("real Arduino Serial.available echo sketch receives paced host bytes", async () => {
    const hex = await Bun.file(
      new URL("../examples/arduino-serial-echo/arduino-serial-echo.ino.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);
    const result = (offset: number) => avr.cpu.data[0x0300 + offset]!;
    const payload = "phase1";

    avr.runCycles(100_000);
    expect(result(0)).toBe(0xa7);

    avr.serial.clear();
    avr.serial.write(payload);
    avr.runCycles(500_000);

    expect(avr.serial.getText()).toContain(payload);
    expect(result(1)).toBe(payload.length);
    expect(result(2)).toBe([...payload].reduce((xor, char) => xor ^ char.charCodeAt(0), 0));
    expect(result(3)).toBe(payload.charCodeAt(payload.length - 1));
    expect(result(5)).toBe(0x5c);
  });

  test("real Arduino SoftwareSerial receives host pin timing and retransmits on TX pin", async () => {
    const hex = await Bun.file(
      new URL(
        "../examples/arduino-softserial-loopback/arduino-softserial-loopback.ino.hex",
        import.meta.url,
      ),
    ).text();
    const avr = AVR(hex);
    const txEvents: Array<{ high: boolean; cycles: number }> = [];
    const result = (offset: number) => avr.cpu.data[0x0300 + offset]!;

    avr.pin(9).onChange((high, event) => txEvents.push({ high, cycles: event.cycles }));
    avr.pin(8).setInput(true);
    avr.runCycles(250_000);
    expect(result(0)).toBe(0xa7);

    txEvents.length = 0;
    avr.serial.clear();
    driveSoftwareSerialByte(avr, 0x51);
    avr.runCycles(500_000);

    expect(result(1)).toBe(1);
    expect(result(2)).toBe(0x51);
    expect(result(3)).toBe(0x51);
    expect(result(5)).toBe(0x5c);
    expect(avr.serial.getText()).toContain("Q");
    expect(decodeSoftwareSerialByte(txEvents)).toBe(0x51);
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

    // Timer1 transfers OCR at TOP, then needs the falling slope to produce its
    // first high pulse. Observe two 510 * 64-clock phase-correct periods so
    // every configured channel completes that pulse as well.
    avr.runCycles(70_000);

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
