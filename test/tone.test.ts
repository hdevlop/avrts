import { describe, expect, test } from "bun:test";
import { AVR } from "../src";

// Phase 8 Arduino library validation: the core tone() function. tone(8, 1000)
// emits a 1 kHz square wave by toggling pin 8 from a Timer2 CTC compare-match
// interrupt each half-period. The test measures the pin-8 edge interval and
// recovers the frequency, exercising Timer2 CTC + GPIO end to end through the
// core's tone() implementation.

const HALF_PERIOD_CYCLES = 16_000_000 / (2 * 1000); // 500 us -> 8_000 cycles.

async function loadTone(): Promise<{ avr: ReturnType<typeof AVR>; edges: number[] }> {
  const hex = await Bun.file(
    new URL("../examples/arduino-tone-melody/arduino-tone-melody.ino.hex", import.meta.url),
  ).text();
  const avr = AVR(hex);
  const edges: number[] = [];
  avr.pin(8).onChange((_high, event) => edges.push(event.cycles));
  return { avr, edges };
}

describe("Arduino tone() sketch", () => {
  test("publishes the commanded frequency after setup", async () => {
    const { avr } = await loadTone();
    avr.runCycles(50_000);
    expect(avr.cpu.data[0x0300]).toBe(0xa7);
    expect(avr.cpu.data[0x0301]! | (avr.cpu.data[0x0302]! << 8)).toBe(1000);
    expect(avr.cpu.data[0x0303]).toBe(0x5c);
  });

  test("toggles pin 8 at 1 kHz (500 us half-period)", async () => {
    const { avr, edges } = await loadTone();
    // Exclude startup pin changes and a previously latched Timer2 flag while
    // tone() reconfigures the Arduino timer; measure the established waveform.
    avr.runCycles(50_000);
    edges.length = 0;
    avr.runCycles(200_000); // ~12.5 ms: many square-wave edges.

    expect(edges.length).toBeGreaterThanOrEqual(10);

    const gaps = edges.slice(1).map((cycle, i) => cycle - edges[i]!);
    const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const frequency = 16_000_000 / (2 * average);

    // Within 1% of 1 kHz — the tone() CTC period lands on the commanded pitch.
    expect(Math.abs(average - HALF_PERIOD_CYCLES)).toBeLessThan(HALF_PERIOD_CYCLES * 0.01);
    expect(frequency).toBeGreaterThan(990);
    expect(frequency).toBeLessThan(1010);
  });
});
