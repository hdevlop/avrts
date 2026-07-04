import { Op, opRegistry } from "../core";
import type { OpEntry } from "../core";
import type { CPU } from "./cpu";
import { SREG_ADDR } from "./constants";
import { UnknownOpcodeError, nearestDisassemblyHint } from "./errors";
import type { Executor, InstructionHandler } from "./types";
import {
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
  bitNum,
  dispQ,
  farAddr,
  imm8,
  ioAddr5,
  ioAddr6,
  isTwoWordOpcode,
  logic,
  multiply,
  pair,
  regD4,
  regD5,
  regR5,
  setPair,
  shiftFlags,
  signed12,
  signed7,
  signed8,
  subtractWordImmediate,
  sub8,
} from "./alu";

// Register-pair base addresses for the pointer registers.
const X = 26;
const Y = 28;
const Z = 30;

/**
 * Every AVR instruction handler. Each method declares its encoding with @Op; the
 * Decoder compiles the registry into a flat lookup table. Handlers stay small and
 * single-purpose; shared arithmetic/flag/memory logic lives in the helpers below.
 *
 * Note: LSL Rd is ADD Rd,Rd and ROL Rd is ADC Rd,Rd — those encodings are handled
 * by `add`/`adc`, so they need no separate handlers.
 */
export class InstructionSet {
  // === data moves & immediates ===

