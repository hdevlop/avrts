import { describe, expect, test } from "bun:test";
import { CPU, Decoder, FLASH_WORDS, PORTB, UnknownOpcodeError } from "../src/cpu";

/** Build a CPU loaded with a hand-assembled program and an attached decoder. */
function makeCpu(program: number[]): CPU {
  const flash = new Uint16Array(FLASH_WORDS); // full flash; unused words = 0x0000 (NOP)
  flash.set(program);
  const cpu = new CPU(flash);
  cpu.setExecutor(new Decoder());
  return cpu;
}

describe("execute loop + Phase 2 instructions", () => {
  test("LDI + ADD: result, flags, PC and cycle accounting", () => {
    const cpu = makeCpu([
      0xef0f, // ldi r16, 0xFF
      0xe011, // ldi r17, 0x01
      0x0f01, // add r16, r17   -> 0x00, carry+zero+halfcarry
      0xb905, // out 0x05, r16  -> PORTB
      0xcfff, // rjmp -1
    ]);
    for (let i = 0; i < 4; i += 1) cpu.tick();

    expect(cpu.data[16]).toBe(0x00);
    expect(cpu.sreg.C).toBe(true);
    expect(cpu.sreg.Z).toBe(true);
    expect(cpu.sreg.H).toBe(true);
    expect(cpu.sreg.V).toBe(false);
    expect(cpu.sreg.N).toBe(false);
    expect(cpu.data[PORTB]).toBe(0x00);
    expect(cpu.pc).toBe(4);
    expect(cpu.cycles).toBe(4);
  });

  test("RJMP -1 is a 2-cycle self-loop", () => {
    const cpu = makeCpu([0xcfff]); // rjmp -1
    cpu.tick();
    expect(cpu.pc).toBe(0);
    expect(cpu.cycles).toBe(2);
  });

  test("RJMP applies a forward offset", () => {
    const cpu = makeCpu([0xc002]); // rjmp +2 -> pc = 0 + 2 + 1
    cpu.tick();
    expect(cpu.pc).toBe(3);
  });

  test("SUB sets borrow + negative", () => {
    const cpu = makeCpu([
      0xe100, // ldi r16, 0x10
      0xe210, // ldi r17, 0x20
      0x1b01, // sub r16, r17  -> 0xF0
    ]);
    cpu.run(3);
    expect(cpu.data[16]).toBe(0xf0);
    expect(cpu.sreg.C).toBe(true); // 0x10 < 0x20 -> borrow
    expect(cpu.sreg.N).toBe(true);
    expect(cpu.sreg.Z).toBe(false);
  });

  test("MOV copies a register", () => {
    const cpu = makeCpu([
      0xe54a, // ldi r20, 0x5A
      0x2e04, // mov r0, r20
    ]);
    cpu.run(2);
    expect(cpu.data[0]).toBe(0x5a);
  });

  test("IN reads back what OUT wrote (PORTB via I/O 0x05 -> data 0x25)", () => {
    const cpu = makeCpu([
      0xec03, // ldi r16, 0xC3
      0xb905, // out 0x05, r16
      0xb115, // in r17, 0x05
    ]);
    cpu.run(3);
    expect(cpu.data[PORTB]).toBe(0xc3);
    expect(cpu.data[17]).toBe(0xc3);
  });

  test("ADC adds the carry-in and sets half-carry", () => {
    const cpu = makeCpu([0x1c01]); // adc r0, r1
    cpu.data[0] = 0x0f;
    cpu.data[1] = 0x00;
    cpu.sreg.C = true;
    cpu.tick();
    expect(cpu.data[0]).toBe(0x10);
    expect(cpu.sreg.H).toBe(true);
    expect(cpu.sreg.C).toBe(false);
  });

  test("NOP advances pc by 1 in 1 cycle", () => {
    const cpu = makeCpu([0x0000]);
    cpu.tick();
    expect(cpu.pc).toBe(1);
    expect(cpu.cycles).toBe(1);
  });

  test("unknown opcode throws UnknownOpcodeError", () => {
    const cpu = makeCpu([0xffff]);
    expect(() => cpu.tick()).toThrow(UnknownOpcodeError);
  });

  test("onTrace reports the decoded mnemonic per instruction", () => {
    const cpu = makeCpu([0x0000, 0xcfff]); // nop ; rjmp -1
    const seen: string[] = [];
    cpu.onTrace((s) => seen.push(s.mnemonic));
    cpu.tick();
    cpu.tick();
    expect(seen).toEqual(["NOP", "RJMP"]);
  });
});

describe("decode table", () => {
  test("most-specific mask wins: NOP (0x0000) does not collide with ADD's range", () => {
    const decoder = new Decoder();
    expect(decoder.mnemonicOf(0x0000)).toBe("NOP");
    expect(decoder.mnemonicOf(0x0c01)).toBe("ADD");
    expect(decoder.mnemonicOf(0xe000)).toBe("LDI");
    expect(decoder.mnemonicOf(0xffff)).toBeUndefined();
  });
});
