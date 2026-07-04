import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import { TWAMR, TWAR, TWCR, TWDR, TWEA, TWEN, TWGCE, TWINT, TWSTA, TWSR } from "../src/cpu";
import type { CPU } from "../src/cpu";
import { DEFAULT_TWI_BYTE_CYCLES } from "./helpers";

function enableSlave(cpu: CPU, address: number, generalCall = false): void {
  cpu.writeData(TWAR, ((address & 0x7f) << 1) | (generalCall ? 1 << TWGCE : 0));
  cpu.writeData(TWCR, (1 << TWEN) | (1 << TWEA));
}

function releaseSlave(cpu: CPU, ackNext = true): void {
  cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN) | (ackNext ? 1 << TWEA : 0));
}

function startFirmwareMasterTransfer(avr: ReturnType<typeof AVR>, address = 0x50, read = false): void {
  const cpu = avr.cpu;
  cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN) | (1 << TWEA) | (1 << TWSTA));
  avr.runCycles(1);
  cpu.writeData(TWDR, ((address & 0x7f) << 1) | (read ? 1 : 0));
  cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN) | (1 << TWEA));
}

function runUntilTwintClears(avr: ReturnType<typeof AVR>, maxCycles = 50_000): void {
  for (let elapsed = 0; elapsed < maxCycles; elapsed += 50) {
    if (((avr.cpu.readData(TWCR) >> TWINT) & 1) === 0) return;
    avr.runCycles(50);
  }
  throw new Error("firmware did not clear TWI TWINT in time");
}

function completeHostTwiEvent(avr: ReturnType<typeof AVR>, cycles = 2_000): void {
  avr.runCycles(cycles);
  runUntilTwintClears(avr);
  avr.runCycles(1_000);
}

