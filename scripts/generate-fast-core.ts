const GENERATED_FAST_CORE_URL = new URL("../src/cpu/generated/fast-core.ts", import.meta.url);
const GENERATED_CORES_URL = new URL("../src/cpu/generated/cores.ts", import.meta.url);

export const GENERATED_FAST_CORE_PATH = GENERATED_FAST_CORE_URL;
export const GENERATED_CORES_PATH = GENERATED_CORES_URL;

interface GeneratedArm {
  name: string;
  guard: string;
  body: readonly string[];
  /**
   * Body for the profiled ladder, when it differs from `body`. Needed only for
   * arms that embed a `tryRunFastBlock` continue mid-body (e.g. `rjmp`), which
   * must emit `profileFastBlock(...)` at that continue. Whole-block arms whose
   * body is exactly `["continue;"]` are auto-wrapped, so they don't set this.
   */
  profiledBody?: readonly string[];
}

type CfgInstruction =
  | { op: "adcSelf"; register: number }
  | { op: "sub"; d: number; r: number; carryUsed: boolean; writeback: boolean }
  | { op: "dec"; register: number }
  | { op: "branchCarrySet" };

interface CfgBasicBlock {
  label: string;
  summary: string;
  instructions: readonly CfgInstruction[];
}

const UDIVMODSI4_CFG_BLOCKS: readonly CfgBasicBlock[] = [
  {
    label: "ep",
    summary: "ADC r22,r22; ADC r23,r23; ADC r24,r24; ADC r25,r25",
    instructions: [
      { op: "adcSelf", register: 22 },
      { op: "adcSelf", register: 23 },
      { op: "adcSelf", register: 24 },
      { op: "adcSelf", register: 25 },
      { op: "dec", register: 1 },
    ],
  },
  {
    label: "body",
    summary: "ADC x4; CP/CPC x4; BRCS; optional SUB/SBC x4",
    instructions: [
      { op: "adcSelf", register: 26 },
      { op: "adcSelf", register: 27 },
      { op: "adcSelf", register: 30 },
      { op: "adcSelf", register: 31 },
      { op: "sub", d: 26, r: 18, carryUsed: false, writeback: false },
      { op: "sub", d: 27, r: 19, carryUsed: true, writeback: false },
      { op: "sub", d: 30, r: 20, carryUsed: true, writeback: false },
      { op: "sub", d: 31, r: 21, carryUsed: true, writeback: false },
      { op: "branchCarrySet" },
      { op: "sub", d: 26, r: 18, carryUsed: false, writeback: true },
      { op: "sub", d: 27, r: 19, carryUsed: true, writeback: true },
      { op: "sub", d: 30, r: 20, carryUsed: true, writeback: true },
      { op: "sub", d: 31, r: 21, carryUsed: true, writeback: true },
    ],
  },
];


/**
 * Build an inline subtract/compare arm that mirrors `sub8` in src/cpu/alu.ts
 * byte-for-byte (H/V/N/Z/C/S, plus the multi-byte Z rule when `carryUsed`).
 * Flag math is emitted inline — no helper call on the hot path — per the
 * generated-core rule in docs/performance-summary.md. Compare arms (`writeback: false`) leave the
 * destination register untouched.
 */
function subtractArm(
  name: string,
  guard: string,
  dDecode: string,
  rOperand: string,
  options: { carryUsed: boolean; writeback: boolean },
): GeneratedArm {
  const { carryUsed, writeback } = options;
  const body: string[] = [
    `const d = ${dDecode};`,
    "const dv = data[d]!;",
    `const rv = ${rOperand};`,
  ];
  if (carryUsed) {
    body.push(
      "const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;",
      "const prevZ = (data[SREG_ADDR]! & SREG_Z) !== 0;",
      "const result = (dv - rv - carry) & 0xff;",
    );
  } else {
    body.push("const result = (dv - rv) & 0xff;");
  }
  body.push(
    "const n = (result & 0x80) !== 0;",
    "const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;",
    "const flags =",
  );
  if (carryUsed) {
    body.push(
      "  ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |",
      "  (v ? SREG_V : 0) |",
      "  (n ? SREG_N : 0) |",
      "  (result === 0 && prevZ ? SREG_Z : 0) |",
      "  (dv - rv - carry < 0 ? SREG_C : 0) |",
      "  (n !== v ? SREG_S : 0);",
    );
  } else {
    body.push(
      "  ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |",
      "  (v ? SREG_V : 0) |",
      "  (n ? SREG_N : 0) |",
      "  (result === 0 ? SREG_Z : 0) |",
      "  (dv < rv ? SREG_C : 0) |",
      "  (n !== v ? SREG_S : 0);",
    );
  }
  body.push("data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;");
  if (writeback) body.push("data[d] = result;");
  body.push("this.pc += 1;", "this.cycles += 1;");
  return { name, guard, body };
}

/**
 * Build an inline add arm that mirrors `add8` in src/cpu/alu.ts byte-for-byte
 * (H/V/N/Z/C/S). ADD/ADC both write the destination; ADC folds the carry-in.
 */
function addArm(
  name: string,
  guard: string,
  dDecode: string,
  rOperand: string,
  carryUsed: boolean,
): GeneratedArm {
  const body: string[] = [
    `const d = ${dDecode};`,
    "const dv = data[d]!;",
    `const rv = ${rOperand};`,
  ];
  if (carryUsed) body.push("const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;");
  body.push(
    `const sum = dv + rv${carryUsed ? " + carry" : ""};`,
    "const result = sum & 0xff;",
    "const n = (result & 0x80) !== 0;",
    "const v = (~(dv ^ rv) & (dv ^ result) & 0x80) !== 0;",
    "const flags =",
    `  ((dv & 0x0f) + (rv & 0x0f)${carryUsed ? " + carry" : ""} > 0x0f ? SREG_H : 0) |`,
    "  (v ? SREG_V : 0) |",
    "  (n ? SREG_N : 0) |",
    "  (result === 0 ? SREG_Z : 0) |",
    "  (sum > 0xff ? SREG_C : 0) |",
    "  (n !== v ? SREG_S : 0);",
    "data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;",
    "data[d] = result;",
    "this.pc += 1;",
    "this.cycles += 1;",
  );
  return { name, guard, body };
}

