import { describe, expect, test } from "bun:test";
import {
  AVR,
  CPU,
  DDRB,
  Decoder,
  FLASH_WORDS,
  PINB,
  PORTB,
  RXC0,
  RXEN0,
  TIMER0_OVF_VECTOR,
  UCSR0A,
  UCSR0B,
  UDR0,
} from "../src";
import { DEFAULT_USART_FRAME_CYCLES } from "./helpers";

function makeCpu(program: number[]): CPU {
  const flash = new Uint16Array(FLASH_WORDS);
  flash.set(program);
  const cpu = new CPU(flash);
  cpu.setExecutor(new Decoder());
  return cpu;
}

describe("USART RX is firmware-readable", () => {
  test("queued host bytes are delivered to firmware reads of UDR0", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    cpu.writeData(UCSR0B, 1 << RXEN0); // enable the receiver
    avr.serial.write("Hi");

    avr.runCycles(DEFAULT_USART_FRAME_CYCLES * 2); // one frame per byte
    expect((cpu.readData(UCSR0A) >> RXC0) & 1).toBe(1); // RXC0: data available
    expect(cpu.readData(UDR0)).toBe(0x48); // 'H'
    expect(cpu.readData(UDR0)).toBe(0x69); // 'i'
    expect((cpu.readData(UCSR0A) >> RXC0) & 1).toBe(0); // queue drained
  });

  test("RXC0 stays clear until the receiver is enabled, then surfaces", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    avr.serial.write("x"); // queued before Serial.begin enables RXEN0
    avr.runCycles(DEFAULT_USART_FRAME_CYCLES * 2);
    expect((cpu.readData(UCSR0A) >> RXC0) & 1).toBe(0);

    cpu.writeData(UCSR0B, 1 << RXEN0); // enabling RX starts shifting the byte
    avr.runCycles(DEFAULT_USART_FRAME_CYCLES);
    expect((cpu.readData(UCSR0A) >> RXC0) & 1).toBe(1);
    expect(cpu.readData(UDR0)).toBe(0x78); // 'x'
  });
});

describe("PINx reflects effective pin state", () => {
  test("an output pin driven high reads back high on PINx", () => {
    const cpu = AVR().cpu;
    cpu.writeData(DDRB, 0x20); // PB5 output
    cpu.writeData(PORTB, 0x20); // drive it high
    expect((cpu.readData(PINB) >> 5) & 1).toBe(1);
  });

  test("an input pin reflects the injected external level", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    cpu.writeData(DDRB, 0x00); // PB0 input
    avr.pin(8).setInput(true); // drive PB0 high externally
    expect(cpu.readData(PINB) & 1).toBe(1);
    avr.pin(8).setInput(false);
    expect(cpu.readData(PINB) & 1).toBe(0);
  });
});

describe("interrupt entry bills cycles to peripherals", () => {
  test("the 4 dispatch cycles reach cycle listeners", () => {
    const cpu = makeCpu([
      0x9478, // 0x0000: sei
      0x0000, // 0x0001: nop (interrupt taken right after)
      0xcfff, // 0x0002: rjmp -1
      ...new Array(TIMER0_OVF_VECTOR - 3).fill(0x0000),
      0x9518, // 0x0020: reti
    ]);
    let delivered = 0;
    cpu.onCycles((cycles) => {
      delivered += cycles;
    });

    cpu.tick(); // sei -> 1 cycle
    cpu.requestInterrupt(TIMER0_OVF_VECTOR);
    const before = delivered;
    cpu.tick(); // nop (1) + interrupt entry (4)

    expect(delivered - before).toBe(5);
    expect(cpu.pc).toBe(TIMER0_OVF_VECTOR);
  });
});
