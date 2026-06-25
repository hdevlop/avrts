import { describe, expect, test } from "bun:test";
import { comparePeripheralMix } from "../scripts/benchmark-results";

describe("result benchmark comparisons", () => {
  test.each([
    { name: "low ADC, D2 low", analogRaw: 0, d2High: false },
    { name: "low-mid ADC, D2 high", analogRaw: 123, d2High: true },
    { name: "mid ADC, D2 high", analogRaw: 512, d2High: true },
    { name: "high-mid ADC, D2 low", analogRaw: 777, d2High: false },
    { name: "max ADC, D2 high", analogRaw: 1023, d2High: true },
  ])("peripheral-mix matches avr8js for $name", ({ analogRaw, d2High }) => {
    const result = comparePeripheralMix({ analogRaw, d2High });

    expect(result.differences.join("\n\n")).toBe("");
    expect(result.pass).toBe(true);
    expect(result.avrts.completed).toBe(true);
    expect(result.avr8js.completed).toBe(true);
  });
});
