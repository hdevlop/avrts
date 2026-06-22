import { describe, expect, test } from "bun:test";
import {
  CPU,
  DATA_SIZE,
  FLASH_WORDS,
  PORTB,
  RAMEND,
  SPH_ADDR,
  SPL_ADDR,
  SREG_ADDR,
} from "../src/cpu";

describe("CPU shell", () => {
  test("sizes flash and data per the ATmega328P memory map", () => {
    const cpu = new CPU();
    expect(cpu.flash.length).toBe(FLASH_WORDS); // 0x4000 words = 32 KB
    expect(cpu.data.length).toBe(DATA_SIZE); // 0x900 bytes
  });

  test("reset() restores power-on state", () => {
    const cpu = new CPU();
    cpu.pc = 0x123;
    cpu.cycles = 999;
    cpu.writeData(0x100, 0x42);
    cpu.reset();
    expect(cpu.pc).toBe(0);
    expect(cpu.cycles).toBe(0);
    expect(cpu.readData(0x100)).toBe(0);
    expect(cpu.SP).toBe(RAMEND);
  });

  test("readData/writeData round-trips and masks to 8 bits", () => {
    const cpu = new CPU();
    cpu.writeData(PORTB, 0xab);
    expect(cpu.readData(PORTB)).toBe(0xab);
    cpu.writeData(PORTB, 0x1ff);
    expect(cpu.readData(PORTB)).toBe(0xff);
  });

  test("SP spans SPL/SPH little-endian", () => {
    const cpu = new CPU();
    cpu.SP = 0x08ff;
    expect(cpu.data[SPL_ADDR]).toBe(0xff);
    expect(cpu.data[SPH_ADDR]).toBe(0x08);
    expect(cpu.SP).toBe(0x08ff);
  });

  test("I/O access translates by +0x20 (I/O 0x05 == PORTB == data 0x25)", () => {
    const cpu = new CPU();
    cpu.writeIo(0x05, 0x20);
    expect(cpu.readData(PORTB)).toBe(0x20);
    expect(cpu.readIo(0x05)).toBe(0x20);
  });

  test("onTrace registers and unsubscribes", () => {
    const cpu = new CPU();
    const seen: number[] = [];
    const off = cpu.onTrace((s) => seen.push(s.pc));
    cpu.emitTrace({ pc: 7, opcode: 0, mnemonic: "NOP", cycles: 1 });
    off();
    cpu.emitTrace({ pc: 9, opcode: 0, mnemonic: "NOP", cycles: 2 });
    expect(seen).toEqual([7]);
  });
});

describe("SREG flags", () => {
  const FLAGS = ["C", "Z", "N", "V", "S", "H", "T", "I"] as const;

  test("set/get each flag independently", () => {
    const cpu = new CPU();
    for (const flag of FLAGS) {
      cpu.sreg.set(flag, true);
      expect(cpu.sreg.get(flag)).toBe(true);
    }
    expect(cpu.data[SREG_ADDR]).toBe(0xff);

    for (const flag of FLAGS) cpu.sreg.set(flag, false);
    expect(cpu.data[SREG_ADDR]).toBe(0x00);
  });

  test("named accessors map to the correct bit positions", () => {
    const cpu = new CPU();
    cpu.sreg.C = true;
    expect(cpu.data[SREG_ADDR]).toBe(0b0000_0001);
    cpu.sreg.I = true;
    expect(cpu.data[SREG_ADDR]).toBe(0b1000_0001);
    cpu.sreg.C = false;
    expect(cpu.data[SREG_ADDR]).toBe(0b1000_0000);
  });

  test("sreg.value mirrors data[0x5F]", () => {
    const cpu = new CPU();
    cpu.sreg.value = 0x2a;
    expect(cpu.data[SREG_ADDR]).toBe(0x2a);
    cpu.data[SREG_ADDR] = 0x55;
    expect(cpu.sreg.value).toBe(0x55);
  });
});
