import { describe, expect, test } from "bun:test";
import { AVR } from "../src";

// Phase 8 Arduino library validation: the real Arduino Servo library. Servo
// parks a hobby servo by emitting a ~1-2 ms pulse every 20 ms on the attached
// pin, timed by Timer1 compare-match interrupts that toggle the pin in software.
// This sketch commands an exact 1500 us pulse on pin 9; the test measures the
// pin-9 high time and the 20 ms refresh period, exercising Timer1 CTC + GPIO end
// to end through compiled Servo library code.

const NEUTRAL_PULSE_CYCLES = 16 * 1500; // 1500 us at 16 MHz = 24_000 cycles.
const REFRESH_CYCLES = 16_000 * 20; // 20 ms refresh = 320_000 cycles.

async function loadServo(): Promise<{
  avr: ReturnType<typeof AVR>;
  edges: Array<{ high: boolean; cycles: number }>;
}> {
  const hex = await Bun.file(
    new URL("../examples/arduino-servo-sweep/arduino-servo-sweep.ino.hex", import.meta.url),
  ).text();
  const avr = AVR(hex);
  const edges: Array<{ high: boolean; cycles: number }> = [];
  avr.pin(9).onChange((high, event) => edges.push({ high, cycles: event.cycles }));
  return { avr, edges };
}

function pulseWidths(edges: Array<{ high: boolean; cycles: number }>): number[] {
  const widths: number[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    if (edges[i]!.high && !edges[i + 1]!.high) widths.push(edges[i + 1]!.cycles - edges[i]!.cycles);
  }
  return widths;
}

describe("Arduino Servo library sketch", () => {
  test("publishes the commanded pulse width after setup", async () => {
    const { avr } = await loadServo();
    avr.runCycles(400_000);
    expect(avr.cpu.data[0x0300]).toBe(0xa7);
    expect(avr.cpu.data[0x0301]! | (avr.cpu.data[0x0302]! << 8)).toBe(1500);
    expect(avr.cpu.data[0x0303]).toBe(0x5c);
  });

  test("drives a 1500 us pulse on pin 9 every 20 ms", async () => {
    const { avr, edges } = await loadServo();
    avr.runCycles(3_000_000); // ~187 ms: several refresh periods.

    const widths = pulseWidths(edges);
    expect(widths.length).toBeGreaterThanOrEqual(3);

    // Every pulse is the commanded 1500 us (+/- 3 us of interrupt-entry slack).
    for (const width of widths) {
      expect(Math.abs(width - NEUTRAL_PULSE_CYCLES)).toBeLessThan(16 * 3);
    }

    // Rising edges repeat at the 20 ms Servo refresh interval.
    const rises = edges.filter((e) => e.high).map((e) => e.cycles);
    const periods = rises.slice(1).map((cycle, i) => cycle - rises[i]!);
    for (const period of periods) {
      expect(Math.abs(period - REFRESH_CYCLES)).toBeLessThan(16 * 10);
    }
  });
});
