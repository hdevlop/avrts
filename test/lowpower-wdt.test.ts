import { describe, expect, test } from "bun:test";
import { AVR } from "../src";

// Phase 7 Arduino validation: a LowPower-library-style sketch that sleeps in
// SLEEP_MODE_PWR_DOWN and wakes on the watchdog timeout interrupt each 16 ms
// period, re-arming WDIE before every sleep (WDIE self-clears on each timeout).
// Running the compiled `.ino.hex` exercises the full sleep/wake path — SLEEP
// entry, WDT-clocked timeout during power-down, WDT_vect dispatch, and the
// return to sleep — end to end. Result block at 0x0300 is
// [marker, wakeups, _, _, marker].

const CYCLES_PER_SECOND = 16_000_000;
const WDT_PERIOD_CYCLES = CYCLES_PER_SECOND * 0.016; // 16 ms -> 256_000 cycles.

async function loadLowPower(): Promise<ReturnType<typeof AVR>> {
  const hex = await Bun.file(
    new URL("../examples/arduino-lowpower-wdt/arduino-lowpower-wdt.ino.hex", import.meta.url),
  ).text();
  return AVR(hex).useClock(CYCLES_PER_SECOND);
}

function runTo(avr: ReturnType<typeof AVR>, targetCycle: number): void {
  while (avr.cpu.cycles < targetCycle) avr.runCycles(10_000);
}

function wakeups(avr: ReturnType<typeof AVR>): number {
  return avr.cpu.data[0x0301]!;
}

describe("LowPower watchdog-sleep Arduino sketch", () => {
  test("enters power-down sleep after setup with no wakeups yet", async () => {
    const avr = await loadLowPower();
    runTo(avr, 50_000); // setup, arm the watchdog, and hit SLEEP.

    expect(avr.cpu.data[0x0300]).toBe(0xa7); // start marker.
    expect(avr.cpu.data[0x0304]).toBe(0x5c); // end marker.
    expect(avr.cpu.isSleeping).toBe(true);
    expect(wakeups(avr)).toBe(0);
  });

  test("the watchdog wakes the MCU once per 16 ms period", async () => {
    const avr = await loadLowPower();

    // Just before the first timeout: still asleep, no wake counted.
    runTo(avr, WDT_PERIOD_CYCLES - 60_000);
    expect(wakeups(avr)).toBe(0);
    expect(avr.cpu.isSleeping).toBe(true);

    // Just after: exactly one wake, and the MCU has gone back to sleep — proof
    // the WDT ran during power-down and the loop re-armed and re-slept.
    runTo(avr, WDT_PERIOD_CYCLES + 60_000);
    expect(wakeups(avr)).toBe(1);
    expect(avr.cpu.isSleeping).toBe(true);
  });

  test("keeps waking at the watchdog period across several cycles", async () => {
    const avr = await loadLowPower();

    for (let period = 1; period <= 4; period++) {
      runTo(avr, period * WDT_PERIOD_CYCLES + 60_000);
      expect(wakeups(avr)).toBe(period);
      expect(avr.cpu.isSleeping).toBe(true);
    }
  });

  test("resumes the sleep/wake cadence across a snapshot restore", async () => {
    const source = await loadLowPower();
    runTo(source, WDT_PERIOD_CYCLES + 60_000);
    expect(wakeups(source)).toBe(1);

    const restored = (await loadLowPower()).restore(source.snapshot());
    expect(restored.cpu.isSleeping).toBe(true);
    expect(wakeups(restored)).toBe(1); // count carried over, no phantom wake.

    // The restored watchdog re-arms and keeps waking on schedule.
    runTo(restored, restored.cpu.cycles + WDT_PERIOD_CYCLES + 60_000);
    expect(wakeups(restored)).toBe(2);
    expect(restored.cpu.isSleeping).toBe(true);
  });
});
