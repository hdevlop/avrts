/**
 * avrts — a TypeScript ATmega328P (Arduino Uno/Nano) simulator.
 * Public API leads with the AVR(...) facade; advanced exports follow.
 */
import { AVR } from "./avr";

export * from "./avr";
export * from "./browser-runtime";
export * from "./cpu";
export * from "./core";
export * from "./loader";
export * from "./peripherals";
export * from "./circuit";
export * from "./component-bus";
export * from "./adapters";
export type * from "./snapshot";

// Minimal dev entry: `bun run src/index.ts` prints a readiness line.
if (import.meta.main) {
  console.log("avrts ready —", AVR().status());
}
