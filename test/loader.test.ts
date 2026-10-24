import { describe, expect, test } from "bun:test";
import { IntelHexError, loadHex, parseHex } from "../src/loader";

describe("Intel HEX loader", () => {
  test("maps bytes to little-endian flash words", () => {
    // :02 0000 00 0C 94  -> addr0=0x0C (low), addr1=0x94 (high) -> flash[0]=0x940C
    const flash = parseHex(":020000000C945E\n:00000001FF\n");
    expect(flash[0]).toBe(0x940c);
  });

  test("honours the record address (addr 0x0002 -> flash word 1)", () => {
    // :02 0002 00 34 12 -> flash[1] = 0x1234
    const flash = parseHex(":020002003412B6\n:00000001FF\n");
    expect(flash[0]).toBe(0xffff);
    expect(flash[1]).toBe(0x1234);
  });

  test("reports bytes loaded and the highest address", () => {
    const flash = new Uint16Array(0x4000);
    const result = loadHex(":020000000C945E\n:00000001FF\n", flash);
    expect(result.bytesLoaded).toBe(2);
    expect(result.maxByteAddress).toBe(1);
  });

  test("stops at the EOF record", () => {
    // A bogus line after EOF must be ignored (parsing already returned).
    const flash = parseHex(":00000001FF\nGARBAGE\n");
    expect(flash[0]).toBe(0xffff);
  });

  test("rejects a line with a wrong checksum", () => {
    // Same as the valid record but checksum 0x5F instead of 0x5E.
    expect(() => parseHex(":020000000C945F\n:00000001FF\n")).toThrow(IntelHexError);
  });

  test("rejects non-hex characters", () => {
    expect(() => parseHex(":0200000ZZZ9999\n")).toThrow(IntelHexError);
  });

  test("rejects a record that overflows flash", () => {
    // Tiny 1-word flash, but the record targets byte address 0x10.
    const flash = new Uint16Array(1);
    expect(() => loadHex(":0100100042AD\n:00000001FF\n", flash)).toThrow(IntelHexError);
  });

  test("ignores blank lines and trims whitespace", () => {
    const flash = parseHex("\n  :020000000C945E  \n\n:00000001FF\n");
    expect(flash[0]).toBe(0x940c);
  });

  test("rejects extended linear addresses across the signed 32-bit boundary", () => {
    for (const upper of [":020000047FFF7C", ":0200000480007A", ":02000004FFFFFC"]) {
      expect(() => parseHex(`${upper}\n:0100000042BD\n:00000001FF`)).toThrow(/beyond flash/);
    }
  });

  for (const type of [2, 4]) {
    test(`extended address type ${type} requires exactly two data bytes`, () => {
      const record = (data: number[]) => {
        const bytes = [data.length, 0, 0, type, ...data];
        bytes.push((-bytes.reduce((sum, byte) => sum + byte, 0)) & 0xff);
        return ":" + bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      for (const data of [[], [0], [0, 0, 0]]) {
        expect(() => parseHex(record(data))).toThrow(/exactly 2 data bytes/);
      }
      expect(() => parseHex(record([0, 0]))).not.toThrow();
      const hex = record([0, 1]) + "\n:0100000042BD";
      if (type === 2) expect(parseHex(hex)[8]! & 0xff).toBe(0x42);
      else expect(() => parseHex(hex)).toThrow(/beyond flash/);
    });
  }
});
