const GENERATED_FAST_CORE_URL = new URL("../src/cpu/generated/fast-core.ts", import.meta.url);
const CPU_SOURCE_URL = new URL("../src/cpu/cpu.ts", import.meta.url);

const GENERATED_REGION_BEGIN = "  // BEGIN GENERATED FAST CORE";
const GENERATED_REGION_END = "  // END GENERATED FAST CORE";

export const GENERATED_FAST_CORE_PATH = GENERATED_FAST_CORE_URL;
export const CPU_FAST_CORE_PATH = CPU_SOURCE_URL;

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

/**
 * Build an inline subtract/compare arm that mirrors `sub8` in src/cpu/alu.ts
 * byte-for-byte (H/V/N/Z/C/S, plus the multi-byte Z rule when `carryUsed`).
 * Flag math is emitted inline — no helper call on the hot path — per the
 * generated-core rule in docs/10. Compare arms (`writeback: false`) leave the
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

/**
 * Build an inline LD/ST indirect arm (docs/10 Step 3) mirroring
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

/** Build an inline LPM arm (flash read; no IO hooks). `inc` post-increments Z. */
function lpmArm(name: string, guard: string, dest: string, inc: boolean): GeneratedArm {
  const body = [
    `const ld = ${dest};`,
    "const z = data[30]! | (data[31]! << 8);",
    "const word = flash[z >> 1]!;",
    "data[ld] = z & 1 ? (word >> 8) & 0xff : word & 0xff;",
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

const GENERATED_ARMS: readonly GeneratedArm[] = [
  {
    name: "zero-sbiw-breq-block",
    guard: "(opcode & 0xffcf) === 0x9700 && this.tryRunFastBlock(pc, opcode, target)",
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
      "if (k === 0x0fff && this.tryRunFastBlock(pc, opcode, target)) continue;",
      "this.pc += (k >= 0x800 ? k - 0x1000 : k) + 1;",
      "this.cycles += 2;",
    ],
    profiledBody: [
      "const k = opcode & 0x0fff;",
      "if (k === 0x0fff && this.tryRunFastBlock(pc, opcode, target)) {",
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
  // MOVW Rd+1:Rd, Rr+1:Rr (docs/10 Step 3) — register-only word copy.
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
  // Subtract/compare group (docs/10 Step 1). Register/immediate decode mirrors
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
  {
    name: "shift-left-dec-block",
    guard: "(opcode & 0xfc00) === 0x0c00 && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  {
    name: "udivmodsi4-loop-block",
    guard: "opcode === 0x1f66 && this.tryRunFastBlock(pc, opcode, target)",
    body: ["continue;"],
  },
  // Add/word-arithmetic group (docs/10 Step 2). ADD shares the 0x0c00 mask with the
  // shift-left-dec FastBlock above, so it MUST stay after it: the block gets first
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
  // Stack ops (docs/10 Step 3). pushByte/popByte are the CPU's own primitives —
  // same call the handlers make — so SP wrap and stack-SRAM access stay identical.
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
  // Indirect load/store group (docs/10 Step 3). Placed late: these are colder than
  // the ALU/branch/stack arms, so hot instructions never test past them. Memory
  // access uses this.readData/this.writeData to preserve IO hooks. (Plain LD/ST via
  // Y/Z with displacement q=0 are handled by LDD/STD, not here.)
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

type LadderVariant = "core" | "profiled";

/**
 * The two single-sourced dispatch ladders. `runGeneratedFastCore` is the
 * production path (`CPU.run()`); `runFastProfiled` is the same ladder with
 * per-step profiling (used by `profile:opcodes --mode fast`). Generating both
 * from one arm list makes them impossible to drift apart — the reason this exists
 * is that the `CALL` arm once drifted into the generated copy only. (A third,
 * `runFast`, was a redundant hand-vs-generated A/B twin and has been removed.)
 */
interface LadderRegion {
  begin: string;
  end: string;
  method: string;
  variant: LadderVariant;
}

const LADDER_REGIONS: readonly LadderRegion[] = [
  {
    begin: GENERATED_REGION_BEGIN,
    end: GENERATED_REGION_END,
    method: "runGeneratedFastCore",
    variant: "core",
  },
  {
    begin: "  // BEGIN GENERATED FAST PROFILED",
    end: "  // END GENERATED FAST PROFILED",
    method: "runFastProfiled",
    variant: "profiled",
  },
];

export function generateFastCoreRegion(): string {
  return generateRegion(LADDER_REGIONS[0]!);
}

/** All three single-sourced ladder regions (core, fast-run twin, profiled). */
export function generateFastCoreRegions(): string[] {
  return LADDER_REGIONS.map(generateRegion);
}

function generateRegion(region: LadderRegion): string {
  return [region.begin, ...generateMethodLines(region.method, region.variant), region.end].join("\n");
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
  const lines: string[] = [];
  GENERATED_ARMS.forEach((arm, index) => {
    lines.push(`${index === 0 ? "if" : "else if"} (${arm.guard}) {`);
    lines.push(...indentLines([...armBody(arm, variant)], 2));
    lines.push("}");
  });
  lines.push("else {");
  lines.push(...indentLines(generateFallbackLines(variant), 2));
  lines.push("}");
  return lines;
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

function replaceRegion(source: string, region: LadderRegion): string {
  const begin = source.indexOf(region.begin);
  if (begin < 0) throw new Error(`Missing generated fast core marker: ${region.begin}`);
  const end = source.indexOf(region.end, begin);
  if (end < 0) throw new Error(`Missing generated fast core marker: ${region.end}`);
  const afterEnd = end + region.end.length;
  return `${source.slice(0, begin)}${generateRegion(region)}${source.slice(afterEnd)}`;
}

function extractRegion(source: string, region: LadderRegion): string {
  const begin = source.indexOf(region.begin);
  if (begin < 0) throw new Error(`Missing generated fast core marker: ${region.begin}`);
  const end = source.indexOf(region.end, begin);
  if (end < 0) throw new Error(`Missing generated fast core marker: ${region.end}`);
  return source.slice(begin, end + region.end.length);
}

async function main(): Promise<void> {
  const check = Bun.argv.includes("--check");
  const metadataSource = generateFastCoreSource();
  if (check) {
    const existingMetadata = await Bun.file(GENERATED_FAST_CORE_URL).text().catch(() => "");
    if (existingMetadata !== metadataSource) {
      console.error("Generated fast core metadata is stale. Run `bun run generate:fast-core`.");
      process.exit(1);
    }
    const cpuSource = await Bun.file(CPU_SOURCE_URL).text();
    for (const region of LADDER_REGIONS) {
      if (extractRegion(cpuSource, region) !== generateRegion(region)) {
        console.error(`Generated ladder ${region.method} is stale. Run \`bun run generate:fast-core\`.`);
        process.exit(1);
      }
    }
    return;
  }

  await Bun.write(GENERATED_FAST_CORE_URL, metadataSource);
  let cpuSource = await Bun.file(CPU_SOURCE_URL).text();
  for (const region of LADDER_REGIONS) cpuSource = replaceRegion(cpuSource, region);
  await Bun.write(CPU_SOURCE_URL, cpuSource);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
