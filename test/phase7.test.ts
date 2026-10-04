import { describe, expect, test } from "bun:test";
import {
  AVR,
  CPU,
  Decoder,
  FLASH_WORDS,
  RXC0,
  RXCIE0,
  RXEN0,
  TXC0,
  TXCIE0,
  TXEN0,
  UCSR0A,
  UCSR0B,
  UDR0,
  UDRIE0,
  UDRE0,
  USART_RX_VECTOR,
  USART_TX_VECTOR,
  USART_UDRE_VECTOR,
} from "../src";
import { attachPeripheral, Usart0 } from "../src/peripherals";
import { DEFAULT_USART_FRAME_CYCLES } from "./helpers";

function makeCpu(program: number[]): CPU {
  const flash = new Uint16Array(FLASH_WORDS);
  flash.set(program);
  const cpu = new CPU(flash);
  cpu.setExecutor(new Decoder());
  return cpu;
}

describe("USART0", () => {
  test("reset exposes a ready data register", () => {
    const cpu = makeCpu([]);
    const usart = new Usart0(cpu);

    expect(cpu.readData(UCSR0A) & (1 << UDRE0)).toBe(1 << UDRE0);
    void usart;
  });

  test("writing UDR0 emits a byte after the configured frame delay", () => {
    const cpu = makeCpu([]);
    const usart = new Usart0(cpu);
    attachPeripheral(cpu, usart);
    const bytes: number[] = [];

    usart.onByteTransmit((byte) => bytes.push(byte));
    cpu.writeData(UCSR0B, 1 << TXEN0);
    cpu.writeData(UDR0, 0x41);

    expect(bytes).toEqual([]);
    expect(cpu.readData(UCSR0A) & (1 << UDRE0)).toBe(1 << UDRE0);
    expect(cpu.readData(UCSR0A) & (1 << TXC0)).toBe(0);
    cpu.run(DEFAULT_USART_FRAME_CYCLES - 1);
    expect(bytes).toEqual([]);
    expect(cpu.readData(UCSR0A) & (1 << TXC0)).toBe(0);
    cpu.run(1);
    expect(bytes).toEqual([0x41]);
    expect(cpu.readData(UCSR0A) & (1 << UDRE0)).toBe(1 << UDRE0);
    expect(cpu.readData(UCSR0A) & (1 << TXC0)).toBe(1 << TXC0);
  });

  test("TXC0 is write-1-to-clear", () => {
    const cpu = makeCpu([]);
    const usart = new Usart0(cpu);
    attachPeripheral(cpu, usart);

    cpu.writeData(UCSR0B, 1 << TXEN0);
    cpu.writeData(UDR0, 0x41);
    cpu.run(DEFAULT_USART_FRAME_CYCLES);
    cpu.writeData(UCSR0A, 1 << TXC0);

    expect(cpu.readData(UCSR0A) & (1 << TXC0)).toBe(0);
    expect(cpu.readData(UCSR0A) & (1 << UDRE0)).toBe(1 << UDRE0);
  });

  test("double buffer accepts two quick writes and ignores a third while full", () => {
    const cpu = makeCpu([]);
    const usart = new Usart0(cpu);
    attachPeripheral(cpu, usart);
    const bytes: number[] = [];

    usart.onByteTransmit((byte) => bytes.push(byte));
    cpu.writeData(UCSR0B, 1 << TXEN0);
    cpu.writeData(UDR0, 0x41);
    cpu.writeData(UDR0, 0x42);
    cpu.writeData(UDR0, 0x43);

    expect(cpu.readData(UCSR0A) & (1 << UDRE0)).toBe(0);
    cpu.run(DEFAULT_USART_FRAME_CYCLES);
    expect(bytes).toEqual([0x41]);
    expect(cpu.readData(UCSR0A) & (1 << UDRE0)).toBe(1 << UDRE0);
    expect(cpu.readData(UCSR0A) & (1 << TXC0)).toBe(0);
    cpu.run(DEFAULT_USART_FRAME_CYCLES);
    expect(bytes).toEqual([0x41, 0x42]);
    expect(cpu.readData(UCSR0A) & (1 << TXC0)).toBe(1 << TXC0);
  });

  test("snapshot restores an in-flight frame plus buffered byte", () => {
    const source = AVR();
    source.cpu.flash[0] = 0xcfff;
    source.cpu.writeData(UCSR0B, 1 << TXEN0);
    source.cpu.writeData(UDR0, 0x41);
    source.cpu.writeData(UDR0, 0x42);
    source.runCycles(40);

    const restored = AVR();
    const bytes: number[] = [];
    restored.restore(source.snapshot());
    restored.serial.onByte((byte) => bytes.push(byte));
    restored.runCycles(DEFAULT_USART_FRAME_CYCLES - 40 - 2);
    expect(bytes).toEqual([]);
    restored.runCycles(2);
    expect(bytes).toEqual([0x41]);
    expect(restored.cpu.readData(UCSR0A) & (1 << TXC0)).toBe(0);
    restored.runCycles(DEFAULT_USART_FRAME_CYCLES);
    expect(bytes).toEqual([0x41, 0x42]);
    expect(restored.cpu.readData(UCSR0A) & (1 << TXC0)).toBe(1 << TXC0);
  });

  test("U2X0/MPCM0 writes are preserved while hardware status bits stay owned", () => {
    const cpu = makeCpu([]);
    const usart = new Usart0(cpu);
    attachPeripheral(cpu, usart);

    cpu.writeData(UCSR0A, 0b0000_0011);

    expect(cpu.readData(UCSR0A) & 0b0000_0011).toBe(0b0000_0011);
    expect(cpu.readData(UCSR0A) & (1 << UDRE0)).toBe(1 << UDRE0);
  });

  test("queued RX bytes are not consumed until RXEN0 is enabled", () => {
    const avr = AVR();

    avr.serial.write("A");
    expect(avr.cpu.readData(UDR0)).toBe(0);
    avr.runCycles(DEFAULT_USART_FRAME_CYCLES * 2);
    expect(avr.cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);

    avr.cpu.writeData(UCSR0B, 1 << RXEN0);
    // Enabling the receiver starts shifting: one frame time to RXC0.
    expect(avr.cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);
    avr.runCycles(DEFAULT_USART_FRAME_CYCLES);
    expect(avr.cpu.readData(UCSR0A) & (1 << RXC0)).toBe(1 << RXC0);
    expect(avr.cpu.readData(UDR0)).toBe(0x41);
  });

  test("RX complete interrupt jumps to USART_RX and leaves RXC0 set until UDR0 is read", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.flash[0] = 0x9478; // sei
    cpu.flash[1] = 0xcfff; // rjmp -1
    cpu.flash[USART_RX_VECTOR] = 0xcfff; // park inside the ISR

    cpu.writeData(UCSR0B, (1 << RXEN0) | (1 << RXCIE0));
    avr.serial.write("R");

    avr.runCycles(DEFAULT_USART_FRAME_CYCLES + 8);
    expect(cpu.pc).toBe(USART_RX_VECTOR);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(1 << RXC0);
    expect(cpu.readData(UDR0)).toBe(0x52);
    expect(cpu.readData(UCSR0A) & (1 << RXC0)).toBe(0);
  });

  test("UDRE interrupt jumps when the data register is empty and UDRIE0 is enabled", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.flash[0] = 0x9478; // sei
    cpu.flash[1] = 0xcfff; // rjmp -1
    cpu.flash[USART_UDRE_VECTOR] = 0x9518; // reti
    cpu.writeData(UCSR0B, (1 << TXEN0) | (1 << UDRIE0));

    avr.step();
    expect(cpu.pc).toBe(1); // SEI permits the following instruction first.
    avr.step();

    expect(cpu.pc).toBe(USART_UDRE_VECTOR);
  });

  test("UDRE interrupt re-fires after RETI while UDRIE0 stays enabled", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.flash[0] = 0x9478; // sei
    cpu.flash[1] = 0xcfff; // rjmp -1
    cpu.flash[USART_UDRE_VECTOR] = 0x9518; // reti
    cpu.writeData(UCSR0B, (1 << TXEN0) | (1 << UDRIE0));

    avr.step();
    expect(cpu.pc).toBe(1);
    avr.step();
    expect(cpu.pc).toBe(USART_UDRE_VECTOR);

    avr.step(); // RETI returns to the main program before dispatching again.
    expect(cpu.pc).toBe(1);
    avr.step();
    expect(cpu.pc).toBe(USART_UDRE_VECTOR);
  });

  test("restored UDRIE0 state still re-evaluates the UDRE interrupt", () => {
    const source = AVR();
    const cpu = source.cpu;

    cpu.flash[0] = 0x9478; // sei
    cpu.flash[1] = 0xcfff; // rjmp -1
    cpu.flash[USART_UDRE_VECTOR] = 0x9518; // reti
    cpu.writeData(UCSR0B, (1 << TXEN0) | (1 << UDRIE0));

    const restored = AVR();
    restored.restore(source.snapshot());
    restored.step();
    expect(restored.cpu.pc).toBe(1);
    restored.step();

    expect(restored.cpu.pc).toBe(USART_UDRE_VECTOR);
  });

  test("TX complete interrupt jumps to USART_TX and acknowledges TXC0", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.flash[0] = 0x9478; // sei
    cpu.flash[1] = 0xcfff; // rjmp -1
    cpu.flash[USART_TX_VECTOR] = 0x9518; // reti
    cpu.writeData(UCSR0B, (1 << TXEN0) | (1 << TXCIE0));
    cpu.writeData(UDR0, 0x54);
    expect(cpu.readData(UCSR0A) & (1 << TXC0)).toBe(0);

    avr.runCycles(DEFAULT_USART_FRAME_CYCLES + 2);

    expect(cpu.pc).toBe(USART_TX_VECTOR);
    expect(cpu.readData(UCSR0A) & (1 << TXC0)).toBe(0);
  });

  test("facade serial captures text from a tiny program", () => {
    const avr = AVR();
    const chunks: string[] = [];

    // ldi r16, TXEN0 ; sts UCSR0B,r16 ; ldi/write 'H' ; ldi/write 'i' ; loop
    avr.cpu.flash.set([
      0xe008, 0x9300, UCSR0B,
      0xe408, 0x9300, UDR0,
      0xe609, 0x9300, UDR0,
      0xcfff,
    ]);

    avr.serial.onText((text) => chunks.push(text));
    avr.runCycles(DEFAULT_USART_FRAME_CYCLES * 2 + 20);

    expect(chunks).toEqual(["H", "i"]);
    expect(avr.serial.getText()).toBe("Hi");
    avr.serial.clear();
    expect(avr.serial.getText()).toBe("");
  });

  test("serial text stays correct past the chunk-compaction threshold with no getText consumer", () => {
    const avr = AVR();
    avr.cpu.flash[0] = 0xcfff; // keep long direct-cycle advances inside flash
    avr.cpu.writeData(UCSR0B, 1 << TXEN0);

    // Emit well past SERIAL_CHUNK_COMPACT_THRESHOLD (1024) without reading
    // getText(), so the internal chunk buffer must compact rather than grow
    // unbounded. Correctness is proven by the final joined text.
    const count = 3000;
    let expected = "";
    for (let i = 0; i < count; i += 1) {
      const byte = 0x41 + (i % 26);
      avr.cpu.writeData(UDR0, byte);
      avr.runCycles(DEFAULT_USART_FRAME_CYCLES);
      expected += String.fromCharCode(byte);
    }

    expect(avr.serial.getText()).toBe(expected);
    expect(avr.serial.getText().length).toBe(count);
  });
});
