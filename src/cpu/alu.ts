import type { CPU } from "./cpu";
import { SREG_ADDR } from "./constants";

// SREG bit masks (positions per Sreg): C,Z,N,V,S,H,T,I.
export const SREG_C = 1 << 0;
export const SREG_Z = 1 << 1;
export const SREG_N = 1 << 2;
export const SREG_V = 1 << 3;
export const SREG_S = 1 << 4;
export const SREG_H = 1 << 5;
export const SREG_T = 1 << 6;
export const SREG_I = 1 << 7;

// Bits written by add8/sub8 (all arithmetic flags; T and I preserved).
export const SREG_ARITH_MASK = SREG_C | SREG_Z | SREG_N | SREG_V | SREG_S | SREG_H;
export const SREG_WORD_MASK = SREG_C | SREG_Z | SREG_N | SREG_V | SREG_S;

/** 5-bit register at bits 8..4 (R0..R31) - destination for most ops, source for OUT/ST. */
export function regD5(opcode: number): number {
  return (opcode >> 4) & 0x1f;
}

/** 5-bit source register: bit 9 (high) + bits 3..0 (low). */
export function regR5(opcode: number): number {
  return (opcode & 0x0f) | ((opcode >> 5) & 0x10);
}

/** 4-bit register field for immediate ops, mapped onto R16..R31. */
export function regD4(opcode: number): number {
  return 16 + ((opcode >> 4) & 0x0f);
}

/** 8-bit immediate (LDI/SUBI/...): bits 11..8 (high nibble) + bits 3..0 (low nibble). */
export function imm8(opcode: number): number {
  return (opcode & 0x0f) | ((opcode >> 4) & 0xf0);
}

/** 6-bit I/O address (IN/OUT): bits 10..9 (high) + bits 3..0 (low). */
export function ioAddr6(opcode: number): number {
  return (opcode & 0x0f) | ((opcode >> 5) & 0x30);
}

/** 5-bit I/O address (SBI/CBI/SBIC/SBIS), bits 7..3 - only the low 32 I/O registers. */
export function ioAddr5(opcode: number): number {
  return (opcode >> 3) & 0x1f;
}

/** Bit number operand, bits 2..0. */
export function bitNum(opcode: number): number {
  return opcode & 0x07;
}

/** 6-bit displacement q (LDD/STD): bits {13,11,10} (high) + bits 2..0 (low). */
export function dispQ(opcode: number): number {
  return (opcode & 0x07) | ((opcode >> 7) & 0x18) | ((opcode >> 8) & 0x20);
}

/** Sign-extended 12-bit relative offset (RJMP/RCALL). */
export function signed12(opcode: number): number {
  const k = opcode & 0x0fff;
  return k >= 0x800 ? k - 0x1000 : k;
}

/** Sign-extended 7-bit relative offset (conditional branches), bits 9..3. */
export function signed7(opcode: number): number {
  const k = (opcode >> 3) & 0x7f;
  return k >= 0x40 ? k - 0x80 : k;
}

/** Interpret a byte as a signed 8-bit value. */
export function signed8(value: number): number {
  return value < 0x80 ? value : value - 0x100;
}

/** Absolute address for the 32-bit JMP/CALL (second word holds bits 15..0). */
export function farAddr(cpu: CPU, opcode: number): number {
  const high = ((opcode & 0x01f0) >> 3) | (opcode & 0x0001);
  return (high << 16) | cpu.flash[cpu.pc + 1]!;
}

/** True for the four 32-bit instructions - needed for correct skip-by-2-words. */
export function isTwoWordOpcode(opcode: number): boolean {
  const jc = opcode & 0xfe0e;
  if (jc === 0x940c || jc === 0x940e) return true; // JMP / CALL
  const ls = opcode & 0xfe0f;
  return ls === 0x9000 || ls === 0x9200; // LDS / STS
}

/** Unsigned/signed 8x8 multiply into R1:R0; sets C (product bit 15) and Z. */
export function multiply(cpu: CPU, a: number, b: number, fractional: boolean): void {
  const product = a * b;
  const result = (fractional ? product << 1 : product) & 0xffff;
  cpu.data[0] = result & 0xff;
  cpu.data[1] = (result >> 8) & 0xff;
  cpu.sreg.C = ((product >> 15) & 1) === 1;
  cpu.sreg.Z = result === 0;
  cpu.pc += 1;
  cpu.cycles += 2;
}

