import { FLASH_WORDS } from "../cpu";
import { IntelHexError } from "./errors";
import type { HexLoadResult } from "./types";

// Intel HEX record types we understand.
const REC_DATA = 0x00;
const REC_EOF = 0x01;
const REC_EXT_SEGMENT = 0x02;
const REC_START_SEGMENT = 0x03;
const REC_EXT_LINEAR = 0x04;
const REC_START_LINEAR = 0x05;

/**
 * Parse Intel HEX text and write the program bytes into `flash` (a Uint16Array,
 * indexed by *word*). See docs/02-build-plan.md Phase 4 for the precise rules:
 *
 *  - each line's checksum (two's complement of the byte sum) is validated;
 *  - a byte at HEX byte-address `addr` goes to `flash[addr >> 1]`, little-endian
 *    (even address = low byte, odd address = high byte).
 */
export function loadHex(hexText: string, flash: Uint16Array): HexLoadResult {
  let baseAddress = 0; // upper address bits from type-02/04 records
  let bytesLoaded = 0;
  let maxByteAddress = 0;

  const lines = hexText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i]!.trim();
    if (raw === "") continue;
    if (raw[0] !== ":") {
      throw new IntelHexError(`Line ${lineNo}: record must start with ':'`);
    }

    const bytes = parseRecordBytes(raw, lineNo);
    const count = bytes[0]!;
    if (bytes.length !== count + 5) {
      throw new IntelHexError(
        `Line ${lineNo}: byte count ${count} does not match data length ${bytes.length - 5}`,
      );
    }
    verifyChecksum(bytes, lineNo);

    const recordType = bytes[3]!;
    const recordAddress = (bytes[1]! << 8) | bytes[2]!;

    switch (recordType) {
      case REC_DATA: {
        for (let d = 0; d < count; d += 1) {
          const byteAddress = baseAddress + recordAddress + d;
          writeFlashByte(flash, byteAddress, bytes[4 + d]!, lineNo);
          bytesLoaded += 1;
          if (byteAddress > maxByteAddress) maxByteAddress = byteAddress;
        }
        break;
      }
      case REC_EOF:
        return { bytesLoaded, maxByteAddress };
      case REC_EXT_SEGMENT:
        baseAddress = ((bytes[4]! << 8) | bytes[5]!) << 4;
        break;
      case REC_EXT_LINEAR:
        baseAddress = ((bytes[4]! << 8) | bytes[5]!) * 0x10000;
        break;
      case REC_START_SEGMENT:
      case REC_START_LINEAR:
        break; // entry-point hints — irrelevant to a flash image
      default:
        throw new IntelHexError(
          `Line ${lineNo}: unsupported record type 0x${recordType.toString(16).padStart(2, "0")}`,
        );
    }
  }

  return { bytesLoaded, maxByteAddress };
}

/** Convenience: allocate a full-size flash and load `hexText` into it. */
export function parseHex(hexText: string): Uint16Array {
  const flash = new Uint16Array(FLASH_WORDS);
  loadHex(hexText, flash);
  return flash;
}

function parseRecordBytes(line: string, lineNo: number): number[] {
  const hex = line.slice(1);
  if (hex.length % 2 !== 0) {
    throw new IntelHexError(`Line ${lineNo}: odd number of hex digits`);
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new IntelHexError(`Line ${lineNo}: contains non-hex characters`);
  }
  const bytes: number[] = [];
  for (let j = 0; j < hex.length; j += 2) {
    bytes.push(parseInt(hex.slice(j, j + 2), 16));
  }
  if (bytes.length < 5) {
    throw new IntelHexError(`Line ${lineNo}: record too short`);
  }
  return bytes;
}

function verifyChecksum(bytes: number[], lineNo: number): void {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  if (sum !== 0) {
    throw new IntelHexError(`Line ${lineNo}: checksum mismatch`);
  }
}

function writeFlashByte(flash: Uint16Array, byteAddress: number, value: number, lineNo: number): void {
  const word = byteAddress >> 1;
  if (word >= flash.length) {
    throw new IntelHexError(
      `Line ${lineNo}: address 0x${byteAddress.toString(16)} is beyond flash (${flash.length} words)`,
    );
  }
  if ((byteAddress & 1) === 0) {
    flash[word] = (flash[word]! & 0xff00) | value; // low byte
  } else {
    flash[word] = (flash[word]! & 0x00ff) | (value << 8); // high byte
  }
}