/** Build AND/OR/EOR/ANDI/ORI-style logic arms, mirroring `logic()` flags. */
function logicArm(name: string, guard: string, expression: string, dDecode: string): GeneratedArm {
  return {
    name,
    guard,
    body: [
      `const d = ${dDecode};`,
      `const result = (${expression}) & 0xff;`,
      "const flags =",
      "  ((result & 0x80) !== 0 ? SREG_N | SREG_S : 0) |",
      "  (result === 0 ? SREG_Z : 0);",
      "data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) | flags;",
      "data[d] = result;",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  };
}

/** Build LSR/ROR/ASR-style shift arms, mirroring `shiftFlags()` flags. */
function shiftArm(name: string, guard: string, resultExpression: string): GeneratedArm {
  return {
    name,
    guard,
    body: [
      "const d = regD5(opcode);",
      "const value = data[d]!;",
      `const result = (${resultExpression}) & 0xff;`,
      "const carryOut = (value & 1) !== 0;",
      "const n = (result & 0x80) !== 0;",
      "const v = n !== carryOut;",
      "const flags =",
      "  (carryOut ? SREG_C : 0) |",
      "  (n ? SREG_N : 0) |",
      "  (result === 0 ? SREG_Z : 0) |",
      "  (v ? SREG_V : 0) |",
      "  (n !== v ? SREG_S : 0);",
      "data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_C | SREG_N | SREG_Z | SREG_V | SREG_S)) | flags;",
      "data[d] = result;",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  };
}

/**
 * Build an inline LD/ST indirect arm (docs/performance-summary.md) mirroring
 * `loadIndirect`/`storeIndirect` in src/cpu/instructions.ts. Pointer registers
 * (X=26, Y=28, Z=30) are the plain register file, read/written via `data[...]`,
 * but the memory access itself goes through `this.readData`/`this.writeData` so
 * IO hooks (pin changes, UDR side effects, ...) are preserved exactly. `delta`
 * is -1 (pre-decrement), 0 (no change), or +1 (post-increment).
 */
function memIndirectArm(
  name: string,
  guard: string,
  ptrLow: number,
  delta: -1 | 0 | 1,
  kind: "ld" | "st",
): GeneratedArm {
  const reg = kind === "ld" ? "d" : "r";
  const ptrHi = ptrLow + 1;
  const body: string[] = [`const ${reg} = regD5(opcode);`];
  if (delta < 0) {
    body.push(
      `const addr = ((data[${ptrLow}]! | (data[${ptrHi}]! << 8)) - 1) & 0xffff;`,
      `data[${ptrLow}] = addr & 0xff;`,
      `data[${ptrHi}] = (addr >> 8) & 0xff;`,
    );
  } else {
    body.push(`const addr = data[${ptrLow}]! | (data[${ptrHi}]! << 8);`);
  }
  if (kind === "ld") body.push("data[d] = this.readData(addr);");
  else body.push("this.writeData(addr, data[r]!);");
  if (delta > 0) {
    body.push(
      "const next = (addr + 1) & 0xffff;",
      `data[${ptrLow}] = next & 0xff;`,
      `data[${ptrHi}] = (next >> 8) & 0xff;`,
    );
  }
  body.push("this.pc += 1;", "this.cycles += 2;");
  return { name, guard, body };
}

/** Build two-word LDS/STS arms, mirroring src/cpu/instructions.ts exactly. */
function memDirectArm(name: string, guard: string, kind: "ld" | "st"): GeneratedArm {
  const body =
    kind === "ld"
      ? [
          "data[regD5(opcode)] = this.readData(flash[pc + 1]!);",
          "this.pc += 2;",
          "this.cycles += 2;",
        ]
      : [
          "this.writeData(flash[pc + 1]!, data[regD5(opcode)]!);",
          "this.pc += 2;",
          "this.cycles += 2;",
        ];
  return { name, guard, body };
}

/** Build LDD/STD Y/Z+q arms, where q uses the AVR displacement encoding. */
function memDisplacementArm(
  name: string,
  guard: string,
  ptrLow: 28 | 30,
  kind: "ld" | "st",
): GeneratedArm {
  const ptrHigh = ptrLow + 1;
  const body = [
    "const q = (opcode & 0x07) | ((opcode >> 7) & 0x18) | ((opcode >> 8) & 0x20);",
    `const addr = ((data[${ptrLow}]! | (data[${ptrHigh}]! << 8)) + q) & 0xffff;`,
    ...(kind === "ld"
      ? ["data[regD5(opcode)] = this.readData(addr);"]
      : ["this.writeData(addr, data[regD5(opcode)]!);"]),
    "this.pc += 1;",
    "this.cycles += 2;",
  ];
  return { name, guard, body };
}

/** Build CPSE/SBRC/SBRS/SBIC/SBIS arms, preserving two-word skip accounting. */
function skipArm(name: string, guard: string, condition: string): GeneratedArm {
  return {
    name,
    guard,
    body: [
      "this.pc += 1;",
      "this.cycles += 1;",
      `if (${condition}) {`,
      "  const nextOpcode = flash[pc + 1]!;",
      "  const twoWord =",
      "    (nextOpcode & 0xfe0e) === 0x940c ||",
      "    (nextOpcode & 0xfe0e) === 0x940e ||",
      "    (nextOpcode & 0xfe0f) === 0x9000 ||",
      "    (nextOpcode & 0xfe0f) === 0x9200;",
      "  const words = twoWord ? 2 : 1;",
      "  this.pc += words;",
      "  this.cycles += words;",
      "}",
    ],
  };
}

/** Build SBI/CBI arms for low I/O bit manipulation. */
function ioBitArm(name: string, guard: string, setBit: boolean): GeneratedArm {
  return {
    name,
    guard,
    body: [
      "const a = (opcode >> 3) & 0x1f;",
      "const mask = 1 << (opcode & 0x07);",
      `this.writeIo(a, this.readIo(a) ${setBit ? "|" : "& ~"} mask);`,
      "this.pc += 1;",
      "this.cycles += 2;",
    ],
  };
}

/** Build an inline LPM arm (flash read; no IO hooks). `inc` post-increments Z. */
function lpmArm(name: string, guard: string, dest: string, inc: boolean): GeneratedArm {
  const body = [
    `const ld = ${dest};`,
    "const z = data[30]! | (data[31]! << 8);",
    "data[ld] = this.readProgramByte(z);",
  ];
  if (inc) {
    body.push(
      "const next = (z + 1) & 0xffff;",
      "data[30] = next & 0xff;",
      "data[31] = (next >> 8) & 0xff;",
    );
  }
  body.push("this.pc += 1;", "this.cycles += 3;");
  return { name, guard, body };
}

/** Build INC, mirroring `inc` in src/cpu/instructions.ts (V on 0x7f->0x80). */
function incArm(name: string, guard: string): GeneratedArm {
  return {
    name,
    guard,
    body: [
      "const d = regD5(opcode);",
      "const result = (data[d]! + 1) & 0xff;",
      "data[d] = result;",
      "const v = result === 0x80;",
      "const n = (result & 0x80) !== 0;",
      "const flags =",
      "  (v ? SREG_V : 0) |",
      "  (n ? SREG_N : 0) |",
      "  (result === 0 ? SREG_Z : 0) |",
      "  (n !== v ? SREG_S : 0);",
      "data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) | flags;",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  };
}

/** Build COM (one's complement), mirroring `com`: C set, V cleared, S = N. */
function comArm(name: string, guard: string): GeneratedArm {
  return {
    name,
    guard,
    body: [
      "const d = regD5(opcode);",
      "const result = ~data[d]! & 0xff;",
      "data[d] = result;",
      "const flags =",
      "  SREG_C |",
      "  ((result & 0x80) !== 0 ? SREG_N | SREG_S : 0) |",
      "  (result === 0 ? SREG_Z : 0);",
      "data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_C | SREG_V | SREG_N | SREG_Z | SREG_S)) | flags;",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  };
}

/** Build NEG (two's complement), mirroring `neg` byte-for-byte (H/V/N/Z/C/S). */
function negArm(name: string, guard: string): GeneratedArm {
  return {
    name,
    guard,
    body: [
      "const d = regD5(opcode);",
      "const dv = data[d]!;",
      "const result = (0 - dv) & 0xff;",
      "data[d] = result;",
      "const n = (result & 0x80) !== 0;",
      "const v = result === 0x80;",
      "const flags =",
      "  ((((result >> 3) & 1) | ((dv >> 3) & 1)) !== 0 ? SREG_H : 0) |",
      "  (v ? SREG_V : 0) |",
      "  (n ? SREG_N : 0) |",
      "  (result === 0 ? SREG_Z : 0) |",
      "  (result !== 0 ? SREG_C : 0) |",
      "  (n !== v ? SREG_S : 0);",
      "data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  };
}

/** Build BST: copy bit b of Rd into the T flag, mirroring `bst`. */
function bstArm(name: string, guard: string): GeneratedArm {
  return {
    name,
    guard,
    body: [
      "const set = ((data[regD5(opcode)]! >> (opcode & 0x07)) & 1) === 1;",
      "data[SREG_ADDR] = set ? data[SREG_ADDR]! | SREG_T : data[SREG_ADDR]! & ~SREG_T;",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  };
}

/** Build BLD: copy the T flag into bit b of Rd, mirroring `bld`. */
function bldArm(name: string, guard: string): GeneratedArm {
  return {
    name,
    guard,
    body: [
      "const d = regD5(opcode);",
      "const mask = 1 << (opcode & 0x07);",
      "data[d] = (data[SREG_ADDR]! & SREG_T) !== 0 ? data[d]! | mask : data[d]! & ~mask;",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  };
}

/**
 * Build a multiply arm mirroring `multiply` in src/cpu/alu.ts: 8x8 product into
 * R1:R0, C = product bit 15, Z = result zero (other flags preserved). `signedD`/
 * `signedR` sign-extend the operand; `fractional` shifts the product left by one.
 */
function mulArm(
  name: string,
  guard: string,
  dDecode: string,
  rDecode: string,
  options: { signedD: boolean; signedR: boolean; fractional: boolean },
): GeneratedArm {
  const { signedD, signedR, fractional } = options;
  const aTerm = signedD ? "(dv < 0x80 ? dv : dv - 0x100)" : "dv";
  const bTerm = signedR ? "(rv < 0x80 ? rv : rv - 0x100)" : "rv";
  return {
    name,
    guard,
    body: [
      `const dv = data[${dDecode}]!;`,
      `const rv = data[${rDecode}]!;`,
      `const product = ${aTerm} * ${bTerm};`,
      `const result = (${fractional ? "product << 1" : "product"}) & 0xffff;`,
      "data[0] = result & 0xff;",
      "data[1] = (result >> 8) & 0xff;",
      "const flags = (((product >> 15) & 1) === 1 ? SREG_C : 0) | (result === 0 ? SREG_Z : 0);",
      "data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_C | SREG_Z)) | flags;",
      "this.pc += 1;",
      "this.cycles += 2;",
    ],
  };
}

const GENERATED_ARMS: readonly GeneratedArm[] = [
  {
    name: "sbiw-loop-block",
    guard: "(opcode & 0xff00) === 0x9700 && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  {
    name: "nop",
    guard: "opcode === 0x0000",
    body: ["this.pc += 1;", "this.cycles += 1;"],
  },
  {
    name: "rjmp",
    guard: "(opcode & 0xf000) === 0xc000",
    body: [
      "const k = opcode & 0x0fff;",
      // 0x0fff = RJMP -1 (rjmp-self); 0x0ffc = RJMP -4 (LDS/SBRC poll);
      // 0x0ffa = RJMP -6 (Arduino HardwareSerial ring-buffer wait).
      "if ((k === 0x0fff || k === 0x0ffc || k === 0x0ffa) && this.tryRunFastBlock(pc, opcode, target)) continue;",
      "this.pc += (k >= 0x800 ? k - 0x1000 : k) + 1;",
      "this.cycles += 2;",
    ],
    profiledBody: [
      "const k = opcode & 0x0fff;",
      "if ((k === 0x0fff || k === 0x0ffc || k === 0x0ffa) && this.tryRunFastBlock(pc, opcode, target)) {",
      "  this.profileFastBlock(listener, pc, opcode, before);",
      "  continue;",
      "}",
      "this.pc += (k >= 0x800 ? k - 0x1000 : k) + 1;",
      "this.cycles += 2;",
    ],
  },
  {
    name: "branch-if-set",
    guard: "(opcode & 0xfc00) === 0xf000",
    body: [
      "if ((data[SREG_ADDR]! & (1 << (opcode & 0x07))) !== 0) {",
      "  const k = (opcode >> 3) & 0x7f;",
      "  this.pc += (k >= 0x40 ? k - 0x80 : k) + 1;",
      "  this.cycles += 2;",
      "} else {",
      "  this.pc += 1;",
      "  this.cycles += 1;",
      "}",
    ],
  },
  {
    name: "branch-if-clear",
    guard: "(opcode & 0xfc00) === 0xf400",
    body: [
      "if ((data[SREG_ADDR]! & (1 << (opcode & 0x07))) === 0) {",
      "  const k = (opcode >> 3) & 0x7f;",
      "  this.pc += (k >= 0x40 ? k - 0x80 : k) + 1;",
      "  this.cycles += 2;",
      "} else {",
      "  this.pc += 1;",
      "  this.cycles += 1;",
      "}",
    ],
  },
  {
    name: "sbiw",
    guard: "(opcode & 0xff00) === 0x9700",
    body: [
      "const d = 24 + (((opcode >> 4) & 0x03) * 2);",
      "const k = (opcode & 0x0f) | ((opcode >> 2) & 0x30);",
      "const before = data[d]! | (data[d + 1]! << 8);",
      "const result = (before - k) & 0xffff;",
      "data[d] = result & 0xff;",
      "data[d + 1] = (result >> 8) & 0xff;",
      "const n = (result & 0x8000) !== 0;",
      "const v = (before & ~result & 0x8000) !== 0;",
      "const flags =",
      "  (v ? SREG_V : 0) |",
      "  (n ? SREG_N : 0) |",
      "  (result === 0 ? SREG_Z : 0) |",
      "  (before < k ? SREG_C : 0) |",
      "  (n !== v ? SREG_S : 0);",
      "data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_WORD_MASK) | flags;",
      "this.pc += 1;",
      "this.cycles += 2;",
    ],
  },
  {
    name: "ldi",
    guard: "(opcode & 0xf000) === 0xe000",
    body: ["data[regD4(opcode)] = imm8(opcode);", "this.pc += 1;", "this.cycles += 1;"],
  },
  {
    name: "mov",
    guard: "(opcode & 0xfc00) === 0x2c00",
    body: ["data[regD5(opcode)] = data[regR5(opcode)]!;", "this.pc += 1;", "this.cycles += 1;"],
  },
  // MOVW Rd+1:Rd, Rr+1:Rr (docs/performance-summary.md) — register-only word copy.
  {
    name: "movw",
    guard: "(opcode & 0xff00) === 0x0100",
    body: [
      "const d = ((opcode >> 4) & 0x0f) << 1;",
      "const r = (opcode & 0x0f) << 1;",
      "data[d] = data[r]!;",
      "data[d + 1] = data[r + 1]!;",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  },
  // Subtract/compare group (docs/performance-summary.md). Register/immediate decode mirrors
  // the handlers exactly: SUB/SBC/CP/CPC use regD5/regR5 (r0..r31); SUBI/SBCI/CPI
  // use regD4 (r16..r31) + imm8. Compare arms do not write the destination.
  // Step 4 straight-line block: a run of subtract/compare ops executed in one
  // dispatch. Triggered on the SUB that starts the run (the Arduino delay()
  // compare chain); falls through to the general SUB arm when not a run.
  {
    name: "subcmp-run-block",
    guard: "(opcode & 0xfc00) === 0x1800 && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  subtractArm("sub", "(opcode & 0xfc00) === 0x1800", "regD5(opcode)", "data[regR5(opcode)]!", {
    carryUsed: false,
    writeback: true,
  }),
  subtractArm("sbc", "(opcode & 0xfc00) === 0x0800", "regD5(opcode)", "data[regR5(opcode)]!", {
    carryUsed: true,
    writeback: true,
  }),
  subtractArm("subi", "(opcode & 0xf000) === 0x5000", "regD4(opcode)", "imm8(opcode)", {
    carryUsed: false,
    writeback: true,
  }),
  subtractArm("sbci", "(opcode & 0xf000) === 0x4000", "regD4(opcode)", "imm8(opcode)", {
    carryUsed: true,
    writeback: true,
  }),
  subtractArm("cp", "(opcode & 0xfc00) === 0x1400", "regD5(opcode)", "data[regR5(opcode)]!", {
    carryUsed: false,
    writeback: false,
  }),
  subtractArm("cpc", "(opcode & 0xfc00) === 0x0400", "regD5(opcode)", "data[regR5(opcode)]!", {
    carryUsed: true,
    writeback: false,
  }),
  subtractArm("cpi", "(opcode & 0xf000) === 0x3000", "regD4(opcode)", "imm8(opcode)", {
    carryUsed: false,
    writeback: false,
  }),
  skipArm("cpse", "(opcode & 0xfc00) === 0x1000", "data[regD5(opcode)]! === data[regR5(opcode)]!"),
  logicArm("and", "(opcode & 0xfc00) === 0x2000", "data[d]! & data[regR5(opcode)]!", "regD5(opcode)"),
  logicArm("eor", "(opcode & 0xfc00) === 0x2400", "data[d]! ^ data[regR5(opcode)]!", "regD5(opcode)"),
  logicArm("or", "(opcode & 0xfc00) === 0x2800", "data[d]! | data[regR5(opcode)]!", "regD5(opcode)"),
  logicArm("ori", "(opcode & 0xf000) === 0x6000", "data[d]! | imm8(opcode)", "regD4(opcode)"),
  logicArm("andi", "(opcode & 0xf000) === 0x7000", "data[d]! & imm8(opcode)", "regD4(opcode)"),
  {
    name: "add-fast-block",
    guard: "(opcode & 0xfc00) === 0x0c00 && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  {
    name: "lsr-fast-block",
    guard: "(opcode & 0xfe0f) === 0x9406 && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  {
    name: "dec",
    guard: "(opcode & 0xfe0f) === 0x940a",
    body: [
      "const d = regD5(opcode);",
      "const result = (data[d]! - 1) & 0xff;",
      "data[d] = result;",
      "const v = result === 0x7f;",
      "const n = (result & 0x80) !== 0;",
      "const flags =",
      "  (v ? SREG_V : 0) |",
      "  (n ? SREG_N : 0) |",
      "  (result === 0 ? SREG_Z : 0) |",
      "  (n !== v ? SREG_S : 0);",
      "data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) | flags;",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  },
  {
    name: "udivmodsi4-loop-block",
    guard: "opcode === 0x1f66 && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  {
    name: "umulhisi3-block",
    guard: "opcode === 0x9fa2 && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  {
    name: "mulhisi3-block",
    guard: "(opcode & 0xfe0e) === 0x940e && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  // Add/word-arithmetic group (docs/performance-summary.md). ADD shares the 0x0c00 mask with
  // ADD-starting FastBlocks above, so they MUST stay before it: blocks get first
  // crack and only general ADDs fall through here.
  addArm("add", "(opcode & 0xfc00) === 0x0c00", "regD5(opcode)", "data[regR5(opcode)]!", false),
  addArm("adc", "(opcode & 0xfc00) === 0x1c00", "regD5(opcode)", "data[regR5(opcode)]!", true),
  {
    name: "adiw",
    guard: "(opcode & 0xff00) === 0x9600",
    body: [
      "const d = 24 + (((opcode >> 4) & 0x03) * 2);",
      "const k = (opcode & 0x0f) | ((opcode >> 2) & 0x30);",
      "const before = data[d]! | (data[d + 1]! << 8);",
      "const full = before + k;",
      "const result = full & 0xffff;",
      "data[d] = result & 0xff;",
      "data[d + 1] = (result >> 8) & 0xff;",
      "const n = (result & 0x8000) !== 0;",
      "const v = (~before & result & 0x8000) !== 0;",
      "const flags =",
      "  (v ? SREG_V : 0) |",
      "  (n ? SREG_N : 0) |",
      "  (result === 0 ? SREG_Z : 0) |",
      "  (full > 0xffff ? SREG_C : 0) |",
      "  (n !== v ? SREG_S : 0);",
      "data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_WORD_MASK) | flags;",
      "this.pc += 1;",
      "this.cycles += 2;",
    ],
  },
  {
    name: "arduino-micros-block",
    guard: "opcode === 0xb73f && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  // Stack ops (docs/performance-summary.md). pushByte/popByte are the CPU's own primitives —
  // same call the handlers make — so SP wrap and stack-SRAM access stay identical.
  {
    name: "in",
    guard: "(opcode & 0xf800) === 0xb000",
    body: [
      "data[regD5(opcode)] = this.readIo((opcode & 0x0f) | ((opcode >> 5) & 0x30));",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  },
  {
    name: "out",
    guard: "(opcode & 0xf800) === 0xb800",
    body: [
      "this.writeIo((opcode & 0x0f) | ((opcode >> 5) & 0x30), data[regD5(opcode)]!);",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  },
  {
    name: "push",
    guard: "(opcode & 0xfe0f) === 0x920f",
    body: ["this.pushByte(data[regD5(opcode)]!);", "this.pc += 1;", "this.cycles += 2;"],
  },
  {
    name: "pop",
    guard: "(opcode & 0xfe0f) === 0x900f",
    body: ["data[regD5(opcode)] = this.popByte();", "this.pc += 1;", "this.cycles += 2;"],
  },
  {
    name: "call",
    guard: "(opcode & 0xfe0e) === 0x940e",
    body: [
      "this.pushWord(pc + 2);",
      "const high = ((opcode & 0x01f0) >> 3) | (opcode & 0x0001);",
      "this.pc = (high << 16) | flash[pc + 1]!;",
      "this.cycles += 4;",
    ],
  },
  {
    name: "jmp",
    guard: "(opcode & 0xfe0e) === 0x940c",
    body: [
      "const high = ((opcode & 0x01f0) >> 3) | (opcode & 0x0001);",
      "this.pc = (high << 16) | flash[pc + 1]!;",
      "this.cycles += 3;",
    ],
  },
  {
    name: "rcall",
    guard: "(opcode & 0xf000) === 0xd000",
    body: [
      "this.pushWord(pc + 1);",
      "const k = opcode & 0x0fff;",
      "this.pc += (k >= 0x800 ? k - 0x1000 : k) + 1;",
      "this.cycles += 3;",
    ],
  },
  {
    name: "ret",
    guard: "opcode === 0x9508",
    body: ["this.pc = this.popWord();", "this.cycles += 4;"],
  },
  {
    name: "reti",
    guard: "opcode === 0x9518",
    body: ["this.pc = this.popWord();", "data[SREG_ADDR] = data[SREG_ADDR]! | SREG_I;", "this.cycles += 4;"],
  },
  {
    name: "sei",
    guard: "opcode === 0x9478",
    body: ["data[SREG_ADDR] = data[SREG_ADDR]! | SREG_I;", "this.pc += 1;", "this.cycles += 1;"],
  },
  {
    name: "cli",
    guard: "opcode === 0x94f8",
    body: ["data[SREG_ADDR] = data[SREG_ADDR]! & ~SREG_I;", "this.pc += 1;", "this.cycles += 1;"],
  },
  {
    name: "ijmp",
    guard: "opcode === 0x9409",
    body: ["this.pc = data[30]! | (data[31]! << 8);", "this.cycles += 2;"],
  },
  {
    name: "icall",
    guard: "opcode === 0x9509",
    body: ["this.pushWord(pc + 1);", "this.pc = data[30]! | (data[31]! << 8);", "this.cycles += 3;"],
  },
  {
    name: "bset",
    guard: "(opcode & 0xff8f) === 0x9408",
    body: [
      "data[SREG_ADDR] = data[SREG_ADDR]! | (1 << ((opcode >> 4) & 0x07));",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  },
  {
    name: "bclr",
    guard: "(opcode & 0xff8f) === 0x9488",
    body: [
      "data[SREG_ADDR] = data[SREG_ADDR]! & ~(1 << ((opcode >> 4) & 0x07));",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  },
  {
    name: "swap",
    guard: "(opcode & 0xfe0f) === 0x9402",
    body: [
      "const d = regD5(opcode);",
      "const value = data[d]!;",
      "data[d] = ((value << 4) | (value >> 4)) & 0xff;",
      "this.pc += 1;",
      "this.cycles += 1;",
    ],
  },
  shiftArm("lsr", "(opcode & 0xfe0f) === 0x9406", "value >> 1"),
  shiftArm(
    "ror",
    "(opcode & 0xfe0f) === 0x9407",
    "(value >> 1) | ((data[SREG_ADDR]! & SREG_C) !== 0 ? 0x80 : 0)",
  ),
  shiftArm("asr", "(opcode & 0xfe0f) === 0x9405", "(value >> 1) | (value & 0x80)"),
  skipArm(
    "sbic",
    "(opcode & 0xff00) === 0x9900",
    "((this.readIo((opcode >> 3) & 0x1f) >> (opcode & 0x07)) & 1) === 0",
  ),
  skipArm(
    "sbis",
    "(opcode & 0xff00) === 0x9b00",
    "((this.readIo((opcode >> 3) & 0x1f) >> (opcode & 0x07)) & 1) === 1",
  ),
  ioBitArm("sbi", "(opcode & 0xff00) === 0x9a00", true),
  ioBitArm("cbi", "(opcode & 0xff00) === 0x9800", false),
  // Indirect load/store group (docs/performance-summary.md). Placed late: these are colder than
  // the ALU/branch/stack arms, so hot instructions never test past them. Memory
  // access uses this.readData/this.writeData to preserve IO hooks. (Plain LD/ST via
  // Y/Z with displacement q=0 are handled by LDD/STD, not here.)
  memDirectArm("lds", "(opcode & 0xfe0f) === 0x9000", "ld"),
  memDirectArm("sts", "(opcode & 0xfe0f) === 0x9200", "st"),
  memDisplacementArm("ldd-y", "(opcode & 0xd208) === 0x8008", 28, "ld"),
  memDisplacementArm("ldd-z", "(opcode & 0xd208) === 0x8000", 30, "ld"),
  memDisplacementArm("std-y", "(opcode & 0xd208) === 0x8208", 28, "st"),
  memDisplacementArm("std-z", "(opcode & 0xd208) === 0x8200", 30, "st"),
  {
    name: "strcpy-zx-block",
    guard: "(opcode & 0xfe0f) === 0x9001 && (flash[pc + 1]! & 0xfe0f) === 0x920d && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  memIndirectArm("ld-x", "(opcode & 0xfe0f) === 0x900c", 26, 0, "ld"),
  memIndirectArm("ld-x-inc", "(opcode & 0xfe0f) === 0x900d", 26, 1, "ld"),
  memIndirectArm("ld-x-dec", "(opcode & 0xfe0f) === 0x900e", 26, -1, "ld"),
  memIndirectArm("ld-y-inc", "(opcode & 0xfe0f) === 0x9009", 28, 1, "ld"),
  memIndirectArm("ld-y-dec", "(opcode & 0xfe0f) === 0x900a", 28, -1, "ld"),
  memIndirectArm("ld-z-inc", "(opcode & 0xfe0f) === 0x9001", 30, 1, "ld"),
  memIndirectArm("ld-z-dec", "(opcode & 0xfe0f) === 0x9002", 30, -1, "ld"),
  memIndirectArm("st-x", "(opcode & 0xfe0f) === 0x920c", 26, 0, "st"),
  memIndirectArm("st-x-inc", "(opcode & 0xfe0f) === 0x920d", 26, 1, "st"),
  memIndirectArm("st-x-dec", "(opcode & 0xfe0f) === 0x920e", 26, -1, "st"),
  memIndirectArm("st-y-inc", "(opcode & 0xfe0f) === 0x9209", 28, 1, "st"),
  memIndirectArm("st-y-dec", "(opcode & 0xfe0f) === 0x920a", 28, -1, "st"),
  memIndirectArm("st-z-inc", "(opcode & 0xfe0f) === 0x9201", 30, 1, "st"),
  memIndirectArm("st-z-dec", "(opcode & 0xfe0f) === 0x9202", 30, -1, "st"),
  // LPM (flash read). R0 form is the exact 0x95c8; Rd / Rd+ use the 0xfe0f family.
  lpmArm("lpm-r0", "opcode === 0x95c8", "0", false),
  lpmArm("lpm-z", "(opcode & 0xfe0f) === 0x9004", "regD5(opcode)", false),
  lpmArm("lpm-z-inc", "(opcode & 0xfe0f) === 0x9005", "regD5(opcode)", true),
  {
    name: "fp-split3-common-block",
    guard: "opcode === 0xfd57 && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  skipArm(
    "sbrc",
    "(opcode & 0xfe08) === 0xfc00",
    "((data[regD5(opcode)]! >> (opcode & 0x07)) & 1) === 0",
  ),
  skipArm(
    "sbrs",
    "(opcode & 0xfe08) === 0xfe00",
    "((data[regD5(opcode)]! >> (opcode & 0x07)) & 1) === 1",
  ),
  // Single-register arithmetic/flag group (docs/performance-summary.md). Distinct low
  // nibbles within the 0x94xx family keep these unambiguous with DEC/SWAP/shifts.
  incArm("inc", "(opcode & 0xfe0f) === 0x9403"),
  comArm("com", "(opcode & 0xfe0f) === 0x9400"),
  negArm("neg", "(opcode & 0xfe0f) === 0x9401"),
  // Bit copy via the T flag. These share the 0xf800 high bits with the branch
  // arms but use a disjoint mask (bit 9 selects BLD/BST vs SBRC/SBRS).
  bstArm("bst", "(opcode & 0xfe08) === 0xfa00"),
  bldArm("bld", "(opcode & 0xfe08) === 0xf800"),
  // Multiply group (docs/performance-summary.md). MUL is 0x9c00; the signed/fractional
  // variants live in 0x02xx/0x03xx and are split by bits 7 and 3.
  mulArm("mul", "(opcode & 0xfc00) === 0x9c00", "regD5(opcode)", "regR5(opcode)", {
    signedD: false,
    signedR: false,
    fractional: false,
  }),
  mulArm("muls", "(opcode & 0xff00) === 0x0200", "16 + ((opcode >> 4) & 0x0f)", "16 + (opcode & 0x0f)", {
    signedD: true,
    signedR: true,
    fractional: false,
  }),
  mulArm("mulsu", "(opcode & 0xff88) === 0x0300", "16 + ((opcode >> 4) & 0x07)", "16 + (opcode & 0x07)", {
    signedD: true,
    signedR: false,
    fractional: false,
  }),
  mulArm("fmul", "(opcode & 0xff88) === 0x0308", "16 + ((opcode >> 4) & 0x07)", "16 + (opcode & 0x07)", {
    signedD: false,
    signedR: false,
    fractional: true,
  }),
  mulArm("fmuls", "(opcode & 0xff88) === 0x0380", "16 + ((opcode >> 4) & 0x07)", "16 + (opcode & 0x07)", {
    signedD: true,
    signedR: true,
    fractional: true,
  }),
  mulArm("fmulsu", "(opcode & 0xff88) === 0x0388", "16 + ((opcode >> 4) & 0x07)", "16 + (opcode & 0x07)", {
    signedD: true,
    signedR: false,
    fractional: true,
  }),
  // System control. SLEEP defers to this.sleep() (honors SMCR.SE) exactly like the
  // handler; WDR kicks the watchdog; BREAK is a benign NOP on this target.
  {
    name: "sleep",
    guard: "opcode === 0x9588",
    body: ["this.pc += 1;", "this.cycles += 1;", "this.sleep();"],
  },
  {
    name: "wdr",
    guard: "opcode === 0x95a8",
    body: ["this.kickWatchdog();", "this.pc += 1;", "this.cycles += 1;"],
  },
  {
    name: "spm",
    guard: "opcode === 0x95e8",
    body: ["this.executeSpmInstruction(pc);", "this.pc += 1;", "this.cycles += 4;"],
  },
  {
    name: "break",
    guard: "opcode === 0x9598",
    body: ["this.pc += 1;", "this.cycles += 1;"],
  },
];

export function generatedFastCoreArmNames(): readonly string[] {
  return GENERATED_ARMS.map((arm) => arm.name);
}

export function generateFastCoreSource(): string {
  return [
    "// This file is generated by scripts/generate-fast-core.ts.",
    "// Do not edit by hand; run `bun run generate:fast-core` instead.",
    "",
    "export const GENERATED_FAST_CORE_METHOD_NAME = \"runGeneratedFastCore\";",
    "export const GENERATED_FAST_CORE_ARM_NAMES = [",
    ...GENERATED_ARMS.map((arm) => `  ${JSON.stringify(arm.name)},`),
    "] as const;",
    "",
  ].join("\n");
}

function generateUdivmodsi4CfgMethodLines(): string[] {
  return [
    "  private runGeneratedUdivmodsi4CfgBlock(pc: number, target: number): boolean {",
    "    const data = this.data;",
    "    const loops = data[1] === 0 ? 256 : data[1]!;",
    "    // Same guard contract as the handwritten block. This is the worst-case CFG",
    "    // path: final ep is 6 cycles; each prior iteration can take ep(7)+body(13).",
    "    const maxCycles = 6 + (loops - 1) * 20;",
    "    if (!this.canRunFastBlock(target, maxCycles)) return false;",
    "",
    "    let elapsed = 0;",
    "    let sreg = data[SREG_ADDR]!;",
    "",
    "    while (true) {",
    ...indentLines(generateCfgBlockLines(UDIVMODSI4_CFG_BLOCKS[0]!), 6),
    "",
    ...indentLines(generateCfgBlockLines(UDIVMODSI4_CFG_BLOCKS[1]!), 6),
    "    }",
    "",
    "    data[SREG_ADDR] = sreg;",
    "    this._cycles += elapsed;",
    "    this.pc = pc + 6;",
    "    return true;",
    "  }",
  ];
}

function generateCfgBlockLines(block: CfgBasicBlock): string[] {
  const lines = [`// ${block.label} block: ${block.summary}`];
  for (const instruction of block.instructions) lines.push(...generateCfgInstructionLines(instruction));
  return lines;
}

function generateCfgInstructionLines(instruction: CfgInstruction): string[] {
  switch (instruction.op) {
    case "adcSelf":
      return generateCfgAdcSelfLines(instruction.register);
    case "sub":
      return generateCfgSubLines(instruction.d, instruction.r, instruction.carryUsed, instruction.writeback);
    case "dec":
      return [
        `const dec = (data[${instruction.register}]! - 1) & 0xff;`,
        `data[${instruction.register}] = dec;`,
        "const decN = (dec & 0x80) !== 0;",
        "const decV = dec === 0x7f;",
        "sreg =",
        "  (sreg & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) |",
        "  (decV ? SREG_V : 0) |",
        "  (decN ? SREG_N : 0) |",
        "  (dec === 0 ? SREG_Z : 0) |",
        "  (decN !== decV ? SREG_S : 0);",
        "elapsed += 1;",
        "if (dec === 0) {",
        "  elapsed += 1; // BRNE not taken",
        "  break;",
        "}",
        "elapsed += 2; // BRNE taken to body",
      ];
    case "branchCarrySet":
      return [
        "if ((sreg & SREG_C) !== 0) {",
        "  elapsed += 2; // BRCS taken to ep",
        "  continue;",
        "}",
        "elapsed += 1; // BRCS not taken",
      ];
  }
}

function generateCfgAdcSelfLines(register: number): string[] {
  return [
    "{",
    `  const dv = data[${register}]!;`,
    "  const carry = (sreg & SREG_C) !== 0 ? 1 : 0;",
    "  const sum = dv + dv + carry;",
    "  const result = sum & 0xff;",
    "  const n = (result & 0x80) !== 0;",
    "  const v = ((dv ^ result) & 0x80) !== 0;",
    "  const flags =",
    "    ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |",
    "    (v ? SREG_V : 0) |",
    "    (n ? SREG_N : 0) |",
    "    (result === 0 ? SREG_Z : 0) |",
    "    (sum > 0xff ? SREG_C : 0) |",
    "    (n !== v ? SREG_S : 0);",
    "  sreg = (sreg & ~SREG_ARITH_MASK) | flags;",
    `  data[${register}] = result;`,
    "  elapsed += 1;",
    "}",
  ];
}

function generateCfgSubLines(d: number, r: number, carryUsed: boolean, writeback: boolean): string[] {
  const lines = [
    "{",
    `  const dv = data[${d}]!;`,
    `  const rv = data[${r}]!;`,
  ];
  if (carryUsed) {
    lines.push("  const carry = (sreg & SREG_C) !== 0 ? 1 : 0;", "  const prevZ = (sreg & SREG_Z) !== 0;");
  }
  lines.push(
    `  const result = (dv - rv${carryUsed ? " - carry" : ""}) & 0xff;`,
    "  const n = (result & 0x80) !== 0;",
    "  const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;",
    "  const flags =",
  );
  if (carryUsed) {
    lines.push(
      "    ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |",
      "    (v ? SREG_V : 0) |",
      "    (n ? SREG_N : 0) |",
      "    (result === 0 && prevZ ? SREG_Z : 0) |",
      "    (dv - rv - carry < 0 ? SREG_C : 0) |",
      "    (n !== v ? SREG_S : 0);",
    );
  } else {
    lines.push(
      "    ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |",
      "    (v ? SREG_V : 0) |",
      "    (n ? SREG_N : 0) |",
      "    (result === 0 ? SREG_Z : 0) |",
      "    (dv < rv ? SREG_C : 0) |",
      "    (n !== v ? SREG_S : 0);",
    );
  }
  lines.push("  sreg = (sreg & ~SREG_ARITH_MASK) | flags;");
  if (writeback) lines.push(`  data[${d}] = result;`);
  lines.push("  elapsed += 1;", "}");
  return lines;
}

type LadderVariant = "core" | "profiled";

/**
 * The execution cores live in their own generated module, `src/cpu/generated/
 * cores.ts`, instead of inline in `cpu.ts` — they are ~3,500 lines of machine
 * output that otherwise dwarf the hand-written CPU logic. Each is emitted as a
 * free function taking the `CPU` instance; `cpu.ts` keeps thin delegating call
 * sites. The single-source guarantee is unchanged: every core is generated from
 * the one `GENERATED_ARMS` list, so the production ladder
 * (`runGeneratedFastCore`) and the profiler ladder (`runFastProfiled`) cannot
 * drift apart.
 */
const CORES_FILE_HEADER: readonly string[] = [
  "// This file is generated by scripts/generate-fast-core.ts.",
  "// Do not edit by hand; run `bun run generate:fast-core` instead.",
  "//",
  "// The execution cores are emitted here, out of cpu.ts, as free functions taking",
  "// the CPU instance. They are single-sourced from the generator's one arm list,",
  "// so the fast ladder and profiled ladder cannot drift.",
  "",
  'import type { CPU } from "../cpu";',
  'import { SREG_ADDR } from "../constants";',
  "import {",
  "  SREG_ARITH_MASK,",
  "  SREG_C,",
  "  SREG_H,",
  "  SREG_I,",
  "  SREG_N,",
  "  SREG_S,",
  "  SREG_T,",
  "  SREG_V,",
  "  SREG_WORD_MASK,",
  "  SREG_Z,",
  "  imm8,",
  "  regD4,",
  "  regD5,",
  "  regR5,",
  '} from "../alu";',
  'import type { ProfileRunListener } from "../types";',
  "",
];

interface CoreFunction {
  signature: string;
  methodLines: readonly string[];
}

/** The three single-sourced execution cores, emitted as free functions. */
function coreFunctions(): readonly CoreFunction[] {
  return [
    {
      signature: "export function runGeneratedFastCore(cpu: CPU, target: number): void {",
      methodLines: generateMethodLines("runGeneratedFastCore", "core"),
    },
    {
      signature:
        "export function runFastProfiled(cpu: CPU, target: number, listener: ProfileRunListener): void {",
      methodLines: generateMethodLines("runFastProfiled", "profiled"),
    },
    {
      signature:
        "export function runGeneratedUdivmodsi4CfgBlock(cpu: CPU, pc: number, target: number): boolean {",
      methodLines: generateUdivmodsi4CfgMethodLines(),
    },
  ];
}

/**
 * Turn a generated class-method body into a free function: swap the `private …(…)`
 * signature for the supplied `export function` header, rewrite every `this.` to
 * `cpu.`, and dedent one indentation level so the body reads as a top-level
 * function. The members reached through `cpu.` are exposed on `CPU` for exactly
 * this purpose (see the "generated-core surface" note in cpu.ts).
 */
function asFreeFunction(signature: string, methodLines: readonly string[]): string[] {
  const body = methodLines.slice(1).map((line) => {
    // Rewrite every `this` (member access `this.x` and the bare receiver passed
    // as `executor.execute(this, …)` / `handler(this, …)`) to the `cpu` param.
    const rewritten = line.replace(/\bthis\b/g, "cpu");
    return rewritten.startsWith("  ") ? rewritten.slice(2) : rewritten;
  });
  return [signature, ...body];
}

/** The full contents of the generated `src/cpu/generated/cores.ts` module. */
export function generateCoresFile(): string {
  const blocks = coreFunctions().map((fn) => asFreeFunction(fn.signature, fn.methodLines).join("\n"));
  return [...CORES_FILE_HEADER, blocks.join("\n\n"), ""].join("\n");
}

function generateArmChainLines(
  arms: readonly GeneratedArm[],
  variant: LadderVariant,
  fallback: readonly string[],
): string[] {
  const lines: string[] = [];
  arms.forEach((arm, index) => {
    lines.push(`${index === 0 ? "if" : "else if"} (${arm.guard}) {`);
    lines.push(...indentLines([...armBody(arm, variant)], 2));
    lines.push("}");
  });
  lines.push("else {");
  lines.push(...indentLines(fallback, 2));
  lines.push("}");
  return lines;
}

function generateMethodLines(method: string, variant: LadderVariant): string[] {
  const profiled = variant === "profiled";
  const signature = profiled
    ? `  private ${method}(target: number, listener: ProfileRunListener): void {`
    : `  private ${method}(target: number): void {`;
  const sleepBranch = profiled
    ? [
        "        const pc = this.pc;",
        "        const opcode = flash[pc]!;",
        "        const before = this._cycles;",
        "        this.tick();",
        '        listener(this.profileState(pc, opcode, before, "sleep"));',
      ]
    : ["        this.tick();"];
  const capture = profiled
    ? ["        const pc = this.pc;", "        const opcode = flash[pc]!;", "        const before = this._cycles;"]
    : ["        const pc = this.pc;", "        const opcode = flash[pc]!;"];
  const instructionTail = profiled
    ? [
        "        this.serviceInterrupts();",
        '        listener(this.profileState(pc, opcode, before, "instruction"));',
      ]
    : ["        this.serviceInterrupts();"];
  const bail = profiled ? "this.runProfiledTicks(target, listener);" : "this.runTicksUntil(target);";
  return [
    signature,
    "    const executor = this.executor;",
    "    if (!executor) {",
    '      throw new Error("CPU has no executor - call setExecutor(new Decoder()) first.");',
    "    }",
    "    const flash = this.flash;",
    "    const data = this.data;",
    "    const decodeCache = this.decodeCache;",
    "    while (this._cycles < target) {",
    "      if (this.sleeping) {",
    ...sleepBranch,
    "      } else {",
    ...capture,
    ...indentLines(generateLadderLines(variant), 8),
    ...instructionTail,
    "      }",
    "      if (",
    "        this.breakpoints.size !== 0 ||",
    "        this.traceListeners.length !== 0 ||",
    "        this.pauseOnUnknownOpcode",
    "      ) {",
    `        ${bail}`,
    "        return;",
    "      }",
    "    }",
    "  }",
  ];
}

function armBody(arm: GeneratedArm, variant: LadderVariant): readonly string[] {
  if (variant !== "profiled") return arm.body;
  if (arm.profiledBody) return arm.profiledBody;
  // Whole-block arms (a bare `continue` after a tryRunFastBlock guard) emit a
  // profile event for the block before continuing.
  if (arm.body.length === 1 && arm.body[0] === "continue;") {
    return ["this.profileFastBlock(listener, pc, opcode, before);", "continue;"];
  }
  return arm.body;
}

function generateLadderLines(variant: LadderVariant): string[] {
  return generateArmChainLines(GENERATED_ARMS, variant, generateFallbackLines(variant));
}

function generateFallbackLines(variant: LadderVariant): string[] {
  const unknownTail =
    variant === "profiled"
      ? [
          "executor.execute(this, opcode);",
          "this.serviceInterrupts();",
          'listener(this.profileState(pc, opcode, before, "instruction"));',
          "continue;",
        ]
      : ["executor.execute(this, opcode);", "this.serviceInterrupts();", "continue;"];
  return [
    "let handler = decodeCache[pc];",
    "if (handler === undefined) {",
    "  if (this.wrapProgramCounter()) continue;",
    "  handler = executor.handlerFor(opcode);",
    "  if (handler === undefined) {",
    ...indentLines(unknownTail, 4),
    "  }",
    "  decodeCache[pc] = handler;",
    "}",
    "handler(this, opcode);",
  ];
}

function indentLines(lines: readonly string[], spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => (line.length === 0 ? line : `${prefix}${line}`));
}

async function main(): Promise<void> {
  const check = Bun.argv.includes("--check");
  const metadataSource = generateFastCoreSource();
  const coresSource = generateCoresFile();
  if (check) {
    const existingMetadata = await Bun.file(GENERATED_FAST_CORE_URL).text().catch(() => "");
    if (existingMetadata !== metadataSource) {
      console.error("Generated fast core metadata is stale. Run `bun run generate:fast-core`.");
      process.exit(1);
    }
    const existingCores = await Bun.file(GENERATED_CORES_URL).text().catch(() => "");
    if (existingCores !== coresSource) {
      console.error("Generated cores module is stale. Run `bun run generate:fast-core`.");
      process.exit(1);
    }
    return;
  }

  await Bun.write(GENERATED_FAST_CORE_URL, metadataSource);
  await Bun.write(GENERATED_CORES_URL, coresSource);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