/** 8-bit add with optional carry-in; sets H,S,V,N,Z,C. Returns the masked result. */
export function add8(cpu: CPU, d: number, r: number, carryIn: number): number {
  const sum = d + r + carryIn;
  const result = sum & 0xff;
  const n = (result & 0x80) !== 0;
  const v = (~(d ^ r) & (d ^ result) & 0x80) !== 0;
  const flags =
    ((d & 0x0f) + (r & 0x0f) + carryIn > 0x0f ? SREG_H : 0) |
    (v ? SREG_V : 0) |
    (n ? SREG_N : 0) |
    (result === 0 ? SREG_Z : 0) |
    (sum > 0xff ? SREG_C : 0) |
    (n !== v ? SREG_S : 0);
  const sreg = cpu.sreg;
  sreg.value = (sreg.value & ~SREG_ARITH_MASK) | flags;
  return result;
}

/**
 * 8-bit subtract with optional carry-in; sets H,S,V,N,Z,C. Returns the result.
 * When `carryUsed` (SBC/SBCI/CPC), Z is ANDed with its previous value for
 * correct multi-byte compares.
 */
export function sub8(
  cpu: CPU,
  d: number,
  r: number,
  carryIn: number,
  carryUsed: boolean,
): number {
  const result = (d - r - carryIn) & 0xff;
  const n = (result & 0x80) !== 0;
  const v = ((d ^ r) & (d ^ result) & 0x80) !== 0;
  const sreg = cpu.sreg;
  const prev = sreg.value;
  const zero = carryUsed ? result === 0 && (prev & SREG_Z) !== 0 : result === 0;
  const flags =
    ((d & 0x0f) - (r & 0x0f) - carryIn < 0 ? SREG_H : 0) |
    (v ? SREG_V : 0) |
    (n ? SREG_N : 0) |
    (zero ? SREG_Z : 0) |
    (d - r - carryIn < 0 ? SREG_C : 0) |
    (n !== v ? SREG_S : 0);
  sreg.value = (prev & ~SREG_ARITH_MASK) | flags;
  return result;
}

/** Flags for AND/OR/EOR/ANDI/ORI (V cleared, S = N; C and H preserved). */
export function logic(cpu: CPU, result: number): number {
  const masked = result & 0xff;
  const flags = ((masked & 0x80) !== 0 ? SREG_N | SREG_S : 0) | (masked === 0 ? SREG_Z : 0);
  const sreg = cpu.sreg;
  sreg.value = (sreg.value & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) | flags;
  return masked;
}

/** Flags for LSR/ROR/ASR (C from shifted-out bit, V = N xor C; H preserved). */
export function shiftFlags(cpu: CPU, result: number, carryOut: boolean): number {
  const masked = result & 0xff;
  const n = (masked & 0x80) !== 0;
  const v = n !== carryOut;
  const flags =
    (carryOut ? SREG_C : 0) |
    (n ? SREG_N : 0) |
    (masked === 0 ? SREG_Z : 0) |
    (v ? SREG_V : 0) |
    (n !== v ? SREG_S : 0);
  const sreg = cpu.sreg;
  sreg.value = (sreg.value & ~(SREG_C | SREG_N | SREG_Z | SREG_V | SREG_S)) | flags;
  return masked;
}

/** Execute SBIW: subtract a 6-bit immediate from R25:R24, R27:R26, R29:R28, or R31:R30. */
export function subtractWordImmediate(cpu: CPU, opcode: number): void {
  const d = 24 + (((opcode >> 4) & 0x03) * 2);
  const k = (opcode & 0x0f) | ((opcode >> 2) & 0x30);
  const before = pair(cpu, d);
  const result = (before - k) & 0xffff;
  setPair(cpu, d, result);
  const n = (result & 0x8000) !== 0;
  const v = (before & ~result & 0x8000) !== 0;
  const flags =
    (v ? SREG_V : 0) |
    (n ? SREG_N : 0) |
    (result === 0 ? SREG_Z : 0) |
    (before < k ? SREG_C : 0) |
    (n !== v ? SREG_S : 0);
  cpu.data[SREG_ADDR] = (cpu.data[SREG_ADDR]! & ~SREG_WORD_MASK) | flags;
  cpu.pc += 1;
  cpu.cycles += 2;
}

/** Read a 16-bit register pair (low at `low`, high at `low+1`). */
export function pair(cpu: CPU, low: number): number {
  return cpu.data[low]! | (cpu.data[low + 1]! << 8);
}

/** Write a 16-bit register pair. */
export function setPair(cpu: CPU, low: number, value: number): void {
  cpu.data[low] = value & 0xff;
  cpu.data[low + 1] = (value >> 8) & 0xff;
}
