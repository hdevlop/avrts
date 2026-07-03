// Guarded fast blocks: hand-written batch executors for exact code shapes that
// dominate real firmware (avr-libc helpers, Arduino busy-waits, compiler loop
// idioms). Each block is a classifier/guard/runner triple:
//
//   - the classifier recognizes the first opcode of a candidate shape;
//   - the guard proves the surrounding opcodes match the exact shape;
//   - the runner executes the whole loop/sequence in one host dispatch, leaving
//     the machine bit-identical to instruction-by-instruction execution.
//
// Every runner declines (returns false) rather than run when a clock event,
// cycle listener, or enabled pending interrupt could observe the skipped span
// (see CPU.canRunFastBlock / CPU.bulkIdleLoopIterations). CPU keeps only the
// dispatch skeleton: the per-PC kind cache and tryRunFastBlock, which calls
// classifyFastBlock/runFastBlock here. Like generated/cores.ts, this module is
// free functions taking the CPU instance.

import type { CPU } from "./cpu";
import { DATA_SIZE, SRAM_START, SREG_ADDR } from "./constants";
import {
  SREG_ARITH_MASK,
  SREG_C,
  SREG_H,
  SREG_I,
  SREG_N,
  SREG_S,
  SREG_T,
  SREG_V,
  SREG_WORD_MASK,
  SREG_Z,
  add8,
  dispQ,
  imm8,
  ioAddr6,
  regD4,
  regD5,
  regR5,
  shiftFlags,
  sub8,
} from "./alu";
import { runGeneratedUdivmodsi4CfgBlock } from "./generated/cores";
import type { ProfileRunState } from "./types";

export const FAST_BLOCK_UNKNOWN = 0;
export const FAST_BLOCK_NONE = 1;
const FAST_BLOCK_RJMP_SELF = 2;
const FAST_BLOCK_ZERO_SBIW_BREQ = 3;
const FAST_BLOCK_SHIFT_LEFT_DEC = 4;
const FAST_BLOCK_SHIFT_RIGHT_DEC = 5;
const FAST_BLOCK_ARDUINO_MICROS = 6;
const FAST_BLOCK_SUBCMP_RUN = 7;
const FAST_BLOCK_UDIVMODSI4_LOOP = 8;
const FAST_BLOCK_UMULHISI3 = 9;
const FAST_BLOCK_POLL_WAIT = 10;
const FAST_BLOCK_STRCPY_ZX = 11;
const FAST_BLOCK_SBIW_DEC = 12;
const FAST_BLOCK_UTOA_COMMON_LOOP = 13;
const FAST_BLOCK_SOFTFLOAT_RIGHT_INC = 14;
const FAST_BLOCK_FP_SPLITA_COMMON = 15;
const FAST_BLOCK_FP_SPLIT3_COMMON = 16;
const FAST_BLOCK_SERIAL_BUFFER_WAIT = 17;

// Minimum straight-line subtract/compare run length worth executing as one block
// (the Arduino delay() 64-bit compare chain is 8 long).
const SUBCMP_RUN_MIN = 3;

// Subtract/compare-class descriptors (0 = not in the class).
const SUBCMP_SUB = 1;
const SUBCMP_SBC = 2;
const SUBCMP_CP = 3;
const SUBCMP_CPC = 4;
const SUBCMP_SUBI = 5;
const SUBCMP_SBCI = 6;
const SUBCMP_CPI = 7;

const FAST_BLOCK_PROFILE_KINDS: readonly ProfileRunState["blockKind"][] = [
  undefined,
  undefined,
  "rjmp-self",
  "zero-sbiw-breq",
  "shift-left-dec",
  "shift-right-dec",
  "arduino-micros",
  "subcmp-run",
  "udivmodsi4-loop",
  "umulhisi3",
  "poll-wait",
  "strcpy-zx",
  "sbiw-dec",
  "utoa-common-loop",
  "softfloat-right-inc",
  "fp-splitA-common",
  "fp-split3-common",
  "serial-buffer-wait",
];

/** Profile label for a cached fast-block kind (see CPU.profileFastBlock). */
export function fastBlockProfileKind(kind: number): ProfileRunState["blockKind"] {
  return FAST_BLOCK_PROFILE_KINDS[kind];
}

/** Classify the fast-block shape starting at `pc` (cached per PC by the CPU). */
export function classifyFastBlock(cpu: CPU, pc: number, opcode: number): number {
  if (opcode === 0xcfff) return FAST_BLOCK_RJMP_SELF;
  // Short backward RJMP closing a peripheral busy-wait poll (LDS rd,addr;
  // SBRC/SBRS rd,b; RJMP back). Triggered from the rjmp arm only for the exact
  // offsets a poll loop produces, so it never taxes ordinary RJMPs.
  if ((opcode & 0xf000) === 0xc000) {
    if (isPollWaitLoop(cpu, pc, opcode)) return FAST_BLOCK_POLL_WAIT;
    return isSerialBufferWaitLoop(cpu, pc, opcode) ? FAST_BLOCK_SERIAL_BUFFER_WAIT : FAST_BLOCK_NONE;
  }
  if ((opcode & 0xff00) === 0x9700) {
    if (cpu.flash[pc + 1] === 0xf3f1) return FAST_BLOCK_ZERO_SBIW_BREQ;
    return isSbiwDecLoop(cpu, pc, opcode) ? FAST_BLOCK_SBIW_DEC : FAST_BLOCK_NONE;
  }
  if ((opcode & 0xfc00) === 0x0c00) {
    if (opcode === 0x0f88 && isUtoaCommonLoop(cpu, pc)) return FAST_BLOCK_UTOA_COMMON_LOOP;
    if (opcode === 0x0f88 && isFpSplitACommonBlock(cpu, pc)) return FAST_BLOCK_FP_SPLITA_COMMON;
    return isShiftLeftDecLoop(cpu, pc, opcode) ? FAST_BLOCK_SHIFT_LEFT_DEC : FAST_BLOCK_NONE;
  }
  if ((opcode & 0xfe0f) === 0x9406) {
    if (opcode === 0x9546 && isSoftFloatRightIncLoop(cpu, pc)) {
      return FAST_BLOCK_SOFTFLOAT_RIGHT_INC;
    }
    return isShiftRightDecLoop(cpu, pc, opcode) ? FAST_BLOCK_SHIFT_RIGHT_DEC : FAST_BLOCK_NONE;
  }
  if (opcode === 0xb73f) {
    return isArduinoMicrosBlock(cpu, pc) ? FAST_BLOCK_ARDUINO_MICROS : FAST_BLOCK_NONE;
  }
  if ((opcode & 0xfc00) === 0x1800) {
    return subCmpRunLength(cpu, pc) >= SUBCMP_RUN_MIN ? FAST_BLOCK_SUBCMP_RUN : FAST_BLOCK_NONE;
  }
  if (opcode === 0x1f66) {
    return isUdivmodsi4LoopBlock(cpu, pc) ? FAST_BLOCK_UDIVMODSI4_LOOP : FAST_BLOCK_NONE;
  }
  if (opcode === 0x9fa2) {
    return isUmulhisi3Block(cpu, pc) ? FAST_BLOCK_UMULHISI3 : FAST_BLOCK_NONE;
  }
  if ((opcode & 0xfe0f) === 0x9001) {
    return isStrcpyZxBlock(cpu, pc, opcode) ? FAST_BLOCK_STRCPY_ZX : FAST_BLOCK_NONE;
  }
  if (opcode === 0xfd57) {
    return isFpSplit3CommonBlock(cpu, pc) ? FAST_BLOCK_FP_SPLIT3_COMMON : FAST_BLOCK_NONE;
  }
  return FAST_BLOCK_NONE;
}

