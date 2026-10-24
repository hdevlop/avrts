import { expect, test } from "bun:test";
import { CPU } from "../src/cpu";
import { WallClockTimer } from "../src/peripherals/wall-clock-timer";

test("wall-clock timer recovers every integer-cycle deadline from milliseconds", () => {
  const cpu = new CPU();
  const timer = new WallClockTimer(cpu, () => {});
  for (const hz of [16_000_000, 8_000_000, 8_128_000]) {
    timer.setClock(hz);
    for (let remaining = 1; remaining <= 65_600; remaining++) {
      timer.startCycles(remaining);
      const milliseconds = timer.remainingMs();
      timer.stop();
      timer.start(milliseconds);
      if (timer.remainingCycles() !== remaining) {
        throw new Error(`${hz} Hz: ${remaining} cycles became ${timer.remainingCycles()}`);
      }
    }
    timer.stop();
  }
  expect(timer.remainingCycles()).toBe(0);
});
