import type { PinInfo } from "./types";

/**
 * Arduino Uno / Nano (ATmega328P) digital-pin mapping.
 *   D0..D7  -> PD0..PD7
 *   D8..D13 -> PB0..PB5   (pin 13 = PB5 = the on-board LED)
 *   A0..A5  -> PC0..PC5   (pins 14..19 in digital numbering)
 */
export const PIN_MAP: Readonly<Record<number, PinInfo>> = {
  0: { port: "D", bit: 0 },
  1: { port: "D", bit: 1 },
  2: { port: "D", bit: 2 },
  3: { port: "D", bit: 3 },
  4: { port: "D", bit: 4 },
  5: { port: "D", bit: 5 },
  6: { port: "D", bit: 6 },
  7: { port: "D", bit: 7 },
  8: { port: "B", bit: 0 },
  9: { port: "B", bit: 1 },
  10: { port: "B", bit: 2 },
  11: { port: "B", bit: 3 },
  12: { port: "B", bit: 4 },
  13: { port: "B", bit: 5 },
  14: { port: "C", bit: 0 },
  15: { port: "C", bit: 1 },
  16: { port: "C", bit: 2 },
  17: { port: "C", bit: 3 },
  18: { port: "C", bit: 4 },
  19: { port: "C", bit: 5 },
};

/** Resolve an Arduino pin number to its port/bit, or throw for an unknown pin. */
export function pinInfo(pin: number): PinInfo {
  const info = PIN_MAP[pin];
  if (!info) throw new Error(`Unknown pin ${pin} (valid digital pins: 0..19)`);
  return info;
}