/** Dispatch a classified fast-block kind. Returns false to fall back to ticks. */
export function runFastBlock(
  cpu: CPU,
  kind: number,
  pc: number,
  opcode: number,
  target: number,
): boolean {
  switch (kind) {
    case FAST_BLOCK_RJMP_SELF:
      return runRjmpSelfLoopBlock(cpu, pc, target);
    case FAST_BLOCK_ZERO_SBIW_BREQ:
      return runZeroSbiwBreqLoopBlock(cpu, pc, opcode, target);
    case FAST_BLOCK_SBIW_DEC:
      return runSbiwDecLoopBlock(cpu, pc, opcode, target);
    case FAST_BLOCK_SHIFT_LEFT_DEC:
      return runShiftLeftDecLoopBlock(cpu, pc, opcode, target);
    case FAST_BLOCK_SHIFT_RIGHT_DEC:
      return runShiftRightDecLoopBlock(cpu, pc, opcode, target);
    case FAST_BLOCK_ARDUINO_MICROS:
      return runArduinoMicrosBlock(cpu, pc, target);
    case FAST_BLOCK_SUBCMP_RUN:
      return runSubCmpRunBlock(cpu, pc, target);
    case FAST_BLOCK_UDIVMODSI4_LOOP:
      if (cpu.udivmodsi4RegionMode === "semantic-direct") {
        return runSemanticUdivmodsi4Block(cpu, pc, target);
      }
      if (cpu.udivmodsi4RegionMode === "generated-cfg") {
        return runGeneratedUdivmodsi4CfgBlock(cpu, pc, target);
      }
      return runUdivmodsi4LoopBlock(cpu, pc, target);
    case FAST_BLOCK_UMULHISI3:
      return runUmulhisi3Block(cpu, pc, target);
    case FAST_BLOCK_POLL_WAIT:
      return runPollWaitBlock(cpu, pc, target);
    case FAST_BLOCK_STRCPY_ZX:
      return runStrcpyZxBlock(cpu, pc, opcode, target);
    case FAST_BLOCK_UTOA_COMMON_LOOP:
      return runUtoaCommonLoopBlock(cpu, pc, target);
    case FAST_BLOCK_SOFTFLOAT_RIGHT_INC:
      return runSoftFloatRightIncLoopBlock(cpu, pc, target);
    case FAST_BLOCK_FP_SPLITA_COMMON:
      return runFpSplitACommonBlock(cpu, pc, target);
    case FAST_BLOCK_FP_SPLIT3_COMMON:
      return runFpSplit3CommonBlock(cpu, pc, target);
    case FAST_BLOCK_SERIAL_BUFFER_WAIT:
      return runSerialBufferWaitBlock(cpu, pc, target);
    default:
      return false;
  }
}

/**
 * avr-libc/string copy loop shape:
 *   LD rN,Z+; ST X+,rN; AND rN,rN; BRNE loop
 *
 * This only batches SRAM-to-SRAM copies with no hooks on the touched bytes, so
 * no read/write side effects or IO/register aliasing are skipped.
 */
function isStrcpyZxBlock(cpu: CPU, pc: number, opcode: number): boolean {
  const register = regD5(opcode);
  const store = cpu.flash[pc + 1]!;
  const test = cpu.flash[pc + 2]!;
  const branch = cpu.flash[pc + 3]!;
  return (
    (store & 0xfe0f) === 0x920d &&
    regD5(store) === register &&
    (test & 0xfc00) === 0x2000 &&
    regD5(test) === register &&
    regR5(test) === register &&
    (branch & 0xfc07) === 0xf401 &&
    ((branch >> 3) & 0x7f) === 0x7c
  );
}

function runStrcpyZxBlock(cpu: CPU, pc: number, opcode: number, target: number): boolean {
  const register = regD5(opcode);
  const data = cpu.data;
  const x0 = data[26]! | (data[27]! << 8);
  const z0 = data[30]! | (data[31]! << 8);
  const copied: number[] = [];
  const pendingWrites = new Map<number, number>();

  for (let offset = 0; offset <= DATA_SIZE; offset += 1) {
    const src = (z0 + offset) & 0xffff;
    const dest = (x0 + offset) & 0xffff;
    if (
      src < SRAM_START ||
      dest < SRAM_START ||
      src >= DATA_SIZE ||
      dest >= DATA_SIZE ||
      cpu.readHooks[src] !== undefined ||
      cpu.writeHooks[dest] !== undefined
    ) {
      return false;
    }

    const value = pendingWrites.get(src) ?? data[src]!;
    copied.push(value);
    pendingWrites.set(dest, value);
    if (value === 0) break;
  }

  if (copied.length <= 1 || copied[copied.length - 1] !== 0) return false;
  const blockCycles = copied.length * 7 - 1;
  if (!cpu.canRunFastBlock(target, blockCycles)) return false;

  for (let offset = 0; offset < copied.length; offset += 1) {
    data[(x0 + offset) & 0xffff] = copied[offset]!;
  }
  const x = (x0 + copied.length) & 0xffff;
  const z = (z0 + copied.length) & 0xffff;
  data[26] = x & 0xff;
  data[27] = x >> 8;
  data[30] = z & 0xff;
  data[31] = z >> 8;
  data[register] = 0;
  data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) | SREG_Z;
  cpu._cycles += blockCycles;
  cpu.pc = pc + 4;
  return true;
}

/**
 * avr-libc's unsigned-to-ASCII helper inner loop:
 *   ADD r24,r24; ADC r25,r25; ADC r26,r26; CP r26,r20; BRCS skip
 *   SUB r26,r20; INC r24; SUBI r21,0x10; BRNE loop
 */
function isUtoaCommonLoop(cpu: CPU, pc: number): boolean {
  const flash = cpu.flash;
  const exact = [
    0x0f88, // ADD r24,r24
    0x1f99, // ADC r25,r25
    0x1faa, // ADC r26,r26
    0x17a4, // CP r26,r20
    0xf010, // BRCS +2
    0x1ba4, // SUB r26,r20
    0x9583, // INC r24
    0x5150, // SUBI r21,0x10
    0xf7b9, // BRNE -9
  ];
  for (let offset = 0; offset < exact.length; offset += 1) {
    if (flash[pc + offset] !== exact[offset]) return false;
  }
  return true;
}

