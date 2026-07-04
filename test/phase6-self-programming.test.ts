import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import {
  BLBSET,
  PGERS,
  PGWRT,
  RWWSB,
  SELFPRGEN,
  SIGRD,
  SPM_READY_VECTOR,
  SPMCSR,
  SPMIE,
} from "../src/cpu";

const SPM_OPCODE = 0x95e8;
const LPM_R16_Z = 0x9004 | (16 << 4);
const BOOT_256_WORD_START = 0x3f00;
const TARGET_BYTE_ADDRESS = 0x0200;
const TARGET_WORD_ADDRESS = TARGET_BYTE_ADDRESS >> 1;
const BOOT_TARGET_WORD_ADDRESS = BOOT_256_WORD_START + 8;
const BOOT_TARGET_BYTE_ADDRESS = BOOT_TARGET_WORD_ADDRESS << 1;

function setZ(avr: ReturnType<typeof AVR>, byteAddress: number): void {
  avr.cpu.data[30] = byteAddress & 0xff;
  avr.cpu.data[31] = (byteAddress >> 8) & 0xff;
}

function runSpm(avr: ReturnType<typeof AVR>, control: number, pc = BOOT_256_WORD_START): void {
  avr.cpu.flash[pc] = SPM_OPCODE;
  avr.cpu.pc = pc;
  avr.cpu.writeData(SPMCSR, control);
  avr.cpu.tick();
}

