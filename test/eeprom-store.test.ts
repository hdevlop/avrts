import { describe, expect, test } from "bun:test";
import { AVR } from "../src";

// Phase 8 Arduino library validation: the real Arduino EEPROM library.
// EEPROM.write/update/put drive the EECR/EEDR/EEAR protocol and busy-wait on
// EEPE, so each byte takes real simulated time to commit. This sketch stores a
// short record and reads it back through EEPROM.read/EEPROM.get; the test
// confirms both the SRAM read-back block and the persisted EEPROM cells,
// exercising the full firmware EEPROM path end to end. Result block:
// [marker, r0, r1, r2, getLo, getHi, marker].

async function loadEeprom(): Promise<ReturnType<typeof AVR>> {
  const hex = await Bun.file(
    new URL("../examples/arduino-eeprom-store/arduino-eeprom-store.ino.hex", import.meta.url),
  ).text();
  const avr = AVR(hex);
  avr.runCycles(2_000_000); // EEPROM writes busy-wait ~3.3 ms each to commit.
  return avr;
}

describe("Arduino EEPROM library sketch", () => {
  test("reads back the stored record into the SRAM result block", async () => {
    const avr = await loadEeprom();
    const result = (offset: number) => avr.cpu.data[0x0300 + offset]!;

    expect(result(0)).toBe(0xa7);
    expect(result(1)).toBe(0xa5);
    expect(result(2)).toBe(0x3c);
    expect(result(3)).toBe(0x7e);
    expect(result(4) | (result(5) << 8)).toBe(0xbeef); // EEPROM.get 16-bit.
    expect(result(6)).toBe(0x5c);
  });

  test("persists the record in the actual EEPROM cells", async () => {
    const avr = await loadEeprom();

    expect(avr.eeprom.read(0)).toBe(0xa5);
    expect(avr.eeprom.read(1)).toBe(0x3c);
    expect(avr.eeprom.read(2)).toBe(0x7e);
    // 16-bit EEPROM.put stored little-endian across cells 4..5.
    expect(avr.eeprom.read(4)).toBe(0xef);
    expect(avr.eeprom.read(5)).toBe(0xbe);
  });
});
