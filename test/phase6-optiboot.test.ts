import { describe, expect, test } from "bun:test";
import { AVR, FLASH_WORDS, loadHex, PORTB } from "../src";

const PAGE_BYTES = 128;
const BOOTRST_256_WORD_BOOT_HIGH_FUSE = 0xde;
const STK_OK = 0x10;
const STK_INSYNC = 0x14;
const CRC_EOP = 0x20;
const STK_GET_SYNC = 0x30;
const STK_LEAVE_PROGMODE = 0x51;
const STK_LOAD_ADDRESS = 0x55;
const STK_PROG_PAGE = 0x64;
const STK_READ_PAGE = 0x74;

type Avr = ReturnType<typeof AVR>;

interface HexImage {
  bytes: Uint8Array;
  maxByteAddress: number;
}

class Stk500Client {
  private readonly rx: number[] = [];
  private cursor = 0;

  constructor(private readonly avr: Avr) {
    avr.serial.onByte((byte) => this.rx.push(byte & 0xff));
  }

  command(bytes: number[], responseLength = 2): number[] {
    this.avr.serial.write(Uint8Array.from([...bytes, CRC_EOP]));
    return this.read(responseLength);
  }

  sync(): void {
    expect(this.command([STK_GET_SYNC])).toEqual([STK_INSYNC, STK_OK]);
  }

  loadAddress(byteAddress: number): void {
    const wordAddress = byteAddress >> 1;
    expect(this.command([STK_LOAD_ADDRESS, wordAddress & 0xff, (wordAddress >> 8) & 0xff])).toEqual([
      STK_INSYNC,
      STK_OK,
    ]);
  }

  programPage(bytes: Uint8Array): void {
    expect(bytes.length).toBe(PAGE_BYTES);
    expect(
      this.command([STK_PROG_PAGE, (bytes.length >> 8) & 0xff, bytes.length & 0xff, 0x46, ...bytes]),
    ).toEqual([STK_INSYNC, STK_OK]);
  }

  readPage(length: number): number[] {
    const response = this.command([STK_READ_PAGE, (length >> 8) & 0xff, length & 0xff, 0x46], length + 2);
    expect(response[0]).toBe(STK_INSYNC);
    expect(response.at(-1)).toBe(STK_OK);
    return response.slice(1, -1);
  }

  leaveProgrammingMode(): void {
    expect(this.command([STK_LEAVE_PROGMODE])).toEqual([STK_INSYNC, STK_OK]);
  }

  private read(length: number): number[] {
    const startCycle = this.avr.cpu.cycles;
    while (this.rx.length - this.cursor < length && this.avr.cpu.cycles - startCycle < 8_000_000) {
      this.avr.runCycles(500);
    }
    const available = this.rx.length - this.cursor;
    if (available < length) {
      throw new Error(
        `Timed out waiting for ${length} STK500 byte(s); got ${available}: ${this.rx
          .slice(this.cursor)
          .map((byte) => `0x${byte.toString(16).padStart(2, "0")}`)
          .join(" ")}`,
      );
    }
    const out = this.rx.slice(this.cursor, this.cursor + length);
    this.cursor += length;
    return out;
  }
}

function imageFromHex(hex: string): HexImage {
  const flash = new Uint16Array(FLASH_WORDS);
  flash.fill(0xffff);
  const result = loadHex(hex, flash);
  const bytes = new Uint8Array(result.maxByteAddress + 1);
  bytes.fill(0xff);
  for (let address = 0; address <= result.maxByteAddress; address++) {
    const word = flash[address >> 1]!;
    bytes[address] = (address & 1) === 0 ? word & 0xff : word >> 8;
  }
  return { bytes, maxByteAddress: result.maxByteAddress };
}

function page(image: HexImage, pageBase: number): Uint8Array {
  const out = new Uint8Array(PAGE_BYTES);
  out.fill(0xff);
  out.set(image.bytes.subarray(pageBase, Math.min(pageBase + PAGE_BYTES, image.bytes.length)));
  return out;
}

async function createOptibootRuntime(): Promise<Avr> {
  const optiboot = await Bun.file(
    new URL("../examples/optiboot/optiboot_atmega328.hex", import.meta.url),
  ).text();
  const avr = AVR().useClock(16_000_000).useFuses({ high: BOOTRST_256_WORD_BOOT_HIGH_FUSE });
  avr.cpu.flash.fill(0xffff);
  loadHex(optiboot, avr.cpu.flash);
  avr.resetExternal();
  return avr;
}

describe("Phase 6 Optiboot validation", () => {
  test("stock Optiboot accepts STK500v1 serial programming and runs the uploaded app", async () => {
    const app = imageFromHex(await Bun.file(new URL("../examples/blink/blink.hex", import.meta.url)).text());
    const avr = await createOptibootRuntime();
    const stk = new Stk500Client(avr);

    stk.sync();

    for (let pageBase = 0; pageBase <= app.maxByteAddress; pageBase += PAGE_BYTES) {
      const pageBytes = page(app, pageBase);
      stk.loadAddress(pageBase);
      stk.programPage(pageBytes);
      stk.loadAddress(pageBase);
      expect(stk.readPage(PAGE_BYTES)).toEqual([...pageBytes]);
    }

    const portB: number[] = [];
    avr.watchData(PORTB, (event) => portB.push(event.value));
    stk.leaveProgrammingMode();
    avr.runCycles(600_000);

    expect(portB).toContain(0x20);
    expect(portB).toContain(0x00);
  });
});
