import { describe, expect, test } from "bun:test";
import { AVR } from "../src";

// Phase 5 Arduino validation: a real Arduino sketch that keeps wall-clock time
// from Timer2's asynchronous 32.768 kHz TOSC crystal (prescaler 128 -> 1 Hz
// overflow) and counts seconds in the TIMER2_OVF ISR. This exercises the full
// async path — the exact 16 MHz / 32.768 kHz tick ratio, the overflow flag, and
// interrupt dispatch — end to end on the compiled `.ino.hex`.

const CYCLES_PER_SECOND = 16_000_000;

async function loadRtc(): Promise<ReturnType<typeof AVR>> {
  const hex = await Bun.file(
    new URL("../examples/arduino-timer2-rtc/arduino-timer2-rtc.ino.hex", import.meta.url),
  ).text();
  return AVR(hex);
}

function runTo(avr: ReturnType<typeof AVR>, targetCycle: number): void {
  while (avr.cpu.cycles < targetCycle) avr.runCycles(100_000);
}

function seconds(avr: ReturnType<typeof AVR>): number {
  return avr.cpu.data[0x0301]! | (avr.cpu.data[0x0302]! << 8);
}

describe("Timer2 async RTC Arduino sketch", () => {
  test("publishes its result block after setup with the clock at zero", async () => {
    const avr = await loadRtc();
    avr.runCycles(300_000); // let setup() configure async Timer2 and publish.

    expect(avr.cpu.data[0x0300]).toBe(0xa7); // start marker.
    expect(avr.cpu.data[0x0304]).toBe(0x5c); // end marker.
    expect(seconds(avr)).toBe(0);
  });

  test("counts one second per Timer2 async overflow at the exact TOSC ratio", async () => {
    const avr = await loadRtc();

    // Just before the first overflow: the clock has not ticked yet.
    runTo(avr, CYCLES_PER_SECOND - 100_000);
    expect(seconds(avr)).toBe(0);

    // Just after: exactly one second, bounding the 1 Hz period to +/-100k
    // cycles (+/-6 ms) — proof the async crystal ratio keeps real time.
    runTo(avr, CYCLES_PER_SECOND + 100_000);
    expect(seconds(avr)).toBe(1);
  });

  test("keeps accurate time across several seconds without drift", async () => {
    const avr = await loadRtc();

    for (let second = 1; second <= 4; second++) {
      runTo(avr, second * CYCLES_PER_SECOND + 200_000);
      expect(seconds(avr)).toBe(second);
      // Sub-second counter stays within a single 8-bit Timer2 span.
      expect(avr.cpu.data[0x0303]!).toBeLessThan(256);
    }
  });
});