describe("Phase 6 self-programming", () => {
  test("LPM fuse-read protocol exposes fuse and lock bytes", () => {
    const avr = AVR().useFuses({ low: 0x62, high: 0xd9, extended: 0xfd, lockBits: 0xcf });
    avr.cpu.flash[0] = LPM_R16_Z;

    const readFuseByte = (address: number): number => {
      avr.cpu.pc = 0;
      setZ(avr, address);
      avr.cpu.writeData(SPMCSR, (1 << SELFPRGEN) | (1 << BLBSET));
      avr.cpu.tick();
      return avr.cpu.data[16]!;
    };

    expect(readFuseByte(0x0000)).toBe(0x62);
    expect(readFuseByte(0x0001)).toBe(0xcf);
    expect(readFuseByte(0x0002)).toBe(0xfd);
    expect(readFuseByte(0x0003)).toBe(0xd9);
  });

  test("LPM signature-read protocol exposes ATmega328P signature bytes", () => {
    const avr = AVR();
    avr.cpu.flash[0] = LPM_R16_Z;

    const readSignatureByte = (address: number): number => {
      avr.cpu.pc = 0;
      setZ(avr, address);
      avr.cpu.writeData(SPMCSR, (1 << SELFPRGEN) | (1 << SIGRD));
      avr.cpu.tick();
      return avr.cpu.data[16]!;
    };

    expect(readSignatureByte(0x0000)).toBe(0x1e);
    expect(readSignatureByte(0x0002)).toBe(0x95);
    expect(readSignatureByte(0x0004)).toBe(0x0f);
  });

  test("SPM page erase, fill, and write work from the boot section", () => {
    const avr = AVR().useFuses({ high: 0xfe });
    const cpu = avr.cpu;

    cpu.flash[TARGET_WORD_ADDRESS] = 0xabcd;
    setZ(avr, TARGET_BYTE_ADDRESS);
    runSpm(avr, (1 << SELFPRGEN) | (1 << PGERS));
    expect(cpu.flash[TARGET_WORD_ADDRESS]).toBe(0xffff);
    expect((cpu.readData(SPMCSR) >> RWWSB) & 1).toBe(1);

    cpu.data[0] = 0x34;
    cpu.data[1] = 0x12;
    setZ(avr, TARGET_BYTE_ADDRESS);
    runSpm(avr, 1 << SELFPRGEN);
    expect(cpu.flash[TARGET_WORD_ADDRESS]).toBe(0xffff);

    setZ(avr, TARGET_BYTE_ADDRESS);
    runSpm(avr, (1 << SELFPRGEN) | (1 << PGWRT));
    expect(cpu.flash[TARGET_WORD_ADDRESS]).toBe(0x1234);
  });

  test("SPM outside the boot section is ignored", () => {
    const avr = AVR().useFuses({ high: 0xfe });
    const cpu = avr.cpu;

    cpu.flash[TARGET_WORD_ADDRESS] = 0x4567;
    setZ(avr, TARGET_BYTE_ADDRESS);
    runSpm(avr, (1 << SELFPRGEN) | (1 << PGERS), 0);

    expect(cpu.flash[TARGET_WORD_ADDRESS]).toBe(0x4567);
    expect(cpu.readData(SPMCSR) & (1 << SELFPRGEN)).toBe(0);
  });

  test("boot lock bits block SPM writes to protected application and boot sections", () => {
    const appProtected = AVR().useFuses({ high: 0xfe, lockBits: 0xfb });
    appProtected.cpu.flash[TARGET_WORD_ADDRESS] = 0x4567;
    setZ(appProtected, TARGET_BYTE_ADDRESS);
    runSpm(appProtected, (1 << SELFPRGEN) | (1 << PGERS));
    expect(appProtected.cpu.flash[TARGET_WORD_ADDRESS]).toBe(0x4567);

    const bootProtected = AVR().useFuses({ high: 0xfe, lockBits: 0xef });
    bootProtected.cpu.flash[BOOT_TARGET_WORD_ADDRESS] = 0x89ab;
    setZ(bootProtected, BOOT_TARGET_BYTE_ADDRESS);
    runSpm(bootProtected, (1 << SELFPRGEN) | (1 << PGERS));
    expect(bootProtected.cpu.flash[BOOT_TARGET_WORD_ADDRESS]).toBe(0x89ab);
  });

  test("boot lock bits block cross-section LPM reads", () => {
    const bootReader = AVR().useFuses({ high: 0xfe, lockBits: 0xf7 });
    bootReader.cpu.flash[TARGET_WORD_ADDRESS] = 0x12ab;
    bootReader.cpu.flash[BOOT_256_WORD_START] = LPM_R16_Z;
    bootReader.cpu.pc = BOOT_256_WORD_START;
    setZ(bootReader, TARGET_BYTE_ADDRESS);
    bootReader.cpu.tick();
    expect(bootReader.cpu.data[16]).toBe(0);

    const appReader = AVR().useFuses({ high: 0xfe, lockBits: 0xdf });
    appReader.cpu.flash[BOOT_TARGET_WORD_ADDRESS] = 0x34cd;
    appReader.cpu.flash[0] = LPM_R16_Z;
    appReader.cpu.pc = 0;
    setZ(appReader, BOOT_TARGET_BYTE_ADDRESS);
    appReader.cpu.tick();
    expect(appReader.cpu.data[16]).toBe(0);
  });

  test("SPM_READY interrupt fires when enabled", () => {
    const avr = AVR().useFuses({ high: 0xfe });
    const cpu = avr.cpu;

    cpu.sreg.I = true;
    setZ(avr, TARGET_BYTE_ADDRESS);
    runSpm(avr, (1 << SELFPRGEN) | (1 << PGERS) | (1 << SPMIE));

    expect(cpu.pc).toBe(SPM_READY_VECTOR);
    expect(cpu.isSleeping).toBe(false);
  });

  test("SPM command window and page buffer survive snapshot restore", () => {
    const source = AVR().useFuses({ high: 0xfe });
    const sourceCpu = source.cpu;

    sourceCpu.data[0] = 0xef;
    sourceCpu.data[1] = 0xbe;
    setZ(source, TARGET_BYTE_ADDRESS);
    runSpm(source, 1 << SELFPRGEN);

    sourceCpu.writeData(SPMCSR, 1 << SELFPRGEN);
    const restored = AVR().restore(source.snapshot());
    expect(restored.cpu.readData(SPMCSR) & (1 << SELFPRGEN)).toBe(1);
    restored.runCycles(3);
    expect(restored.cpu.readData(SPMCSR) & (1 << SELFPRGEN)).toBe(1);
    restored.runCycles(1);
    expect(restored.cpu.readData(SPMCSR) & (1 << SELFPRGEN)).toBe(0);

    setZ(restored, TARGET_BYTE_ADDRESS);
    runSpm(restored, (1 << SELFPRGEN) | (1 << PGWRT));
    expect(restored.cpu.flash[TARGET_WORD_ADDRESS]).toBe(0xbeef);
  });
});
