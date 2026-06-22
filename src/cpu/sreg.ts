import { SREG_ADDR } from "./constants";
import type { FlagName } from "./types";

/** Bit position of each flag within SREG (data[0x5F]). */
export const SREG_BIT: Record<FlagName, number> = {
  C: 0, // carry
  Z: 1, // zero
  N: 2, // negative
  V: 3, // signed overflow
  S: 4, // sign (N xor V)
  H: 5, // half-carry
  T: 6, // bit-copy scratch
  I: 7, // global interrupt enable
};

/**
 * Typed accessor for the AVR status register (SREG, data[0x5F]).
 * Wraps the CPU's data array directly so flags and memory never drift apart.
 */
export class Sreg {
  constructor(private readonly data: Uint8Array) {}

  /** The whole 8-bit register. */
  get value(): number {
    return this.data[SREG_ADDR]!;
  }
  set value(v: number) {
    this.data[SREG_ADDR] = v & 0xff;
  }

  /** Read one flag. */
  get(flag: FlagName): boolean {
    return (this.value & (1 << SREG_BIT[flag])) !== 0;
  }

  /** Write one flag without disturbing the others. */
  set(flag: FlagName, on: boolean): void {
    const bit = 1 << SREG_BIT[flag];
    this.value = on ? this.value | bit : this.value & ~bit;
  }

  // --- Named accessors (readability for the instruction handlers) ---
  get C(): boolean { return this.get("C"); }
  set C(on: boolean) { this.set("C", on); }
  get Z(): boolean { return this.get("Z"); }
  set Z(on: boolean) { this.set("Z", on); }
  get N(): boolean { return this.get("N"); }
  set N(on: boolean) { this.set("N", on); }
  get V(): boolean { return this.get("V"); }
  set V(on: boolean) { this.set("V", on); }
  get S(): boolean { return this.get("S"); }
  set S(on: boolean) { this.set("S", on); }
  get H(): boolean { return this.get("H"); }
  set H(on: boolean) { this.set("H", on); }
  get T(): boolean { return this.get("T"); }
  set T(on: boolean) { this.set("T", on); }
  get I(): boolean { return this.get("I"); }
  set I(on: boolean) { this.set("I", on); }
}
