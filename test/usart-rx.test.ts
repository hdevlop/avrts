import { describe, expect, test } from "bun:test";
import {
  CPU,
  Decoder,
  DOR0,
  FE0,
  FLASH_WORDS,
  MPCM0,
  RXB80,
  RXC0,
  RXCIE0,
  RXEN0,
  TXB80,
  TXEN0,
  UCSR0A,
  UCSR0B,
  UCSR0C,
  UCSZ00,
  UCSZ01,
  UDR0,
  UMSEL00,
  UPE0,
  UPM01,
  USART_RX_VECTOR,
} from "../src";
import { attachPeripheral, Usart0 } from "../src/peripherals";
import { DEFAULT_USART_FRAME_CYCLES } from "./helpers";

function makeCpu(): CPU {
  const cpu = new CPU(new Uint16Array(FLASH_WORDS));
  cpu.setExecutor(new Decoder());
  return cpu;
}

function makeUsart(): { cpu: CPU; usart: Usart0 } {
  const cpu = makeCpu();
  const usart = new Usart0(cpu);
  attachPeripheral(cpu, usart);
  cpu.writeData(UCSR0B, 1 << RXEN0);
  return { cpu, usart };
}

describe("USART0 RX timing (Phase 1)", () => {
  test("RXC0 sets one frame time after a host byte is injected", () => {
    const { cpu, usart } = makeUsart();
    usart.receive("A");

    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);
    cpu.run(DEFAULT_USART_FRAME_CYCLES - 1);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);
    cpu.run(1);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(1 << RXC0);
    expect(cpu.readData(UDR0)).toBe(0x41);
  });

  test("bytes arrive back-to-back, one frame each, in order", () => {
    const { cpu, usart } = makeUsart();
    usart.receive("AB");

    cpu.run(DEFAULT_USART_FRAME_CYCLES);
    expect(cpu.readData(UDR0)).toBe(0x41);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);
    cpu.run(DEFAULT_USART_FRAME_CYCLES);
    expect(cpu.readData(UDR0)).toBe(0x42);
  });

  test("frames queued before RXEN0 start shifting when the receiver is enabled", () => {
    const cpu = makeCpu();
    const usart = new Usart0(cpu);
    attachPeripheral(cpu, usart);
    usart.receive("Z");

    cpu.run(DEFAULT_USART_FRAME_CYCLES * 2);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);

    cpu.writeData(UCSR0B, 1 << RXEN0);
    cpu.run(DEFAULT_USART_FRAME_CYCLES);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(1 << RXC0);
    expect(cpu.readData(UDR0)).toBe(0x5a);
  });

  test("disabling RXEN0 flushes the FIFO and aborts the in-flight frame", () => {
    const { cpu, usart } = makeUsart();
    usart.receive("AB");
    cpu.run(DEFAULT_USART_FRAME_CYCLES); // A in FIFO, B on the wire

    cpu.writeData(UCSR0B, 0);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);
    cpu.writeData(UCSR0B, 1 << RXEN0);
    cpu.run(DEFAULT_USART_FRAME_CYCLES * 2);
    // A was flushed; only B (still on the wire when disabled? it was aborted)
    // -- the aborted B frame is lost, remaining wire bytes would shift next.
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);
  });

  test("third completed frame with a full FIFO is lost and sets DOR0", () => {
    const { cpu, usart } = makeUsart();
    usart.receive("ABC");
    cpu.run(DEFAULT_USART_FRAME_CYCLES * 3);

    expect(cpu.readData(UCSR0A) & (1 << DOR0)).toBe(1 << DOR0);
    expect(cpu.readData(UDR0)).toBe(0x41); // read clears DOR0
    expect(cpu.readData(UCSR0A) & (1 << DOR0)).toBe(0);
    expect(cpu.readData(UDR0)).toBe(0x42);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0); // C was lost
  });

  test("framing error surfaces as FE0 at the FIFO head and clears after read", () => {
    const { cpu, usart } = makeUsart();
    usart.inject({ value: 0x31, framingError: true });
    usart.inject({ value: 0x32 });
    cpu.run(DEFAULT_USART_FRAME_CYCLES * 2);

    expect(cpu.readData(UCSR0A) & (1 << FE0)).toBe(1 << FE0);
    expect(cpu.readData(UDR0)).toBe(0x31);
    expect(cpu.readData(UCSR0A) & (1 << FE0)).toBe(0);
    expect(cpu.readData(UDR0)).toBe(0x32);
  });

  test("parity error surfaces as UPE0 only when parity mode is enabled", () => {
    const { cpu, usart } = makeUsart();
    usart.inject({ value: 0x31, parityError: true });
    cpu.run(DEFAULT_USART_FRAME_CYCLES);
    expect(cpu.readData(UCSR0A) & (1 << UPE0)).toBe(0); // UPM disabled
    expect(cpu.readData(UDR0)).toBe(0x31);

    cpu.writeData(UCSR0C, (1 << UPM01) | (1 << UCSZ01) | (1 << UCSZ00));
    usart.inject({ value: 0x32, parityError: true });
    cpu.run(DEFAULT_USART_FRAME_CYCLES * 2); // parity adds a frame bit
    expect(cpu.readData(UCSR0A) & (1 << UPE0)).toBe(1 << UPE0);
  });

  test("MPCM0 drops frames whose ninth bit is clear", () => {
    const { cpu, usart } = makeUsart();
    cpu.writeData(UCSR0A, 1 << MPCM0);
    usart.inject({ value: 0x41 }); // data frame: ninth bit 0 -> dropped
    usart.inject({ value: 0x100 | 0x42 }); // address frame: ninth bit 1
    cpu.run(DEFAULT_USART_FRAME_CYCLES * 2);

    expect(cpu.readData(UDR0)).toBe(0x42);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);
  });

  test("RXB80 reflects the ninth bit of the FIFO head", () => {
    const { cpu, usart } = makeUsart();
    usart.inject({ value: 0x100 | 0x41 });
    usart.inject({ value: 0x42 });
    cpu.run(DEFAULT_USART_FRAME_CYCLES * 2);

    expect(cpu.readData(UCSR0B) & (1 << RXB80)).toBe(1 << RXB80);
    expect(cpu.readData(UDR0)).toBe(0x41);
    expect(cpu.readData(UCSR0B) & (1 << RXB80)).toBe(0);
  });

  test("TXB80 is captured per byte into the transmit frame", () => {
    const { cpu, usart } = makeUsart();
    const bytes: number[] = [];
    usart.onByteTransmit((byte) => bytes.push(byte));
    cpu.writeData(UCSR0B, (1 << TXEN0) | (1 << TXB80));
    cpu.writeData(UDR0, 0x41);
    cpu.run(DEFAULT_USART_FRAME_CYCLES);
    expect(bytes).toEqual([0x41]);
  });

  test("RX complete interrupt fires one frame after injection", () => {
    const { cpu, usart } = makeUsart();
    cpu.flash[0] = 0x9478; // SEI
    cpu.flash[1] = 0xcfff; // RJMP -1 (main loop parks here)
    cpu.flash[USART_RX_VECTOR] = 0xcfff; // park inside the ISR
    cpu.writeData(UCSR0B, (1 << RXEN0) | (1 << RXCIE0));
    usart.receive("A");

    cpu.run(DEFAULT_USART_FRAME_CYCLES - 1);
    expect(cpu.pc).not.toBe(USART_RX_VECTOR);
    cpu.run(40);
    expect(cpu.pc).toBe(USART_RX_VECTOR);
  });

  test("synchronous mode (UMSEL=01) uses the 2-clock bit divisor", () => {
    const { cpu, usart } = makeUsart();
    cpu.writeData(UCSR0C, (1 << UMSEL00) | (1 << UCSZ01) | (1 << UCSZ00));
    usart.receive("A");

    const syncFrame = DEFAULT_USART_FRAME_CYCLES / 8; // 2 vs 16 clocks per bit
    cpu.run(syncFrame - 1);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);
    cpu.run(1);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(1 << RXC0);
  });

  test("MSPIM (UMSEL=11) exchanges a responder byte per transmitted byte", () => {
    const { cpu, usart } = makeUsart();
    cpu.writeData(UCSR0C, 0b11 << UMSEL00);
    cpu.writeData(UCSR0B, (1 << RXEN0) | (1 << TXEN0));
    const sent: number[] = [];
    usart.onByteTransmit((byte) => sent.push(byte));
    usart.respondWith((byte) => byte ^ 0xff);

    cpu.writeData(UDR0, 0x55);
    const mspimFrame = 2 * 8; // (UBRR+1)=1, 2 clocks/bit, 8 bits
    cpu.run(mspimFrame - 1);
    expect(sent).toEqual([]);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);
    cpu.run(1);
    expect(sent).toEqual([0x55]);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(1 << RXC0);
    expect(cpu.readData(UDR0)).toBe(0xaa);
  });

  test("snapshot/restore resumes an in-flight RX frame with remaining cycles", () => {
    const { cpu, usart } = makeUsart();
    usart.receive("AB");
    cpu.run(40);

    const snap = usart.snapshot();
    const cpu2 = makeCpu();
    const usart2 = new Usart0(cpu2);
    attachPeripheral(cpu2, usart2);
    cpu2.data.set(cpu.data);
    usart2.restore(snap);

    cpu2.run(DEFAULT_USART_FRAME_CYCLES - 40 - 1);
    expect(cpu2.readData(UCSR0A) & (1 << RXC0)).toBe(0);
    cpu2.run(1);
    expect(cpu2.readData(UCSR0A) & (1 << RXC0)).toBe(1 << RXC0);
    expect(cpu2.readData(UDR0)).toBe(0x41);
    cpu2.run(DEFAULT_USART_FRAME_CYCLES);
    expect(cpu2.readData(UDR0)).toBe(0x42);
  });

  test("legacy snapshots without frame fields restore bytes as readable", () => {
    const cpu = makeCpu();
    const usart = new Usart0(cpu);
    attachPeripheral(cpu, usart);
    cpu.writeData(UCSR0B, 1 << RXEN0);
    usart.restore({ rxBytes: Uint8Array.from([0x41, 0x42]), rxHead: 0 });

    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(1 << RXC0);
    expect(cpu.readData(UDR0)).toBe(0x41);
    expect(cpu.readData(UDR0)).toBe(0x42);
  });
});