function runUtoaCommonLoopBlock(cpu: CPU, pc: number, target: number): boolean {
  const data = cpu.data;
  const counter = data[21]!;
  if ((counter & 0x0f) !== 0) return false;

  const loops = counter === 0 ? 16 : counter >> 4;
  const maxCycles = loops * 10 - 1;
  if (!cpu.canRunFastBlock(target, maxCycles)) return false;

  let elapsed = 0;
  for (let iteration = 0; iteration < loops; iteration += 1) {
    data[24] = add8(cpu, data[24]!, data[24]!, 0);
    elapsed += 1;
    data[25] = add8(cpu, data[25]!, data[25]!, (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0);
    elapsed += 1;
    data[26] = add8(cpu, data[26]!, data[26]!, (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0);
    elapsed += 1;

    sub8(cpu, data[26]!, data[20]!, 0, false);
    elapsed += 1;
    if ((data[SREG_ADDR]! & SREG_C) !== 0) {
      elapsed += 2; // BRCS taken over SUB/INC.
    } else {
      elapsed += 1; // BRCS not taken.
      data[26] = sub8(cpu, data[26]!, data[20]!, 0, false);
      elapsed += 1;
      const result = (data[24]! + 1) & 0xff;
      data[24] = result;
      const v = result === 0x80;
      const n = (result & 0x80) !== 0;
      const flags =
        (v ? SREG_V : 0) |
        (n ? SREG_N : 0) |
        (result === 0 ? SREG_Z : 0) |
        (n !== v ? SREG_S : 0);
      data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) | flags;
      elapsed += 1;
    }

    data[21] = sub8(cpu, data[21]!, 0x10, 0, false);
    elapsed += 1;
    elapsed += data[21] === 0 ? 1 : 2;
  }

  cpu._cycles += elapsed;
  cpu.pc = pc + 9;
  return true;
}

/**
 * Common no-branch exit from avr-libc `__fp_splitA`:
 *   ADD r24,r24; BST r25,7; ADC r25,r25; BREQ rare; CPI r25,0xff;
 *   BREQ rare; ROR r24; RET
 */
function isFpSplitACommonBlock(cpu: CPU, pc: number): boolean {
  const flash = cpu.flash;
  const exact = [
    0x0f88, // ADD r24,r24
    0xfb97, // BST r25,7
    0x1f99, // ADC r25,r25
    0xf061, // BREQ +12
    0x3f9f, // CPI r25,0xff
    0xf079, // BREQ +15
    0x9587, // ROR r24
    0x9508, // RET
  ];
  for (let offset = 0; offset < exact.length; offset += 1) {
    if (flash[pc + offset] !== exact[offset]) return false;
  }
  return true;
}

function runFpSplitACommonBlock(cpu: CPU, pc: number, target: number): boolean {
  const data = cpu.data;
  const r24 = data[24]!;
  const r25 = data[25]!;
  const addSum = r24 + r24;
  const adcSum = r25 + r25 + (addSum > 0xff ? 1 : 0);
  const adcResult = adcSum & 0xff;
  if (adcResult === 0 || adcResult === 0xff) return false;

  const blockCycles = 11;
  if (!cpu.canRunFastBlock(target, blockCycles)) return false;

  data[24] = add8(cpu, r24, r24, 0);
  data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_T) | ((r25 & 0x80) !== 0 ? SREG_T : 0);
  data[25] = add8(cpu, r25, r25, (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0);
  sub8(cpu, data[25]!, 0xff, 0, false);
  data[24] = shiftFlags(
    cpu,
    (data[24]! >> 1) | ((data[SREG_ADDR]! & SREG_C) !== 0 ? 0x80 : 0),
    (data[24]! & 1) !== 0,
  );
  cpu._cycles += blockCycles;
  cpu.pc = cpu.popWord();
  return true;
}

/**
 * Common no-branch exit from avr-libc `__fp_split3`, including its
 * `__fp_splitA` tail:
 *   SBRC r21,7; SUBI r25,0x80; ADD r20,r20; ADC r21,r21; BREQ rare;
 *   CPI r21,0xff; BREQ rare; ROR r20; then the `__fp_splitA` common block.
 */
function isFpSplit3CommonBlock(cpu: CPU, pc: number): boolean {
  const flash = cpu.flash;
  const exact = [
    0xfd57, // SBRC r21,7
    0x5890, // SUBI r25,0x80
    0x0f44, // ADD r20,r20
    0x1f55, // ADC r21,r21
    0xf059, // BREQ +11
    0x3f5f, // CPI r21,0xff
    0xf071, // BREQ +14
    0x9547, // ROR r20
    0x0f88, // ADD r24,r24
    0xfb97, // BST r25,7
    0x1f99, // ADC r25,r25
    0xf061, // BREQ +12
    0x3f9f, // CPI r25,0xff
    0xf079, // BREQ +15
    0x9587, // ROR r24
    0x9508, // RET
  ];
  for (let offset = 0; offset < exact.length; offset += 1) {
    if (flash[pc + offset] !== exact[offset]) return false;
  }
  return true;
}

function runFpSplit3CommonBlock(cpu: CPU, pc: number, target: number): boolean {
  const data = cpu.data;
  const r20 = data[20]!;
  const r21 = data[21]!;
  const r24 = data[24]!;
  const r25 = data[25]!;

  const split3R25 = (r21 & 0x80) !== 0 ? (r25 - 0x80) & 0xff : r25;
  const split3Carry = r20 + r20 > 0xff ? 1 : 0;
  const split3R21 = (r21 + r21 + split3Carry) & 0xff;
  if (split3R21 === 0 || split3R21 === 0xff) return false;

  const splitAAddSum = r24 + r24;
  const splitAAdcResult = (split3R25 + split3R25 + (splitAAddSum > 0xff ? 1 : 0)) & 0xff;
  if (splitAAdcResult === 0 || splitAAdcResult === 0xff) return false;

  const blockCycles = 19;
  if (!cpu.canRunFastBlock(target, blockCycles)) return false;

  if ((r21 & 0x80) !== 0) {
    data[25] = sub8(cpu, r25, 0x80, 0, false);
  }
  data[20] = add8(cpu, r20, r20, 0);
  data[21] = add8(cpu, r21, r21, (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0);
  sub8(cpu, data[21]!, 0xff, 0, false);
  data[20] = shiftFlags(
    cpu,
    (data[20]! >> 1) | ((data[SREG_ADDR]! & SREG_C) !== 0 ? 0x80 : 0),
    (data[20]! & 1) !== 0,
  );

  data[24] = add8(cpu, r24, r24, 0);
  data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_T) | ((data[25]! & 0x80) !== 0 ? SREG_T : 0);
  data[25] = add8(cpu, data[25]!, data[25]!, (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0);
  sub8(cpu, data[25]!, 0xff, 0, false);
  data[24] = shiftFlags(
    cpu,
    (data[24]! >> 1) | ((data[SREG_ADDR]! & SREG_C) !== 0 ? 0x80 : 0),
    (data[24]! & 1) !== 0,
  );
  cpu._cycles += blockCycles;
  cpu.pc = cpu.popWord();
  return true;
}

/**
 * avr-libc's 32-bit unsigned divide/modulo helper loop, entered at
 * `__udivmodsi4_ep` after setup jumps over the body. This exact register-only
 * shape dominates the realistic sensor-format fixture through Arduino's
 * decimal `Print::printNumber` path.
 */
function isUdivmodsi4LoopBlock(cpu: CPU, pc: number): boolean {
  if (pc < 13) return false;
  const flash = cpu.flash;
  const body = pc - 13;
  const exact: Array<[number, number]> = [
    [body + 0, 0x1faa], // ADC r26,r26
    [body + 1, 0x1fbb], // ADC r27,r27
    [body + 2, 0x1fee], // ADC r30,r30
    [body + 3, 0x1fff], // ADC r31,r31
    [body + 4, 0x17a2], // CP r26,r18
    [body + 5, 0x07b3], // CPC r27,r19
    [body + 6, 0x07e4], // CPC r30,r20
    [body + 7, 0x07f5], // CPC r31,r21
    [body + 8, 0xf020], // BRCS +4, to ep
    [body + 9, 0x1ba2], // SUB r26,r18
    [body + 10, 0x0bb3], // SBC r27,r19
    [body + 11, 0x0be4], // SBC r30,r20
    [body + 12, 0x0bf5], // SBC r31,r21
    [pc + 0, 0x1f66], // ADC r22,r22
    [pc + 1, 0x1f77], // ADC r23,r23
    [pc + 2, 0x1f88], // ADC r24,r24
    [pc + 3, 0x1f99], // ADC r25,r25
    [pc + 4, 0x941a], // DEC r1
    [pc + 5, 0xf769], // BRNE -19, to body
  ];
  for (const [addr, opcode] of exact) {
    if (flash[addr] !== opcode) return false;
  }
  return true;
}

function runUdivmodsi4LoopBlock(cpu: CPU, pc: number, target: number): boolean {
  const loops = cpu.data[1] === 0 ? 256 : cpu.data[1]!;
  // Conservative upper bound: final ep is 6 cycles; each prior iteration can
  // take ep(7) + body(13). If an event lands in that window, decline.
  const maxCycles = 6 + (loops - 1) * 20;
  if (!cpu.canRunFastBlock(target, maxCycles)) return false;

  const data = cpu.data;
  let elapsed = 0;
  const adcSelf = (register: number): void => {
    const dv = data[register]!;
    const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
    const sum = dv + dv + carry;
    const result = sum & 0xff;
    const n = (result & 0x80) !== 0;
    const v = ((dv ^ result) & 0x80) !== 0;
    const flags =
      ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
      (v ? SREG_V : 0) |
      (n ? SREG_N : 0) |
      (result === 0 ? SREG_Z : 0) |
      (sum > 0xff ? SREG_C : 0) |
      (n !== v ? SREG_S : 0);
    data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
    data[register] = result;
    elapsed += 1;
  };
  const subOp = (d: number, r: number, carryUsed: boolean, writeback: boolean): void => {
    const dv = data[d]!;
    const rv = data[r]!;
    const carry = carryUsed && (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
    const prev = data[SREG_ADDR]!;
    const result = (dv - rv - carry) & 0xff;
    const n = (result & 0x80) !== 0;
    const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
    const flags =
      ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
      (v ? SREG_V : 0) |
      (n ? SREG_N : 0) |
      ((carryUsed ? result === 0 && (prev & SREG_Z) !== 0 : result === 0) ? SREG_Z : 0) |
      (dv - rv - carry < 0 ? SREG_C : 0) |
      (n !== v ? SREG_S : 0);
    data[SREG_ADDR] = (prev & ~SREG_ARITH_MASK) | flags;
    if (writeback) data[d] = result;
    elapsed += 1;
  };

  while (true) {
    adcSelf(22);
    adcSelf(23);
    adcSelf(24);
    adcSelf(25);

    const dec = (data[1]! - 1) & 0xff;
    data[1] = dec;
    const n = (dec & 0x80) !== 0;
    const v = dec === 0x7f;
    data[SREG_ADDR] =
      (data[SREG_ADDR]! & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) |
      (v ? SREG_V : 0) |
      (n ? SREG_N : 0) |
      (dec === 0 ? SREG_Z : 0) |
      (n !== v ? SREG_S : 0);
    elapsed += 1;
    if (dec === 0) {
      elapsed += 1; // BRNE not taken
      break;
    }
    elapsed += 2; // BRNE taken

    adcSelf(26);
    adcSelf(27);
    adcSelf(30);
    adcSelf(31);
    subOp(26, 18, false, false);
    subOp(27, 19, true, false);
    subOp(30, 20, true, false);
    subOp(31, 21, true, false);

    if ((data[SREG_ADDR]! & SREG_C) !== 0) {
      elapsed += 2; // BRCS taken to ep
      continue;
    }
    elapsed += 1; // BRCS not taken
    subOp(26, 18, false, true);
    subOp(27, 19, true, true);
    subOp(30, 20, true, true);
    subOp(31, 21, true, true);
  }

  cpu._cycles += elapsed;
  cpu.pc = pc + 6;
  return true;
}

function runSemanticUdivmodsi4Block(cpu: CPU, pc: number, target: number): boolean {
  const data = cpu.data;
  const divisor =
    (data[18]! | (data[19]! << 8) | (data[20]! << 16) | (data[21]! << 24)) >>> 0;
  const remainder = (data[26]! | (data[27]! << 8) | (data[30]! << 16) | (data[31]! << 24)) >>> 0;

  if (
    data[1] !== 33 ||
    divisor === 0 ||
    remainder !== 0 ||
    (data[SREG_ADDR]! & SREG_C) !== 0
  ) {
    return runGeneratedUdivmodsi4CfgBlock(cpu, pc, target);
  }

  const maxCycles = 646; // 6 + 32 * 20, matching the generated-CFG guard.
  if (!cpu.canRunFastBlock(target, maxCycles)) return false;

  const dividend =
    (data[22]! | (data[23]! << 8) | (data[24]! << 16) | (data[25]! << 24)) >>> 0;
  const quotient = Math.floor(dividend / divisor) >>> 0;
  const modulo = (dividend - quotient * divisor) >>> 0;
  const complementedQuotient = ~quotient >>> 0;

  data[1] = 0;
  data[22] = complementedQuotient & 0xff;
  data[23] = (complementedQuotient >>> 8) & 0xff;
  data[24] = (complementedQuotient >>> 16) & 0xff;
  data[25] = (complementedQuotient >>> 24) & 0xff;
  data[26] = modulo & 0xff;
  data[27] = (modulo >>> 8) & 0xff;
  data[30] = (modulo >>> 16) & 0xff;
  data[31] = (modulo >>> 24) & 0xff;

  data[SREG_ADDR] =
    (data[SREG_ADDR]! & (SREG_I | SREG_T)) |
    SREG_Z |
    ((complementedQuotient >>> 24) & 0x10 ? SREG_H : 0);

  cpu._cycles += 550 + popcount32(quotient) * 3;
  cpu.pc = pc + 6;
  return true;
}

function popcount32(value: number): number {
  let bits = value >>> 0;
  let count = 0;
  while (bits !== 0) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

function isUmulhisi3Block(cpu: CPU, pc: number): boolean {
  const flash = cpu.flash;
  const exact: Array<[number, number]> = [
    [pc + 0, 0x9fa2], // MUL r26,r18
    [pc + 1, 0x01b0], // MOVW r22,r0
    [pc + 2, 0x9fb3], // MUL r27,r19
    [pc + 3, 0x01c0], // MOVW r24,r0
    [pc + 4, 0x9fa3], // MUL r26,r19
    [pc + 5, 0x0d70], // ADD r23,r0
    [pc + 6, 0x1d81], // ADC r24,r1
    [pc + 7, 0x2411], // EOR r1,r1
    [pc + 8, 0x1d91], // ADC r25,r1
    [pc + 9, 0x9fb2], // MUL r27,r18
    [pc + 10, 0x0d70], // ADD r23,r0
    [pc + 11, 0x1d81], // ADC r24,r1
    [pc + 12, 0x2411], // EOR r1,r1
    [pc + 13, 0x1d91], // ADC r25,r1
    [pc + 14, 0x9508], // RET
  ];
  for (const [addr, opcode] of exact) {
    if (flash[addr] !== opcode) return false;
  }
  return true;
}

function runUmulhisi3Block(cpu: CPU, pc: number, target: number): boolean {
  const blockCycles = 22;
  if (!cpu.canRunFastBlock(target, blockCycles)) return false;

  const data = cpu.data;
  const al = data[26]!;
  const ah = data[27]!;
  const bl = data[18]!;
  const bh = data[19]!;

  const p0 = al * bl;
  const p1 = ah * bh;
  const p2 = al * bh;
  const p3 = ah * bl;

  let r23 = (p0 >> 8) + (p2 & 0xff);
  let carry = r23 > 0xff ? 1 : 0;
  r23 &= 0xff;
  let r24 = (p1 & 0xff) + (p2 >> 8) + carry;
  carry = r24 > 0xff ? 1 : 0;
  r24 &= 0xff;
  let r25 = (p1 >> 8) + carry;

  r23 += p3 & 0xff;
  carry = r23 > 0xff ? 1 : 0;
  r23 &= 0xff;
  r24 += (p3 >> 8) + carry;
  carry = r24 > 0xff ? 1 : 0;
  r24 &= 0xff;

  const beforeFinal = r25 & 0xff;
  const finalSum = beforeFinal + carry;
  r25 = finalSum & 0xff;
  const n = (r25 & 0x80) !== 0;
  const v = (~beforeFinal & r25 & 0x80) !== 0;

  data[0] = p3 & 0xff;
  data[1] = 0;
  data[22] = p0 & 0xff;
  data[23] = r23;
  data[24] = r24;
  data[25] = r25;
  data[SREG_ADDR] =
    (data[SREG_ADDR]! & ~SREG_ARITH_MASK) |
    ((beforeFinal & 0x0f) + carry > 0x0f ? SREG_H : 0) |
    (v ? SREG_V : 0) |
    (n ? SREG_N : 0) |
    (r25 === 0 ? SREG_Z : 0) |
    (finalSum > 0xff ? SREG_C : 0) |
    (n !== v ? SREG_S : 0);

  cpu._cycles += blockCycles;
  cpu.pc = cpu.popWord();
  return true;
}

/** Decode the subtract/compare class for the straight-line block. */
function subCmpKind(opcode: number): number {
  // Returns 0 if not in the class; otherwise a small descriptor encoding
  // immediate/carry/writeback. Mirrors the SUB/SBC/CP/CPC/SUBI/SBCI/CPI arms.
  const top = opcode & 0xfc00;
  if (top === 0x1800) return SUBCMP_SUB;
  if (top === 0x0800) return SUBCMP_SBC;
  if (top === 0x1400) return SUBCMP_CP;
  if (top === 0x0400) return SUBCMP_CPC;
  const topN = opcode & 0xf000;
  if (topN === 0x5000) return SUBCMP_SUBI;
  if (topN === 0x4000) return SUBCMP_SBCI;
  if (topN === 0x3000) return SUBCMP_CPI;
  return 0;
}

/** Count consecutive subtract/compare-class instructions starting at `pc`. */
function subCmpRunLength(cpu: CPU, pc: number): number {
  let n = 0;
  const flash = cpu.flash;
  while (pc + n < flash.length && subCmpKind(flash[pc + n]!) !== 0) n += 1;
  return n;
}

/**
 * Step 4 straight-line block: a run of register/immediate subtract & compare
 * instructions (no memory, IO, or control flow) executed in one host dispatch
 * instead of one ladder traversal each. The Arduino `delay()` 64-bit elapsed
 * compare is the motivating shape (`SUB; SBC; SBC; SBC; CPI; SBCI; CPC; CPC`).
 * Flag math is the same `sub8` the handlers use, so it is provably identical.
 */
function runSubCmpRunBlock(cpu: CPU, pc: number, target: number): boolean {
  const length = subCmpRunLength(cpu, pc);
  if (length < SUBCMP_RUN_MIN) return false;
  // Each instruction is one cycle; refuse to cross the target, a clock event,
  // a cycle listener, or an enabled pending interrupt (canRunFastBlock).
  if (!cpu.canRunFastBlock(target, length)) return false;

  const data = cpu.data;
  for (let i = 0; i < length; i += 1) {
    const opcode = cpu.flash[pc + i]!;
    const kind = subCmpKind(opcode);
    const immediate = kind === SUBCMP_SUBI || kind === SUBCMP_SBCI || kind === SUBCMP_CPI;
    const carryUsed = kind === SUBCMP_SBC || kind === SUBCMP_SBCI || kind === SUBCMP_CPC;
    const writeback = kind !== SUBCMP_CP && kind !== SUBCMP_CPC && kind !== SUBCMP_CPI;
    const d = immediate ? regD4(opcode) : regD5(opcode);
    const r = immediate ? imm8(opcode) : data[regR5(opcode)]!;
    const carryIn = carryUsed && (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
    const result = sub8(cpu, data[d]!, r, carryIn, carryUsed);
    if (writeback) data[d] = result;
  }
  cpu.pc = pc + length;
  cpu.cycles += length;
  return true;
}

/**
 * Bulk-skip the Arduino busy-wait shape that dominates serial-print and
 * analog-write: `SBIW pair,0; BREQ -2` while the pair is zero. This is a tiny
 * guarded block specialization, not a general instruction shortcut. It only
 * advances whole 4-cycle loop iterations and refuses to cross cycle listeners,
 * enabled pending interrupts, or the next scheduled clock event.
 */
function runZeroSbiwBreqLoopBlock(cpu: CPU, pc: number, opcode: number, target: number): boolean {
  const d = 24 + (((opcode >> 4) & 0x03) * 2);
  if (cpu.data[d] !== 0 || cpu.data[d + 1] !== 0) return false;

  const iterations = cpu.bulkIdleLoopIterations(target, 4);
  if (iterations <= 1) return false;

  cpu.data[SREG_ADDR] = (cpu.data[SREG_ADDR]! & ~SREG_WORD_MASK) | SREG_Z;
  cpu._cycles += iterations * 4;
  cpu.pc = pc;
  return true;
}

function isSbiwDecLoop(cpu: CPU, pc: number, opcode: number): boolean {
  const k = (opcode & 0x0f) | ((opcode >> 2) & 0x30);
  const branch = cpu.flash[pc + 1]!;
  return k === 1 && (branch & 0xfc07) === 0xf401 && ((branch >> 3) & 0x7f) === 0x7e;
}

function runSbiwDecLoopBlock(cpu: CPU, pc: number, opcode: number, target: number): boolean {
  const d = 24 + (((opcode >> 4) & 0x03) * 2);
  const before = cpu.data[d]! | (cpu.data[d + 1]! << 8);
  const iterations = before === 0 ? 0x10000 : before;
  const blockCycles = iterations * 4 - 1;
  if (!cpu.canRunFastBlock(target, blockCycles)) return false;

  cpu.data[d] = 0;
  cpu.data[d + 1] = 0;
  cpu.data[SREG_ADDR] = (cpu.data[SREG_ADDR]! & ~SREG_WORD_MASK) | SREG_Z;
  cpu._cycles += blockCycles;
  cpu.pc = pc + 2;
  return true;
}

/** Bulk-skip `RJMP -1` when nothing observable can happen before the target/event. */
function runRjmpSelfLoopBlock(cpu: CPU, pc: number, target: number): boolean {
  const iterations = cpu.bulkIdleLoopIterations(target, 2);
  if (iterations <= 1) return false;

  cpu._cycles += iterations * 2;
  cpu.pc = pc;
  return true;
}

/**
 * Recognize a peripheral busy-wait poll closed by this short backward RJMP:
 *   loopTop:  LDS  rd, addr   ; 2 words, second word is the data-space address
 *             SBRC/SBRS rd, b ; 1 word, tests a bit of the loaded register
 *   pc:       RJMP loopTop    ; this instruction (k = -4)
 * The body has no side effects — the polled address must have no read hook, so
 * the LDS is a pure data read — so spinning it changes nothing but cycles until
 * a scheduled clock event mutates `addr`. That is exactly the invariant the
 * bulk-skip blocks rely on (e.g. the analogRead `while (ADCSRA & _BV(ADSC))`).
 */
function isPollWaitLoop(cpu: CPU, pc: number, opcode: number): boolean {
  const k = opcode & 0x0fff;
  const top = pc + (k >= 0x800 ? k - 0x1000 : k) + 1;
  if (top < 0 || pc !== top + 3) return false;
  const flash = cpu.flash;
  const head = flash[top];
  if (head === undefined || (head & 0xfe0f) !== 0x9000) return false; // LDS rd,addr
  const addr = flash[top + 1];
  // A read hook could return a time-varying or side-effecting value; the skip
  // is only sound when the LDS reads the raw, event-mutated data byte.
  if (addr === undefined || cpu.readHooks[addr] !== undefined) return false;
  const test = flash[top + 2];
  if (test === undefined) return false;
  const isSkip = (test & 0xfe08) === 0xfc00 || (test & 0xfe08) === 0xfe00; // SBRC/SBRS
  if (!isSkip) return false;
  return ((test >> 4) & 0x1f) === ((head >> 4) & 0x1f); // SBRC/SBRS reg === LDS reg
}

/**
 * Bulk-skip the busy-wait poll recognized by `isPollWaitLoop`. Each traversal
 * is 5 cycles (RJMP 2 + LDS 2 + SBRC/SBRS no-skip 1) and returns to this RJMP,
 * so keeping `pc` here and advancing whole traversals leaves the machine
 * bit-identical to spinning. `bulkIdleLoopIterations` refuses to cross the
 * target, a scheduled clock event, a cycle listener, or an enabled pending
 * interrupt, so the byte cannot change inside the skipped span.
 */
function runPollWaitBlock(cpu: CPU, pc: number, target: number): boolean {
  // RJMP -4 closes a 3-word body: LDS (2 words) at top, SBRC/SBRS at top+2.
  const top = pc - 3;
  const flash = cpu.flash;
  const addr = flash[top + 1]!; // LDS data-space address
  const test = flash[top + 2]!; // SBRC/SBRS rd,b
  const bitSet = (cpu.data[addr]! & (1 << (test & 0x07))) !== 0;
  // The SBRC/SBRS tests the register the *next* LDS will reload, not the stale
  // one in registers now. If the current memory byte already satisfies the
  // skip (SBRC skips on bit clear, SBRS on bit set), the loop exits on the next
  // iteration — decline so the normal path reads it and falls through. Only
  // fast-forward while the byte still keeps the loop spinning.
  const willExit = (test & 0xfe08) === 0xfe00 ? bitSet : !bitSet;
  if (willExit) return false;

  const iterations = cpu.bulkIdleLoopIterations(target, 5);
  if (iterations <= 1) return false;

  cpu._cycles += iterations * 5;
  cpu.pc = pc;
  return true;
}

/**
 * Recognize the Arduino HardwareSerial::write ring-buffer wait:
 *   loopTop:  LDD  tail, Y+28
 *             CPSE tail, nextHead
 *             RJMP exit
 *             IN   tmp, SREG
 *             SBRC tmp, I
 *   pc:       RJMP loopTop
 *
 * With interrupts enabled and the TX ring full, the loop has no side effects
 * until a scheduled USART event lets the UDRE interrupt advance the tail.
 */
function isSerialBufferWaitLoop(cpu: CPU, pc: number, opcode: number): boolean {
  const k = opcode & 0x0fff;
  const top = pc + (k >= 0x800 ? k - 0x1000 : k) + 1;
  if (top < 0 || pc !== top + 5) return false;

  const flash = cpu.flash;
  const loadTail = flash[top]!;
  if ((loadTail & 0xd208) !== 0x8008) return false; // LDD rd,Y+q

  const compare = flash[top + 1]!;
  if (
    (compare & 0xfc00) !== 0x1000 || // CPSE rd,rr
    regD5(compare) !== regD5(loadTail) ||
    regR5(compare) === regD5(loadTail)
  ) {
    return false;
  }

  const exitJump = flash[top + 2]!;
  if ((exitJump & 0xf000) !== 0xc000 || (exitJump & 0x0800) !== 0) return false;

  const readSreg = flash[top + 3]!;
  if (
    (readSreg & 0xf800) !== 0xb000 || // IN rd,A
    ioAddr6(readSreg) !== SREG_ADDR - 0x20
  ) {
    return false;
  }

  const checkInterrupts = flash[top + 4]!;
  return (
    (checkInterrupts & 0xfe08) === 0xfc00 && // SBRC rd,bit
    regD5(checkInterrupts) === regD5(readSreg) &&
    (checkInterrupts & 0x07) === 7
  );
}

function runSerialBufferWaitBlock(cpu: CPU, pc: number, target: number): boolean {
  const top = pc - 5;
  const flash = cpu.flash;
  const loadTail = flash[top]!;
  const compare = flash[top + 1]!;
  const readSreg = flash[top + 3]!;
  const data = cpu.data;

  const tailAddr = ((data[28]! | (data[29]! << 8)) + dispQ(loadTail)) & 0xffff;
  if (tailAddr < SRAM_START || tailAddr >= DATA_SIZE || cpu.readHooks[tailAddr] !== undefined) {
    return false;
  }

  const tail = data[tailAddr]!;
  if (tail !== data[regR5(compare)]! || (data[SREG_ADDR]! & SREG_I) === 0) return false;

  const iterations = cpu.bulkIdleLoopIterations(target, 8);
  if (iterations <= 1) return false;

  data[regD5(loadTail)] = tail;
  data[regD5(readSreg)] = data[SREG_ADDR]!;
  cpu._cycles += iterations * 8;
  cpu.pc = pc;
  return true;
}

/**
 * Fast block for compiler-emitted counted left-shift loops:
 *   ADD rN,rN; ADC rN+1,rN+1; [ADC rN+2,rN+2; ADC rN+3,rN+3;] DEC rC; BRNE loop
 *
 * It is intentionally shape-checked at runtime and only runs the whole counted
 * loop when no event/interrupt/listener can observe the skipped instructions.
 */
function isShiftLeftDecLoop(cpu: CPU, pc: number, opcode: number): boolean {
  const firstReg = regD5(opcode);
  if (regR5(opcode) !== firstReg || firstReg > 28) return false;

  const flash = cpu.flash;
  const op1 = flash[pc + 1]!;
  if (!isAdcSelf(op1, firstReg + 1)) return false;

  const width = shiftLeftDecLoopWidth(cpu, pc, firstReg);
  if (width === 0) {
    return false;
  }

  const counterReg = regD5(flash[pc + width]!);
  if (counterReg >= firstReg && counterReg < firstReg + width) return false;
  return true;
}

function shiftLeftDecLoopWidth(cpu: CPU, pc: number, firstReg: number): number {
  const flash = cpu.flash;
  const dec2 = flash[pc + 2]!;
  const branch2 = flash[pc + 3]!;
  if (
    (dec2 & 0xfe0f) === 0x940a &&
    (branch2 & 0xfc07) === 0xf401 &&
    ((branch2 >> 3) & 0x7f) === 0x7c
  ) {
    return 2;
  }

  const op2 = flash[pc + 2]!;
  const op3 = flash[pc + 3]!;
  const dec4 = flash[pc + 4]!;
  const branch4 = flash[pc + 5]!;
  if (
    isAdcSelf(op2, firstReg + 2) &&
    isAdcSelf(op3, firstReg + 3) &&
    (dec4 & 0xfe0f) === 0x940a &&
    (branch4 & 0xfc07) === 0xf401 &&
    ((branch4 >> 3) & 0x7f) === 0x7a
  ) {
    return 4;
  }

  return 0;
}

function runShiftLeftDecLoopBlock(cpu: CPU, pc: number, opcode: number, target: number): boolean {
  const firstReg = regD5(opcode);
  const width = shiftLeftDecLoopWidth(cpu, pc, firstReg);
  if (width === 0) return false;
  const counterReg = regD5(cpu.flash[pc + width]!);
  const loops = cpu.data[counterReg] === 0 ? 256 : cpu.data[counterReg]!;
  const blockCycles = loops * (width + 3) - 1;
  if (!cpu.canRunFastBlock(target, blockCycles)) return false;

  const data = cpu.data;
  let carry = 0;
  let halfCarry = 0;
  for (let iteration = 0; iteration < loops; iteration += 1) {
    for (let offset = 0; offset < width; offset += 1) {
      const addr = firstReg + offset;
      const before = data[addr]!;
      const carryIn = offset === 0 ? 0 : carry;
      const sum = before + before + carryIn;
      data[addr] = sum & 0xff;
      carry = sum > 0xff ? 1 : 0;
      if (offset === width - 1) {
        halfCarry = (before & 0x0f) + (before & 0x0f) + carryIn > 0x0f ? 1 : 0;
      }
    }
  }

  data[counterReg] = 0;
  data[SREG_ADDR] =
    (data[SREG_ADDR]! & (SREG_T | SREG_I)) |
    SREG_Z |
    (carry !== 0 ? SREG_C : 0) |
    (halfCarry !== 0 ? SREG_H : 0);
  cpu._cycles += blockCycles;
  cpu.pc = pc + width + 2;
  return true;
}

/**
 * Fast block for compiler-emitted 32-bit right-shift counted loops:
 *   LSR rN+3; ROR rN+2; ROR rN+1; ROR rN; DEC rC; BRNE loop
 */
function isShiftRightDecLoop(cpu: CPU, pc: number, opcode: number): boolean {
  const highReg = regD5(opcode);
  if (highReg < 3) return false;

  const flash = cpu.flash;
  const op1 = flash[pc + 1]!;
  const op2 = flash[pc + 2]!;
  const op3 = flash[pc + 3]!;
  const dec = flash[pc + 4]!;
  const branch = flash[pc + 5]!;
  if (
    !isRor(op1, highReg - 1) ||
    !isRor(op2, highReg - 2) ||
    !isRor(op3, highReg - 3) ||
    (dec & 0xfe0f) !== 0x940a ||
    (branch & 0xfc07) !== 0xf401 ||
    ((branch >> 3) & 0x7f) !== 0x7a
  ) {
    return false;
  }

  const counterReg = regD5(dec);
  return counterReg < highReg - 3 || counterReg > highReg;
}

function isRor(opcode: number, register: number): boolean {
  return (opcode & 0xfe0f) === 0x9407 && regD5(opcode) === register;
}

function runShiftRightDecLoopBlock(cpu: CPU, pc: number, opcode: number, target: number): boolean {
  const highReg = regD5(opcode);
  const lowReg = highReg - 3;
  const counterReg = regD5(cpu.flash[pc + 4]!);
  const loops = cpu.data[counterReg] === 0 ? 256 : cpu.data[counterReg]!;
  const blockCycles = loops * 7 - 1;
  if (!cpu.canRunFastBlock(target, blockCycles)) return false;

  const data = cpu.data;
  const value =
    (data[lowReg]! |
      (data[lowReg + 1]! << 8) |
      (data[lowReg + 2]! << 16) |
      (data[highReg]! << 24)) >>> 0;
  const shifted = loops < 32 ? value >>> loops : 0;
  const carry = loops <= 32 ? (value >>> (loops - 1)) & 1 : 0;
  data[lowReg] = shifted & 0xff;
  data[lowReg + 1] = (shifted >>> 8) & 0xff;
  data[lowReg + 2] = (shifted >>> 16) & 0xff;
  data[highReg] = (shifted >>> 24) & 0xff;
  data[counterReg] = 0;
  data[SREG_ADDR] = (data[SREG_ADDR]! & (SREG_H | SREG_T | SREG_I)) | SREG_Z | (carry !== 0 ? SREG_C : 0);
  cpu._cycles += blockCycles;
  cpu.pc = pc + 6;
  return true;
}

/**
 * avr-libc softfloat right-normalize loop from `__addsf3x`:
 *   LSR r20; ROR r19; ROR r18; ROR r26; SBCI r31,0; INC r21; BRNE loop
 */
function isSoftFloatRightIncLoop(cpu: CPU, pc: number): boolean {
  const flash = cpu.flash;
  const exact = [
    0x9546, // LSR r20
    0x9537, // ROR r19
    0x9527, // ROR r18
    0x95a7, // ROR r26
    0x40f0, // SBCI r31,0
    0x9553, // INC r21
    0xf7c9, // BRNE -7
  ];
  for (let offset = 0; offset < exact.length; offset += 1) {
    if (flash[pc + offset] !== exact[offset]) return false;
  }
  return true;
}

function runSoftFloatRightIncLoopBlock(cpu: CPU, pc: number, target: number): boolean {
  const data = cpu.data;
  const loops = data[21] === 0 ? 256 : 256 - data[21]!;
  const blockCycles = loops * 8 - 1;
  if (!cpu.canRunFastBlock(target, blockCycles)) return false;

  for (let iteration = 0; iteration < loops; iteration += 1) {
    let value = data[20]!;
    data[20] = shiftFlags(cpu, value >> 1, (value & 1) !== 0);
    value = data[19]!;
    data[19] = shiftFlags(
      cpu,
      (value >> 1) | ((data[SREG_ADDR]! & SREG_C) !== 0 ? 0x80 : 0),
      (value & 1) !== 0,
    );
    value = data[18]!;
    data[18] = shiftFlags(
      cpu,
      (value >> 1) | ((data[SREG_ADDR]! & SREG_C) !== 0 ? 0x80 : 0),
      (value & 1) !== 0,
    );
    value = data[26]!;
    data[26] = shiftFlags(
      cpu,
      (value >> 1) | ((data[SREG_ADDR]! & SREG_C) !== 0 ? 0x80 : 0),
      (value & 1) !== 0,
    );

    data[31] = sub8(cpu, data[31]!, 0, (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0, true);

    const result = (data[21]! + 1) & 0xff;
    data[21] = result;
    const v = result === 0x80;
    const n = (result & 0x80) !== 0;
    const flags =
      (v ? SREG_V : 0) |
      (n ? SREG_N : 0) |
      (result === 0 ? SREG_Z : 0) |
      (n !== v ? SREG_S : 0);
    data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) | flags;
  }

  cpu._cycles += blockCycles;
  cpu.pc = pc + 7;
  return true;
}

function isArduinoMicrosBlock(cpu: CPU, pc: number): boolean {
  const flash = cpu.flash;
  const exact: Array<[number, number]> = [
    [0, 0xb73f], // IN r19,SREG
    [1, 0x94f8], // CLI
    [2, 0x9180], // LDS r24, timer0_overflow_count + 0
    [4, 0x9190], // LDS r25, timer0_overflow_count + 1
    [6, 0x91a0], // LDS r26, timer0_overflow_count + 2
    [8, 0x91b0], // LDS r27, timer0_overflow_count + 3
    [10, 0xb526], // IN r18,TCNT0
    [11, 0x9ba8], // SBIS TIFR0,TOV0
    [12, 0xc005], // RJMP over overflow increment
    [13, 0x3f2f], // CPI r18,255
    [14, 0xf019], // BREQ over overflow increment
    [15, 0x9601], // ADIW r24,1
    [16, 0x1da1], // ADC r26,r1
    [17, 0x1db1], // ADC r27,r1
    [18, 0xbf3f], // OUT SREG,r19
    [19, 0x2fba],
    [20, 0x2fa9],
    [21, 0x2f98],
    [22, 0x2788],
    [23, 0x01bc],
    [24, 0x01cd],
    [25, 0x0f62],
    [26, 0x1d71],
    [27, 0x1d81],
    [28, 0x1d91],
    [29, 0xe042],
    [30, 0x0f66],
    [31, 0x1f77],
    [32, 0x1f88],
    [33, 0x1f99],
    [34, 0x954a],
    [35, 0xf7d1],
    [36, 0x9508], // RET
  ];
  for (const [offset, opcode] of exact) {
    if (flash[pc + offset] !== opcode) return false;
  }

  const addr = flash[pc + 3]!;
  return (
    addr + 3 < cpu.data.length &&
    flash[pc + 5] === addr + 1 &&
    flash[pc + 7] === addr + 2 &&
    flash[pc + 9] === addr + 3
  );
}

function runArduinoMicrosBlock(cpu: CPU, pc: number, target: number): boolean {
  if (cpu.data[1] !== 0 || !cpu.canRunFastBlock(target, 48)) return false;

  const startCycles = cpu._cycles;
  const data = cpu.data;
  const flash = cpu.flash;
  const overflowAddr = flash[pc + 3]!;

  const savedSreg = cpu.readIo(0x3f);
  data[19] = savedSreg;
  data[SREG_ADDR] = savedSreg & ~SREG_I;

  cpu._cycles = startCycles + 2;
  let micros = cpu.readData(overflowAddr);
  data[24] = micros & 0xff;
  cpu._cycles = startCycles + 4;
  micros |= cpu.readData(overflowAddr + 1) << 8;
  data[25] = (micros >> 8) & 0xff;
  cpu._cycles = startCycles + 6;
  micros |= cpu.readData(overflowAddr + 2) << 16;
  data[26] = (micros >> 16) & 0xff;
  cpu._cycles = startCycles + 8;
  micros = (micros | (cpu.readData(overflowAddr + 3) << 24)) >>> 0;
  data[27] = (micros >>> 24) & 0xff;

  cpu._cycles = startCycles + 10;
  const tcnt0 = cpu.readIo(0x26);
  data[18] = tcnt0;
  cpu._cycles = startCycles + 11;
  const overflowPending = (cpu.readIo(0x15) & 1) !== 0;

  let blockCycles = 43;
  if (overflowPending) {
    if (tcnt0 === 0xff) {
      blockCycles = 45;
    } else {
      micros = (micros + 1) >>> 0;
      blockCycles = 48;
    }
  }

  data[24] = micros & 0xff;
  data[25] = (micros >>> 8) & 0xff;
  data[26] = (micros >>> 16) & 0xff;
  data[27] = (micros >>> 24) & 0xff;

  cpu._cycles = startCycles + blockCycles - 29;
  cpu.writeIo(0x3f, savedSreg);

  data[27] = (micros >>> 16) & 0xff;
  data[26] = (micros >>> 8) & 0xff;
  data[25] = micros & 0xff;
  data[24] = 0;

  const combined = (((micros << 8) >>> 0) + tcnt0) >>> 0;
  data[22] = combined & 0xff;
  data[23] = (combined >>> 8) & 0xff;
  data[24] = (combined >>> 16) & 0xff;
  data[25] = (combined >>> 24) & 0xff;
  data[20] = 2;

  let carry = 0;
  let halfCarry = 0;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    for (let offset = 0; offset < 4; offset += 1) {
      const addr = 22 + offset;
      const before = data[addr]!;
      const carryIn = offset === 0 ? 0 : carry;
      const sum = before + before + carryIn;
      data[addr] = sum & 0xff;
      carry = sum > 0xff ? 1 : 0;
      if (offset === 3) {
        halfCarry = (before & 0x0f) + (before & 0x0f) + carryIn > 0x0f ? 1 : 0;
      }
    }
    data[20] = (data[20]! - 1) & 0xff;
  }

  data[SREG_ADDR] =
    (data[SREG_ADDR]! & (SREG_T | SREG_I)) |
    SREG_Z |
    (carry !== 0 ? SREG_C : 0) |
    (halfCarry !== 0 ? SREG_H : 0);
  cpu._cycles = startCycles + blockCycles;
  cpu.pc = cpu.popWord();
  return true;
}

function isAdcSelf(opcode: number, register: number): boolean {
  return (
    (opcode & 0xfc00) === 0x1c00 &&
    regD5(opcode) === register &&
    regR5(opcode) === register
  );
}
