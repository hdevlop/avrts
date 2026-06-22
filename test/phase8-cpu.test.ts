import { describe, expect, test } from "bun:test";
import { CPU, Decoder, FLASH_WORDS } from "../src/cpu";

function makeCpu(program: number[]): CPU {
  const flash = new Uint16Array(FLASH_WORDS);
  flash.set(program);
  const cpu = new CPU(flash);
  cpu.setExecutor(new Decoder());
  return cpu;
}

describe("Phase 8 — instruction completion", () => {
  test("MUL stores the unsigned product in R1:R0", () => {
    const cpu = makeCpu([0x9c45]); // mul r4, r5
    cpu.data[4] = 10;
    cpu.data[5] = 20;
    cpu.tick();
    expect(cpu.data[0]).toBe(200);
    expect(cpu.data[1]).toBe(0);
    expect(cpu.sreg.Z).toBe(false);
    expect(cpu.sreg.C).toBe(false);
  });

  test("MUL high byte + carry for products > 0x7FFF", () => {
    const cpu = makeCpu([0x9c45]); // mul r4, r5
    cpu.data[4] = 0xff;
    cpu.data[5] = 0xff; // 65025 = 0xFE01
    cpu.tick();
    expect(cpu.data[0]).toBe(0x01);
    expect(cpu.data[1]).toBe(0xfe);
    expect(cpu.sreg.C).toBe(true); // product bit15 set
  });

  test("MULS multiplies signed operands (-1 * 2 = -2)", () => {
    const cpu = makeCpu([0x0201]); // muls r16, r17
    cpu.data[16] = 0xff; // -1
    cpu.data[17] = 0x02; // +2
    cpu.tick();
    expect(cpu.data[0]).toBe(0xfe);
    expect(cpu.data[1]).toBe(0xff); // 0xFFFE
  });

  test("IJMP jumps to the address in Z", () => {
    const cpu = makeCpu([0x9409]); // ijmp
    cpu.data[30] = 0x10; // Z low
    cpu.data[31] = 0x00; // Z high
    cpu.tick();
    expect(cpu.pc).toBe(0x10);
  });

  test("ICALL pushes the return address then jumps to Z", () => {
    const cpu = makeCpu([0x9509]); // icall
    cpu.data[30] = 0x20;
    cpu.data[31] = 0x00;
    const sp0 = cpu.SP;
    cpu.tick();
    expect(cpu.pc).toBe(0x20);
    expect(cpu.SP).toBe(sp0 - 2);
  });

  test("BST then BLD copy a bit through the T flag", () => {
    const cpu = makeCpu([0xfb03, 0xf910]); // bst r16,3 ; bld r17,0
    cpu.data[16] = 0x08; // bit3 set
    cpu.data[17] = 0x00;
    cpu.tick();
    expect(cpu.sreg.T).toBe(true);
    cpu.tick();
    expect(cpu.data[17]! & 1).toBe(1);
  });

  test("BSET/BCLR set and clear SREG bits (SEC, CLZ)", () => {
    const cpu = makeCpu([0x9408, 0x9498]); // sec ; clz
    cpu.sreg.Z = true;
    cpu.tick();
    expect(cpu.sreg.C).toBe(true);
    cpu.tick();
    expect(cpu.sreg.Z).toBe(false);
  });

  test("SEI/CLI still resolve to their dedicated handlers (specific wins)", () => {
    const cpu = makeCpu([0x9478, 0x94f8]); // sei ; cli
    cpu.tick();
    expect(cpu.sreg.I).toBe(true);
    cpu.tick();
    expect(cpu.sreg.I).toBe(false);
  });

  test("BRVS branches when V is set", () => {
    const cpu = makeCpu([0xf00b]); // brvs +1
    cpu.sreg.V = true;
    cpu.tick();
    expect(cpu.pc).toBe(2);
  });

  test("SLEEP and WDR advance like a NOP", () => {
    const cpu = makeCpu([0x9588, 0x95a8]); // sleep ; wdr
    cpu.tick();
    expect(cpu.pc).toBe(1);
    cpu.tick();
    expect(cpu.pc).toBe(2);
  });

  test("decoder builds with the expanded set; specific opcodes win over generic", () => {
    const d = new Decoder();
    expect(d.mnemonicOf(0x9c45)).toBe("MUL");
    expect(d.mnemonicOf(0x9409)).toBe("IJMP");
    expect(d.mnemonicOf(0x9408)).toBe("BSET");
    expect(d.mnemonicOf(0x9478)).toBe("SEI"); // SEI (0xFFFF) beats BSET (0xFF8F)
    expect(d.mnemonicOf(0x9508)).toBe("RET"); // RET beats ICALL region
  });
});