describe("TWI / I2C slave", () => {
  test("host master writes to an addressed slave with delayed TWINT statuses", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    const master = avr.twi.master();
    enableSlave(cpu, 0x42);

    expect(master.start(0x42, false)).toBe(true);
    expect((cpu.readData(TWCR) >> TWINT) & 1).toBe(0);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES - 1);
    expect((cpu.readData(TWCR) >> TWINT) & 1).toBe(0);
    avr.runCycles(1);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x60);
    expect((cpu.readData(TWCR) >> TWINT) & 1).toBe(1);

    releaseSlave(cpu);
    master.write(0xab);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(cpu.readData(TWDR)).toBe(0xab);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x80);

    releaseSlave(cpu);
    master.stop();
    avr.runCycles(1);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0xa0);
  });

  test("TWEA controls receive-byte ACK vs NACK", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    const master = avr.twi.master();
    enableSlave(cpu, 0x23);

    expect(master.start(0x23, false)).toBe(true);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x60);

    releaseSlave(cpu, false);
    master.write(0x5c);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(cpu.readData(TWDR)).toBe(0x5c);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x88);
  });

  test("TWAMR masks own-address matching and TWGCE enables general call", () => {
    const masked = AVR();
    enableSlave(masked.cpu, 0x50);
    masked.cpu.writeData(TWAMR, 1 << 1);

    expect(masked.twi.master().start(0x51, false)).toBe(true);
    masked.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(masked.cpu.readData(TWSR) & 0xf8).toBe(0x60);

    const general = AVR();
    enableSlave(general.cpu, 0x22, true);

    expect(general.twi.master().start(0x00, false)).toBe(true);
    general.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(general.cpu.readData(TWSR) & 0xf8).toBe(0x70);

    releaseSlave(general.cpu);
    general.twi.master().write(0x11);
    general.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(general.cpu.readData(TWDR)).toBe(0x11);
    expect(general.cpu.readData(TWSR) & 0xf8).toBe(0x90);
  });

  test("host master reads bytes from a slave transmitter", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    const master = avr.twi.master();
    enableSlave(cpu, 0x31);

    expect(master.start(0x31, true)).toBe(true);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0xa8);

    cpu.writeData(TWDR, 0x5a);
    releaseSlave(cpu);
    expect(master.read(true)).toBe(0x5a);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0xb8);

    cpu.writeData(TWDR, 0xc3);
    releaseSlave(cpu, false);
    expect(master.read(true)).toBe(0xc3);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0xc8);

    cpu.writeData(TWDR, 0x7e);
    releaseSlave(cpu);
    expect(master.read(false)).toBe(0x7e);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0xc0);
  });

  test("repeated START ends the active slave transaction without STOP", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    const master = avr.twi.master();
    enableSlave(cpu, 0x42);

    expect(master.start(0x42, false)).toBe(true);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x60);

    releaseSlave(cpu);
    master.write(0x91);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x80);

    releaseSlave(cpu);
    master.restart();
    avr.runCycles(1);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0xa0);

    releaseSlave(cpu);
    expect(master.start(0x42, true)).toBe(true);
    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0xa8);
  });

  test("arbitration-loss injection reports 0x38 and cancels the in-flight master transfer", () => {
    const avr = AVR();
    const stopped: string[] = [];
    avr.twi.connect(0x50, { stop: () => stopped.push("stop") });
    startFirmwareMasterTransfer(avr, 0x50, false);

    expect(avr.twi.master().injectArbitrationLost()).toBe(false);
    avr.runCycles(1);
    expect(avr.cpu.readData(TWSR) & 0xf8).toBe(0x38);
    expect((avr.cpu.readData(TWCR) >> TWINT) & 1).toBe(1);
    expect(stopped).toEqual([]);

    avr.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    expect(avr.cpu.readData(TWSR) & 0xf8).toBe(0x38);
  });

  test("arbitration-loss injection can enter addressed slave receiver/transmitter states", () => {
    const cases = [
      { address: 0x42, read: false, generalCall: false, status: 0x68 },
      { address: 0x00, read: false, generalCall: true, status: 0x78 },
      { address: 0x42, read: true, generalCall: false, status: 0xb0 },
    ];

    for (const { address, read, generalCall, status } of cases) {
      const avr = AVR();
      enableSlave(avr.cpu, 0x42, generalCall);
      startFirmwareMasterTransfer(avr);

      expect(avr.twi.master().injectArbitrationLost(address, read)).toBe(true);
      avr.runCycles(1);
      expect(avr.cpu.readData(TWSR) & 0xf8).toBe(status);
      expect((avr.cpu.readData(TWCR) >> TWINT) & 1).toBe(1);
    }
  });

  test("snapshot restores a pending host-master slave write", () => {
    const source = AVR();
    const cpu = source.cpu;
    const master = source.twi.master();
    enableSlave(cpu, 0x2a);
    master.start(0x2a, false);
    source.runCycles(DEFAULT_TWI_BYTE_CYCLES);
    releaseSlave(cpu);
    master.write(0x66);
    source.runCycles(20);

    const restored = AVR();
    restored.restore(source.snapshot());
    restored.runCycles(DEFAULT_TWI_BYTE_CYCLES - 20 - 1);
    expect((restored.cpu.readData(TWCR) >> TWINT) & 1).toBe(0);
    restored.runCycles(1);
    expect(restored.cpu.readData(TWDR)).toBe(0x66);
    expect(restored.cpu.readData(TWSR) & 0xf8).toBe(0x80);
  });

  test("snapshot restores a pending arbitration-lost slave address event", () => {
    const source = AVR();
    enableSlave(source.cpu, 0x42);
    startFirmwareMasterTransfer(source);
    expect(source.twi.master().injectArbitrationLost(0x42, false)).toBe(true);

    const restored = AVR();
    restored.restore(source.snapshot());
    restored.runCycles(1);
    expect(restored.cpu.readData(TWSR) & 0xf8).toBe(0x68);
    expect((restored.cpu.readData(TWCR) >> TWINT) & 1).toBe(1);
  });

  test("real Arduino Wire.onReceive/onRequest sketch works through the host master API", async () => {
    const hex = await Bun.file(
      new URL("../examples/arduino-wire-slave/arduino-wire-slave.ino.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);
    const master = avr.twi.master();
    const result = (offset: number) => avr.cpu.data[0x0300 + offset]!;

    avr.runCycles(100_000);
    expect(result(0)).toBe(0xa7);
    expect(result(1)).toBe(0);
    expect(result(2)).toBe(0);

    expect(master.start(0x42, false)).toBe(true);
    completeHostTwiEvent(avr);
    master.write(0x11);
    completeHostTwiEvent(avr);
    master.write(0x22);
    completeHostTwiEvent(avr);
    master.write(0x33);
    completeHostTwiEvent(avr);
    master.stop();
    completeHostTwiEvent(avr, 1);

    expect(result(1)).toBe(1);
    expect(result(3)).toBe(3);
    expect(result(4)).toBe(0x11 ^ 0x22 ^ 0x33);
    expect(result(5)).toBe(0x33);

    expect(master.start(0x42, true)).toBe(true);
    completeHostTwiEvent(avr);
    expect(master.read(false)).toBe(0x90 ^ (0x11 ^ 0x22 ^ 0x33) ^ 1);
    completeHostTwiEvent(avr);
    master.stop();
    completeHostTwiEvent(avr, 1);

    expect(result(2)).toBe(1);
    expect(result(6)).toBe(0x90 ^ (0x11 ^ 0x22 ^ 0x33) ^ 1);
    expect(result(7)).toBe(0x5c);
  });
});
