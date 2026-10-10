import { expect, test } from "bun:test";
import { runRuntimeFixture, validateProgrammingTiming } from "../scripts/runtime-fidelity-results";

for (const timing of ["fast", "cycle-exact"] as const) {
  test(`${timing}: compiled EEPROM/boot programming waits for timed busy flags`, () => {
    const outcome = runRuntimeFixture("programming-timing", timing);
    expect(outcome.completed).toBe(true);
    expect(validateProgrammingTiming(outcome.result)).toEqual([]);
  });
  test(`${timing}: compiled external clocks report rollover and compare flags`, () => {
    const outcome = runRuntimeFixture("timer-external-clock", timing);
    expect(outcome.completed).toBe(true);
    expect(outcome.result).toEqual([0xa7, 2, 2, 0, 7, 7, ...Array<number>(13).fill(0), 0x61, 0x5c]);
  });
  test(`${timing}: compiled fast PWM observes TOV1 at TOP`, () => {
    const outcome = runRuntimeFixture("timer1-top", timing);
    expect(outcome.completed).toBe(true);
    expect(outcome.result.slice(0, 4)).toEqual([0xa7, 0xe8, 3, 1]);
    expect(outcome.cycles).toBeGreaterThan(1_024_000);
  });
}

test("programming probe rejects data corruption and instantaneous completion", () => {
  const result = runRuntimeFixture("programming-timing").result;
  const corrupted = [...result]; corrupted[4] = 0;
  expect(validateProgrammingTiming(corrupted)).toContain("EEPROM or flash data differs");
  const instant = [...result]; instant[1] = 0; instant[2] = 0; instant[3] = 0;
  expect(validateProgrammingTiming(instant).length).toBeGreaterThan(1);
});