  @Op("NOP", 0xffff, 0x0000)
  nop(cpu: CPU): void {
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("MOV", 0xfc00, 0x2c00)
  mov(cpu: CPU, opcode: number): void {
    cpu.data[regD5(opcode)] = cpu.data[regR5(opcode)]!;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("MOVW", 0xff00, 0x0100)
  movw(cpu: CPU, opcode: number): void {
    const d = ((opcode >> 4) & 0x0f) << 1;
    const r = (opcode & 0x0f) << 1;
    cpu.data[d] = cpu.data[r]!;
    cpu.data[d + 1] = cpu.data[r + 1]!;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("LDI", 0xf000, 0xe000)
  ldi(cpu: CPU, opcode: number): void {
    cpu.data[regD4(opcode)] = imm8(opcode);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  // === arithmetic ===

  @Op("ADD", 0xfc00, 0x0c00)
  add(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    cpu.data[d] = add8(cpu, cpu.data[d]!, cpu.data[regR5(opcode)]!, 0);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("ADC", 0xfc00, 0x1c00)
  adc(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    cpu.data[d] = add8(
      cpu,
      cpu.data[d]!,
      cpu.data[regR5(opcode)]!,
      cpu.data[SREG_ADDR]! & SREG_C ? 1 : 0,
    );
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("SUB", 0xfc00, 0x1800)
  sub(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    cpu.data[d] = sub8(cpu, cpu.data[d]!, cpu.data[regR5(opcode)]!, 0, false);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("SUBI", 0xf000, 0x5000)
  subi(cpu: CPU, opcode: number): void {
    const d = regD4(opcode);
    cpu.data[d] = sub8(cpu, cpu.data[d]!, imm8(opcode), 0, false);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("SBC", 0xfc00, 0x0800)
  sbc(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    cpu.data[d] = sub8(
      cpu,
      cpu.data[d]!,
      cpu.data[regR5(opcode)]!,
      cpu.data[SREG_ADDR]! & SREG_C ? 1 : 0,
      true,
    );
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("SBCI", 0xf000, 0x4000)
  sbci(cpu: CPU, opcode: number): void {
    const d = regD4(opcode);
    cpu.data[d] = sub8(cpu, cpu.data[d]!, imm8(opcode), cpu.sreg.C ? 1 : 0, true);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("INC", 0xfe0f, 0x9403)
  inc(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    const result = (cpu.data[d]! + 1) & 0xff;
    cpu.data[d] = result;
    const sreg = cpu.sreg;
    sreg.V = result === 0x80;
    sreg.N = (result & 0x80) !== 0;
    sreg.Z = result === 0;
    sreg.S = sreg.N !== sreg.V;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("DEC", 0xfe0f, 0x940a)
  dec(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    const result = (cpu.data[d]! - 1) & 0xff;
    cpu.data[d] = result;
    const sreg = cpu.sreg;
    sreg.V = result === 0x7f;
    sreg.N = (result & 0x80) !== 0;
    sreg.Z = result === 0;
    sreg.S = sreg.N !== sreg.V;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("COM", 0xfe0f, 0x9400)
  com(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    const result = ~cpu.data[d]! & 0xff;
    cpu.data[d] = result;
    const sreg = cpu.sreg;
    sreg.C = true;
    sreg.V = false;
    sreg.N = (result & 0x80) !== 0;
    sreg.Z = result === 0;
    sreg.S = sreg.N;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("NEG", 0xfe0f, 0x9401)
  neg(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    const dv = cpu.data[d]!;
    const result = (0 - dv) & 0xff;
    cpu.data[d] = result;
    const sreg = cpu.sreg;
    sreg.H = (((result >> 3) & 1) | ((dv >> 3) & 1)) !== 0;
    sreg.V = result === 0x80;
    sreg.N = (result & 0x80) !== 0;
    sreg.Z = result === 0;
    sreg.C = result !== 0;
    sreg.S = sreg.N !== sreg.V;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("ADIW", 0xff00, 0x9600)
  adiw(cpu: CPU, opcode: number): void {
    const d = 24 + ((opcode >> 4) & 0x03) * 2;
    const k = (opcode & 0x0f) | ((opcode >> 2) & 0x30);
    const before = pair(cpu, d);
    const full = before + k;
    const result = full & 0xffff;
    setPair(cpu, d, result);
    const n = (result & 0x8000) !== 0;
    const v = (~before & result & 0x8000) !== 0;
    const flags =
      (v ? SREG_V : 0) |
      (n ? SREG_N : 0) |
      (result === 0 ? SREG_Z : 0) |
      (full > 0xffff ? SREG_C : 0) |
      (n !== v ? SREG_S : 0);
    cpu.data[SREG_ADDR] = (cpu.data[SREG_ADDR]! & ~SREG_WORD_MASK) | flags;
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  @Op("SBIW", 0xff00, 0x9700)
  sbiw(cpu: CPU, opcode: number): void {
    subtractWordImmediate(cpu, opcode);
  }

  // === logic ===

  @Op("AND", 0xfc00, 0x2000)
  and(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    cpu.data[d] = logic(cpu, cpu.data[d]! & cpu.data[regR5(opcode)]!);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("ANDI", 0xf000, 0x7000)
  andi(cpu: CPU, opcode: number): void {
    const d = regD4(opcode);
    cpu.data[d] = logic(cpu, cpu.data[d]! & imm8(opcode));
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("OR", 0xfc00, 0x2800)
  or(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    cpu.data[d] = logic(cpu, cpu.data[d]! | cpu.data[regR5(opcode)]!);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("ORI", 0xf000, 0x6000)
  ori(cpu: CPU, opcode: number): void {
    const d = regD4(opcode);
    cpu.data[d] = logic(cpu, cpu.data[d]! | imm8(opcode));
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("EOR", 0xfc00, 0x2400)
  eor(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    cpu.data[d] = logic(cpu, cpu.data[d]! ^ cpu.data[regR5(opcode)]!);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("SWAP", 0xfe0f, 0x9402)
  swap(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    const v = cpu.data[d]!;
    cpu.data[d] = ((v << 4) | (v >> 4)) & 0xff;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  // === shifts (V = N xor C after the shift) ===

  @Op("LSR", 0xfe0f, 0x9406)
  lsr(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    const v = cpu.data[d]!;
    cpu.data[d] = shiftFlags(cpu, v >> 1, (v & 1) !== 0);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("ROR", 0xfe0f, 0x9407)
  ror(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    const v = cpu.data[d]!;
    const result = (v >> 1) | (cpu.sreg.C ? 0x80 : 0);
    cpu.data[d] = shiftFlags(cpu, result, (v & 1) !== 0);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("ASR", 0xfe0f, 0x9405)
  asr(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    const v = cpu.data[d]!;
    cpu.data[d] = shiftFlags(cpu, (v >> 1) | (v & 0x80), (v & 1) !== 0);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  // === compare (subtract, discard result) ===

  @Op("CP", 0xfc00, 0x1400)
  cp(cpu: CPU, opcode: number): void {
    sub8(cpu, cpu.data[regD5(opcode)]!, cpu.data[regR5(opcode)]!, 0, false);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("CPC", 0xfc00, 0x0400)
  cpc(cpu: CPU, opcode: number): void {
    sub8(
      cpu,
      cpu.data[regD5(opcode)]!,
      cpu.data[regR5(opcode)]!,
      cpu.data[SREG_ADDR]! & SREG_C ? 1 : 0,
      true,
    );
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("CPI", 0xf000, 0x3000)
  cpi(cpu: CPU, opcode: number): void {
    sub8(cpu, cpu.data[regD4(opcode)]!, imm8(opcode), 0, false);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  // === conditional branches ===

  @Op("BREQ", 0xfc07, 0xf001)
  breq(cpu: CPU, opcode: number): void {
    if ((cpu.data[SREG_ADDR]! & SREG_Z) !== 0) {
      const k = (opcode >> 3) & 0x7f;
      cpu.pc += (k >= 0x40 ? k - 0x80 : k) + 1;
      cpu.cycles += 2;
    } else {
      cpu.pc += 1;
      cpu.cycles += 1;
    }
  }

  @Op("BRNE", 0xfc07, 0xf401)
  brne(cpu: CPU, opcode: number): void {
    if ((cpu.data[SREG_ADDR]! & SREG_Z) === 0) {
      const k = (opcode >> 3) & 0x7f;
      cpu.pc += (k >= 0x40 ? k - 0x80 : k) + 1;
      cpu.cycles += 2;
    } else {
      cpu.pc += 1;
      cpu.cycles += 1;
    }
  }

  @Op("BRCS", 0xfc07, 0xf000)
  brcs(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_C) !== 0);
  }

  @Op("BRCC", 0xfc07, 0xf400)
  brcc(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_C) === 0);
  }

  @Op("BRMI", 0xfc07, 0xf002)
  brmi(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_N) !== 0);
  }

  @Op("BRPL", 0xfc07, 0xf402)
  brpl(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_N) === 0);
  }

  @Op("BRLT", 0xfc07, 0xf004)
  brlt(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_S) !== 0);
  }

  @Op("BRGE", 0xfc07, 0xf404)
  brge(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_S) === 0);
  }

  // === skip-if instructions (1 cycle; +1 per skipped word) ===

  @Op("CPSE", 0xfc00, 0x1000)
  cpse(cpu: CPU, opcode: number): void {
    this.skipIf(cpu, cpu.data[regD5(opcode)]! === cpu.data[regR5(opcode)]!);
  }

  @Op("SBRC", 0xfe08, 0xfc00)
  sbrc(cpu: CPU, opcode: number): void {
    this.skipIf(cpu, ((cpu.data[regD5(opcode)]! >> bitNum(opcode)) & 1) === 0);
  }

  @Op("SBRS", 0xfe08, 0xfe00)
  sbrs(cpu: CPU, opcode: number): void {
    this.skipIf(cpu, ((cpu.data[regD5(opcode)]! >> bitNum(opcode)) & 1) === 1);
  }

  @Op("SBIC", 0xff00, 0x9900)
  sbic(cpu: CPU, opcode: number): void {
    this.skipIf(cpu, ((cpu.readIo(ioAddr5(opcode)) >> bitNum(opcode)) & 1) === 0);
  }

  @Op("SBIS", 0xff00, 0x9b00)
  sbis(cpu: CPU, opcode: number): void {
    this.skipIf(cpu, ((cpu.readIo(ioAddr5(opcode)) >> bitNum(opcode)) & 1) === 1);
  }

  // === I/O bit set/clear ===

  @Op("SBI", 0xff00, 0x9a00)
  sbi(cpu: CPU, opcode: number): void {
    const a = ioAddr5(opcode);
    cpu.writeIo(a, cpu.readIo(a) | (1 << bitNum(opcode)));
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  @Op("CBI", 0xff00, 0x9800)
  cbi(cpu: CPU, opcode: number): void {
    const a = ioAddr5(opcode);
    cpu.writeIo(a, cpu.readIo(a) & ~(1 << bitNum(opcode)));
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  // === I/O move ===

  @Op("IN", 0xf800, 0xb000)
  in(cpu: CPU, opcode: number): void {
    cpu.data[regD5(opcode)] = cpu.readIo(ioAddr6(opcode));
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("OUT", 0xf800, 0xb800)
  out(cpu: CPU, opcode: number): void {
    cpu.writeIo(ioAddr6(opcode), cpu.data[regD5(opcode)]!);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  // === stack ===

  @Op("PUSH", 0xfe0f, 0x920f)
  push(cpu: CPU, opcode: number): void {
    cpu.pushByte(cpu.data[regD5(opcode)]!);
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  @Op("POP", 0xfe0f, 0x900f)
  pop(cpu: CPU, opcode: number): void {
    cpu.data[regD5(opcode)] = cpu.popByte();
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  // === jumps & calls ===

  @Op("RJMP", 0xf000, 0xc000)
  rjmp(cpu: CPU, opcode: number): void {
    cpu.pc += signed12(opcode) + 1;
    cpu.cycles += 2;
  }

  @Op("RCALL", 0xf000, 0xd000)
  rcall(cpu: CPU, opcode: number): void {
    cpu.pushWord(cpu.pc + 1);
    cpu.pc += signed12(opcode) + 1;
    cpu.cycles += 3;
  }

  @Op("JMP", 0xfe0e, 0x940c, 2)
  jmp(cpu: CPU, opcode: number): void {
    cpu.pc = farAddr(cpu, opcode);
    cpu.cycles += 3;
  }

  @Op("CALL", 0xfe0e, 0x940e, 2)
  call(cpu: CPU, opcode: number): void {
    cpu.pushWord(cpu.pc + 2);
    cpu.pc = farAddr(cpu, opcode);
    cpu.cycles += 4;
  }

  @Op("RET", 0xffff, 0x9508)
  ret(cpu: CPU): void {
    cpu.pc = cpu.popWord();
    cpu.cycles += 4;
  }

  @Op("RETI", 0xffff, 0x9518)
  reti(cpu: CPU): void {
    cpu.pc = cpu.popWord();
    cpu.sreg.I = true;
    cpu.cycles += 4;
  }

  @Op("SEI", 0xffff, 0x9478)
  sei(cpu: CPU): void {
    cpu.sreg.I = true;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("CLI", 0xffff, 0x94f8)
  cli(cpu: CPU): void {
    cpu.sreg.I = false;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  // === data memory (SRAM) ===

  @Op("LDS", 0xfe0f, 0x9000, 2)
  lds(cpu: CPU, opcode: number): void {
    cpu.data[regD5(opcode)] = cpu.readData(cpu.flash[cpu.pc + 1]!);
    cpu.pc += 2;
    cpu.cycles += 2;
  }

  @Op("STS", 0xfe0f, 0x9200, 2)
  sts(cpu: CPU, opcode: number): void {
    cpu.writeData(cpu.flash[cpu.pc + 1]!, cpu.data[regD5(opcode)]!);
    cpu.pc += 2;
    cpu.cycles += 2;
  }

  @Op("LD_X", 0xfe0f, 0x900c)
  ldX(cpu: CPU, opcode: number): void {
    this.loadIndirect(cpu, opcode, X, 0);
  }

  @Op("LD_Xinc", 0xfe0f, 0x900d)
  ldXinc(cpu: CPU, opcode: number): void {
    this.loadIndirect(cpu, opcode, X, 1);
  }

  @Op("LD_Xdec", 0xfe0f, 0x900e)
  ldXdec(cpu: CPU, opcode: number): void {
    this.loadIndirect(cpu, opcode, X, -1);
  }

  @Op("LD_Yinc", 0xfe0f, 0x9009)
  ldYinc(cpu: CPU, opcode: number): void {
    this.loadIndirect(cpu, opcode, Y, 1);
  }

  @Op("LD_Ydec", 0xfe0f, 0x900a)
  ldYdec(cpu: CPU, opcode: number): void {
    this.loadIndirect(cpu, opcode, Y, -1);
  }

  @Op("LD_Zinc", 0xfe0f, 0x9001)
  ldZinc(cpu: CPU, opcode: number): void {
    this.loadIndirect(cpu, opcode, Z, 1);
  }

  @Op("LD_Zdec", 0xfe0f, 0x9002)
  ldZdec(cpu: CPU, opcode: number): void {
    this.loadIndirect(cpu, opcode, Z, -1);
  }

  @Op("ST_X", 0xfe0f, 0x920c)
  stX(cpu: CPU, opcode: number): void {
    this.storeIndirect(cpu, opcode, X, 0);
  }

  @Op("ST_Xinc", 0xfe0f, 0x920d)
  stXinc(cpu: CPU, opcode: number): void {
    this.storeIndirect(cpu, opcode, X, 1);
  }

  @Op("ST_Xdec", 0xfe0f, 0x920e)
  stXdec(cpu: CPU, opcode: number): void {
    this.storeIndirect(cpu, opcode, X, -1);
  }

  @Op("ST_Yinc", 0xfe0f, 0x9209)
  stYinc(cpu: CPU, opcode: number): void {
    this.storeIndirect(cpu, opcode, Y, 1);
  }

  @Op("ST_Ydec", 0xfe0f, 0x920a)
  stYdec(cpu: CPU, opcode: number): void {
    this.storeIndirect(cpu, opcode, Y, -1);
  }

  @Op("ST_Zinc", 0xfe0f, 0x9201)
  stZinc(cpu: CPU, opcode: number): void {
    this.storeIndirect(cpu, opcode, Z, 1);
  }

  @Op("ST_Zdec", 0xfe0f, 0x9202)
  stZdec(cpu: CPU, opcode: number): void {
    this.storeIndirect(cpu, opcode, Z, -1);
  }

  // LDD/STD with displacement (q=0 covers plain LD/ST via Y/Z).
  @Op("LDD_Y", 0xd208, 0x8008)
  lddY(cpu: CPU, opcode: number): void {
    cpu.data[regD5(opcode)] = cpu.readData((pair(cpu, Y) + dispQ(opcode)) & 0xffff);
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  @Op("LDD_Z", 0xd208, 0x8000)
  lddZ(cpu: CPU, opcode: number): void {
    cpu.data[regD5(opcode)] = cpu.readData((pair(cpu, Z) + dispQ(opcode)) & 0xffff);
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  @Op("STD_Y", 0xd208, 0x8208)
  stdY(cpu: CPU, opcode: number): void {
    cpu.writeData((pair(cpu, Y) + dispQ(opcode)) & 0xffff, cpu.data[regD5(opcode)]!);
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  @Op("STD_Z", 0xd208, 0x8200)
  stdZ(cpu: CPU, opcode: number): void {
    cpu.writeData((pair(cpu, Z) + dispQ(opcode)) & 0xffff, cpu.data[regD5(opcode)]!);
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  // === program memory (flash) ===

  @Op("LPM", 0xffff, 0x95c8)
  lpmR0(cpu: CPU): void {
    cpu.data[0] = this.lpmByte(cpu, pair(cpu, Z));
    cpu.pc += 1;
    cpu.cycles += 3;
  }

  @Op("LPM", 0xfe0f, 0x9004)
  lpmZ(cpu: CPU, opcode: number): void {
    cpu.data[regD5(opcode)] = this.lpmByte(cpu, pair(cpu, Z));
    cpu.pc += 1;
    cpu.cycles += 3;
  }

  @Op("LPM", 0xfe0f, 0x9005)
  lpmZinc(cpu: CPU, opcode: number): void {
    const z = pair(cpu, Z);
    cpu.data[regD5(opcode)] = this.lpmByte(cpu, z);
    setPair(cpu, Z, (z + 1) & 0xffff);
    cpu.pc += 1;
    cpu.cycles += 3;
  }

  @Op("SPM", 0xffff, 0x95e8)
  spm(cpu: CPU): void {
    const pc = cpu.pc;
    cpu.executeSpmInstruction(pc);
    cpu.pc += 1;
    cpu.cycles += 4;
  }

  // === multiply (R1:R0 = product) ===

  @Op("MUL", 0xfc00, 0x9c00)
  mul(cpu: CPU, opcode: number): void {
    multiply(cpu, cpu.data[regD5(opcode)]!, cpu.data[regR5(opcode)]!, false);
  }

  @Op("MULS", 0xff00, 0x0200)
  muls(cpu: CPU, opcode: number): void {
    const d = 16 + ((opcode >> 4) & 0x0f);
    const r = 16 + (opcode & 0x0f);
    multiply(cpu, signed8(cpu.data[d]!), signed8(cpu.data[r]!), false);
  }

  @Op("MULSU", 0xff88, 0x0300)
  mulsu(cpu: CPU, opcode: number): void {
    const d = 16 + ((opcode >> 4) & 0x07);
    const r = 16 + (opcode & 0x07);
    multiply(cpu, signed8(cpu.data[d]!), cpu.data[r]!, false);
  }

  @Op("FMUL", 0xff88, 0x0308)
  fmul(cpu: CPU, opcode: number): void {
    const d = 16 + ((opcode >> 4) & 0x07);
    const r = 16 + (opcode & 0x07);
    multiply(cpu, cpu.data[d]!, cpu.data[r]!, true);
  }

  @Op("FMULS", 0xff88, 0x0380)
  fmuls(cpu: CPU, opcode: number): void {
    const d = 16 + ((opcode >> 4) & 0x07);
    const r = 16 + (opcode & 0x07);
    multiply(cpu, signed8(cpu.data[d]!), signed8(cpu.data[r]!), true);
  }

  @Op("FMULSU", 0xff88, 0x0388)
  fmulsu(cpu: CPU, opcode: number): void {
    const d = 16 + ((opcode >> 4) & 0x07);
    const r = 16 + (opcode & 0x07);
    multiply(cpu, signed8(cpu.data[d]!), cpu.data[r]!, true);
  }

  // === indirect jumps (via Z) ===

  @Op("IJMP", 0xffff, 0x9409)
  ijmp(cpu: CPU): void {
    cpu.pc = pair(cpu, Z);
    cpu.cycles += 2;
  }

  @Op("ICALL", 0xffff, 0x9509)
  icall(cpu: CPU): void {
    cpu.pushWord(cpu.pc + 1);
    cpu.pc = pair(cpu, Z);
    cpu.cycles += 3;
  }

  // === bit copy via the T flag ===

  @Op("BST", 0xfe08, 0xfa00)
  bst(cpu: CPU, opcode: number): void {
    cpu.sreg.T = ((cpu.data[regD5(opcode)]! >> bitNum(opcode)) & 1) === 1;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("BLD", 0xfe08, 0xf800)
  bld(cpu: CPU, opcode: number): void {
    const d = regD5(opcode);
    const mask = 1 << bitNum(opcode);
    cpu.data[d] = cpu.sreg.T ? cpu.data[d]! | mask : cpu.data[d]! & ~mask;
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  // === SREG bit set/clear (SEC/CLC/SEZ/... ; SEI/CLI have dedicated handlers) ===

  @Op("BSET", 0xff8f, 0x9408)
  bset(cpu: CPU, opcode: number): void {
    cpu.sreg.value |= 1 << ((opcode >> 4) & 0x07);
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("BCLR", 0xff8f, 0x9488)
  bclr(cpu: CPU, opcode: number): void {
    cpu.sreg.value &= ~(1 << ((opcode >> 4) & 0x07));
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  // === remaining conditional branches (V/H/T/I) ===

  @Op("BRVS", 0xfc07, 0xf003)
  brvs(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_V) !== 0);
  }

  @Op("BRVC", 0xfc07, 0xf403)
  brvc(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_V) === 0);
  }

  @Op("BRHS", 0xfc07, 0xf005)
  brhs(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_H) !== 0);
  }

  @Op("BRHC", 0xfc07, 0xf405)
  brhc(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_H) === 0);
  }

  @Op("BRTS", 0xfc07, 0xf006)
  brts(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_T) !== 0);
  }

  @Op("BRTC", 0xfc07, 0xf406)
  brtc(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_T) === 0);
  }

  @Op("BRIE", 0xfc07, 0xf007)
  brie(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_I) !== 0);
  }

  @Op("BRID", 0xfc07, 0xf407)
  brid(cpu: CPU, opcode: number): void {
    this.branchIf(cpu, opcode, (cpu.data[SREG_ADDR]! & SREG_I) === 0);
  }

  // === system (modeled as benign NOPs for now) ===

  @Op("SLEEP", 0xffff, 0x9588)
  sleep(cpu: CPU): void {
    cpu.pc += 1;
    cpu.cycles += 1;
    cpu.sleep(); // halts until an enabled interrupt (only if SMCR.SE is set)
  }

  @Op("WDR", 0xffff, 0x95a8)
  wdr(cpu: CPU): void {
    cpu.kickWatchdog();
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  @Op("BREAK", 0xffff, 0x9598)
  break_(cpu: CPU): void {
    cpu.pc += 1;
    cpu.cycles += 1;
  }

  // === shared helpers ===

  private branchIf(cpu: CPU, opcode: number, taken: boolean): void {
    if (taken) {
      cpu.pc += signed7(opcode) + 1;
      cpu.cycles += 2;
    } else {
      cpu.pc += 1;
      cpu.cycles += 1;
    }
  }

  private skipIf(cpu: CPU, condition: boolean): void {
    cpu.pc += 1;
    cpu.cycles += 1;
    if (condition) {
      const words = isTwoWordOpcode(cpu.flash[cpu.pc]!) ? 2 : 1;
      cpu.pc += words;
      cpu.cycles += words;
    }
  }

  private loadIndirect(cpu: CPU, opcode: number, ptrLow: number, delta: number): void {
    const d = regD5(opcode);
    let addr = pair(cpu, ptrLow);
    if (delta < 0) {
      addr = (addr - 1) & 0xffff;
      setPair(cpu, ptrLow, addr);
    }
    cpu.data[d] = cpu.readData(addr);
    if (delta > 0) setPair(cpu, ptrLow, (addr + 1) & 0xffff);
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  private storeIndirect(cpu: CPU, opcode: number, ptrLow: number, delta: number): void {
    const r = regD5(opcode);
    let addr = pair(cpu, ptrLow);
    if (delta < 0) {
      addr = (addr - 1) & 0xffff;
      setPair(cpu, ptrLow, addr);
    }
    cpu.writeData(addr, cpu.data[r]!);
    if (delta > 0) setPair(cpu, ptrLow, (addr + 1) & 0xffff);
    cpu.pc += 1;
    cpu.cycles += 2;
  }

  /** Read one byte of flash at a byte address (Harvard program space). */
  private lpmByte(cpu: CPU, byteAddr: number): number {
    return cpu.readProgramByte(byteAddr);
  }

}

// --- decode table (built once, frozen; see "Registry rules" in 03-coding-style.md) ---

interface CompiledTable {
  handlers: ReadonlyArray<InstructionHandler | undefined>;
  mnemonics: ReadonlyArray<string | undefined>;
}

const TABLE_SIZE = 0x10000;

function popcount(value: number): number {
  let v = value;
  let count = 0;
  while (v !== 0) {
    v &= v - 1;
    count += 1;
  }
  return count;
}

/** Visit every opcode that matches `(op & mask) === pattern`. */
function eachMatchingOpcode(mask: number, pattern: number, visit: (op: number) => void): void {
  const free = ~mask & 0xffff;
  let sub = free;
  while (true) {
    visit((pattern & mask) | sub);
    if (sub === 0) break;
    sub = (sub - 1) & free;
  }
}

/**
 * Compile the @Op registry into a frozen opcode->handler table. Least-specific
 * masks fill first so more-specific instructions overwrite generic patterns they
 * overlap; an equal-specificity overlap is a real ambiguity and throws here, at
 * build time. The hot path then never touches `any` or a linear scan.
 */
export function buildDecodeTable(set: InstructionSet): CompiledTable {
  const handlers = new Array<InstructionHandler | undefined>(TABLE_SIZE);
  const mnemonics = new Array<string | undefined>(TABLE_SIZE);
  const owner = new Array<OpEntry | undefined>(TABLE_SIZE);
  const entries = [...opRegistry].sort((a, b) => popcount(a.mask) - popcount(b.mask));

  for (const entry of entries) {
    const method = (set as unknown as Record<string, unknown>)[entry.key];
    if (typeof method !== "function") {
      throw new Error(`@Op handler "${entry.key}" is not a method on InstructionSet`);
    }
    const handler = (method as InstructionHandler).bind(set);
    eachMatchingOpcode(entry.mask, entry.pattern, (op) => {
      const prev = owner[op];
      if (prev && popcount(prev.mask) === popcount(entry.mask)) {
        throw new Error(
          `Opcode 0x${op.toString(16)} ambiguous: ${prev.mnemonic} vs ${entry.mnemonic}`,
        );
      }
      handlers[op] = handler;
      mnemonics[op] = entry.mnemonic;
      owner[op] = entry;
    });
  }

  return { handlers: Object.freeze(handlers), mnemonics: Object.freeze(mnemonics) };
}

/** Decodes + executes opcodes via the prebuilt table. */
export class Decoder implements Executor {
  private readonly handlers: ReadonlyArray<InstructionHandler | undefined>;
  private readonly mnemonics: ReadonlyArray<string | undefined>;

  constructor(set: InstructionSet = new InstructionSet()) {
    const compiled = buildDecodeTable(set);
    this.handlers = compiled.handlers;
    this.mnemonics = compiled.mnemonics;
  }

  execute(cpu: CPU, opcode: number): void {
    const handler = this.handlers[opcode];
    if (!handler) {
      const next = cpu.pc + 1 < cpu.flash.length ? cpu.flash[cpu.pc + 1] : undefined;
      const context = nearestDisassemblyHint(cpu.flash, cpu.pc, (op) => this.mnemonicOf(op));
      throw new UnknownOpcodeError(cpu.pc, opcode, next, context);
    }
    handler(cpu, opcode);
  }

  mnemonicOf(opcode: number): string | undefined {
    return this.mnemonics[opcode];
  }

  handlerFor(opcode: number): InstructionHandler | undefined {
    return this.handlers[opcode];
  }
}

/** Deterministic construction: importing this module registers every @Op first. */
export function buildDecoder(): Decoder {
  return new Decoder();
}
