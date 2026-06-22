import { describe, expect, test } from "bun:test";
import {
  AVR,
  CPU,
  CS00,
  DDRB,
  Decoder,
  FLASH_WORDS,
  RAMEND,
  TCCR0B,
  TCNT0,
  TIFR0,
  TIMER0_OVF_VECTOR,
  TIMSK0,
  TOIE0,
} from "../src";
import { attachPeripheral, Timer0 } from "../src/peripherals";

function makeCpu(program: number[]): CPU {
  const flash = new Uint16Array(FLASH_WORDS);
  flash.set(program);
  const cpu = new CPU(flash);
  cpu.setExecutor(new Decoder());
  return cpu;
}

describe("interrupt instructions", () => {
  test("SEI and CLI update the global interrupt flag", () => {
    const cpu = makeCpu([0x9478, 0x94f8]); // sei ; cli

    cpu.tick();
    expect(cpu.sreg.I).toBe(true);
    expect(cpu.pc).toBe(1);

    cpu.tick();
    expect(cpu.sreg.I).toBe(false);
    expect(cpu.pc).toBe(2);
  });

  test("pending interrupt pushes PC, clears I, and RETI resumes with I set", () => {
    const cpu = makeCpu([
      0x9478, // 0x0000: sei
      0x0000, // 0x0001: nop, interrupted after execution
      0xcfff, // 0x0002: rjmp -1 (resume target)
      ...new Array(TIMER0_OVF_VECTOR - 3).fill(0x0000),
      0x9518, // 0x0020: reti
    ]);

    cpu.tick();
    cpu.requestInterrupt(TIMER0_OVF_VECTOR);
    cpu.tick();

    expect(cpu.pc).toBe(TIMER0_OVF_VECTOR);
    expect(cpu.sreg.I).toBe(false);
    expect(cpu.SP).toBe(RAMEND - 2);

    cpu.tick();
    expect(cpu.pc).toBe(2);
    expect(cpu.sreg.I).toBe(true);
    expect(cpu.SP).toBe(RAMEND);
  });
});

describe("Timer0", () => {
  test("overflow sets TOV0 and write-1-to-clear clears it", () => {
    const cpu = makeCpu([0x0000]);
    const timer0 = new Timer0(cpu);
    attachPeripheral(cpu, timer0);

    cpu.writeData(TCCR0B, 0b001); // no prescale
    cpu.writeData(TCNT0, 0xff);
    timer0.tick(1);

    expect(cpu.readData(TCNT0)).toBe(0x00);
    expect(cpu.readData(TIFR0) & 1).toBe(1);

    cpu.writeData(TIFR0, 1);
    expect(cpu.readData(TIFR0) & 1).toBe(0);
  });

  test("enabled overflow interrupt jumps through the facade-wired Timer0", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.flash[0] = 0x9478; // sei
    cpu.flash[1] = 0x0000; // nop
    cpu.flash[2] = 0xcfff; // rjmp -1
    cpu.flash[TIMER0_OVF_VECTOR] = 0x9518; // reti

    cpu.writeData(TCCR0B, 0b001); // no prescale
    cpu.writeData(TCNT0, 0xff);
    cpu.writeData(TIMSK0, 1);

    avr.step(); // sei, Timer0 ticks once and queues overflow, interrupt services
    expect(cpu.pc).toBe(TIMER0_OVF_VECTOR);
    expect(cpu.sreg.I).toBe(false);
    expect(cpu.readData(TIFR0) & 1).toBe(0);

    avr.step(); // reti
    expect(cpu.pc).toBe(1);
    expect(cpu.sreg.I).toBe(true);
  });

  test("runFor advances cycles using the configured clock", () => {
    const avr = AVR({ clockHz: 1_000 });
    avr.runFor(3);
    expect(avr.status().cycles).toBe(3);
  });

  test("Timer0 overflow interrupt drives a periodic, timer-paced blink", () => {
    const avr = AVR().useClock(16_000_000);
    const cpu = avr.cpu;

    // A minimal sketch: reset -> main; the overflow ISR toggles PB5 (Arduino pin
    // 13); main enables interrupts and spins. The LED's cadence is set entirely by
    // Timer0, so this proves end-to-end timer-driven timing (the Phase 6 goal).
    cpu.flash[0x0000] = 0xc02f; // rjmp main (0x0030)
    cpu.flash[TIMER0_OVF_VECTOR] = 0x9a1d; // sbi PINB,5 (write-1-to-PINx toggles PORTx)
    cpu.flash[TIMER0_OVF_VECTOR + 1] = 0x9518; // reti
    cpu.flash[0x0030] = 0x9478; // sei
    cpu.flash[0x0031] = 0xcfff; // rjmp -1 (main loop)

    // setup(): PB5 output, Timer0 free-running (no prescale), overflow interrupt on.
    cpu.writeData(DDRB, 0x20);
    cpu.writeData(TCCR0B, 1 << CS00);
    cpu.writeData(TIMSK0, 1 << TOIE0);

    const edges: number[] = [];
    avr.pin(13).onChange((_high, event) => edges.push(event.cycles));

    avr.runCycles(256 * 20);

    expect(edges.length).toBeGreaterThanOrEqual(16);
    // Every overflow is exactly 256 free-running cycles apart — a steady blink.
    const gaps = edges.slice(1).map((cycle, i) => cycle - edges[i]!);
    for (const gap of gaps) expect(gap).toBe(256);
  });
});
