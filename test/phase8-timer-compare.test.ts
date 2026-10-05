import { describe, expect, test } from "bun:test";
import {
  AVR,
  CS00,
  CS10,
  CS20,
  CPU,
  Decoder,
  FLASH_WORDS,
  OCF0A,
  OCF0B,
  OCF1A,
  OCF1B,
  OCF2A,
  OCF2B,
  OCIE0A,
  OCIE0B,
  OCIE1A,
  OCIE1B,
  OCIE2A,
  OCIE2B,
  OCR0A,
  OCR0B,
  OCR1AH,
  OCR1AL,
  OCR1BH,
  OCR1BL,
  OCR2A,
  OCR2B,
  TCCR0B,
  TCCR0A,
  TCCR1B,
  TCCR2B,
  TCCR2A,
  TCNT0,
  TCNT1H,
  TCNT1L,
  TCNT2,
  TIFR0,
  TIFR1,
  TIFR2,
  TIMER0_COMPA_VECTOR,
  TIMER1_COMPA_VECTOR,
  TIMER2_COMPA_VECTOR,
  TIMSK0,
  TIMSK1,
  TIMSK2,
  WGM01,
  WGM12,
  WGM21,
} from "../src";
import { attachPeripheral, Timer0, Timer1, Timer2 } from "../src/peripherals";

function makeCpu(): CPU {
  const cpu = new CPU(new Uint16Array(FLASH_WORDS));
  cpu.setExecutor(new Decoder());
  return cpu;
}

function installProgram(avr: ReturnType<typeof AVR>, vector: number): void {
  avr.cpu.flash[0] = 0x9478; // sei
  avr.cpu.flash[1] = 0xcfff; // rjmp -1
  avr.cpu.flash[vector] = 0x9518; // reti
}

describe("timer compare-match interrupts", () => {
  test("Timer0 COMPA wins priority and COMPB remains flagged", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    installProgram(avr, TIMER0_COMPA_VECTOR);

    cpu.writeData(OCR0A, 1);
    cpu.writeData(OCR0B, 1);
    cpu.writeData(TCCR0B, 1 << CS00);
    cpu.writeData(TIMSK0, (1 << OCIE0A) | (1 << OCIE0B));

    avr.step();

    expect(cpu.pc).toBe(1);
    avr.step();
    expect(cpu.pc).toBe(TIMER0_COMPA_VECTOR);
    expect(cpu.readData(TIFR0) & (1 << OCF0A)).toBe(0);
    expect(cpu.readData(TIFR0) & (1 << OCF0B)).toBe(1 << OCF0B);

    cpu.writeData(TIFR0, 1 << OCF0B);
    expect(cpu.readData(TIFR0) & (1 << OCF0B)).toBe(0);
  });

  test("Timer1 COMPA wins priority and COMPB remains flagged", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    installProgram(avr, TIMER1_COMPA_VECTOR);

    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 1);
    cpu.writeData(OCR1BH, 0);
    cpu.writeData(OCR1BL, 1);
    cpu.writeData(TCCR1B, 1 << CS10);
    cpu.writeData(TIMSK1, (1 << OCIE1A) | (1 << OCIE1B));

    avr.step();

    expect(cpu.pc).toBe(1);
    avr.step();
    expect(cpu.pc).toBe(TIMER1_COMPA_VECTOR);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(0);
    expect(cpu.readData(TIFR1) & (1 << OCF1B)).toBe(1 << OCF1B);

    cpu.writeData(TIFR1, 1 << OCF1B);
    expect(cpu.readData(TIFR1) & (1 << OCF1B)).toBe(0);
  });

  test("Timer2 COMPA wins priority and COMPB remains flagged", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    installProgram(avr, TIMER2_COMPA_VECTOR);

    cpu.writeData(OCR2A, 1);
    cpu.writeData(OCR2B, 1);
    cpu.writeData(TCCR2B, 1 << CS20);
    cpu.writeData(TIMSK2, (1 << OCIE2A) | (1 << OCIE2B));

    avr.step();

    expect(cpu.pc).toBe(1);
    avr.step();
    expect(cpu.pc).toBe(TIMER2_COMPA_VECTOR);
    expect(cpu.readData(TIFR2) & (1 << OCF2A)).toBe(0);
    expect(cpu.readData(TIFR2) & (1 << OCF2B)).toBe(1 << OCF2B);

    cpu.writeData(TIFR2, 1 << OCF2B);
    expect(cpu.readData(TIFR2) & (1 << OCF2B)).toBe(0);
  });

  test("CTC mode resets each timer at OCRnA after the compare match", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(OCR0A, 3);
    cpu.writeData(TCCR0A, 1 << WGM01);
    cpu.writeData(TCCR0B, 1 << CS00);

    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 3);
    cpu.writeData(TCCR1B, (1 << WGM12) | (1 << CS10));

    cpu.writeData(OCR2A, 3);
    cpu.writeData(TCCR2A, 1 << WGM21);
    cpu.writeData(TCCR2B, 1 << CS20);

    avr.runCycles(3);

    expect(cpu.readData(TCNT0)).toBe(3);
    expect(cpu.readData(TCNT1L)).toBe(3);
    expect(cpu.readData(TCNT2)).toBe(3);
    expect(cpu.readData(TIFR0) & (1 << OCF0A)).toBe(0);
    avr.runCycles(1);
    expect(cpu.readData(TCNT0)).toBe(0);
    expect(cpu.readData(TCNT1L)).toBe(0);
    expect(cpu.readData(TCNT2)).toBe(0);
    expect(cpu.readData(TIFR0) & (1 << OCF0A)).toBe(1 << OCF0A);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(1 << OCF1A);
    expect(cpu.readData(TIFR2) & (1 << OCF2A)).toBe(1 << OCF2A);
  });
});

describe("timer bulk advance", () => {
  test("skips quiet counter windows without missing final counts", () => {
    const cpu = makeCpu();
    const timer0 = new Timer0(cpu);
    const timer1 = new Timer1(cpu);
    const timer2 = new Timer2(cpu);
    attachPeripheral(cpu, timer0);
    attachPeripheral(cpu, timer1);
    attachPeripheral(cpu, timer2);

    cpu.writeData(OCR0A, 40);
    cpu.writeData(OCR0B, 80);
    cpu.writeData(TCCR0B, 1 << CS00);

    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 40);
    cpu.writeData(OCR1BH, 0);
    cpu.writeData(OCR1BL, 80);
    cpu.writeData(TCCR1B, 1 << CS10);

    cpu.writeData(OCR2A, 40);
    cpu.writeData(OCR2B, 80);
    cpu.writeData(TCCR2B, 1 << CS20);

    timer0.tick(5);
    timer1.tick(5);
    timer2.tick(5);

    expect(cpu.readData(TCNT0)).toBe(5);
    expect(cpu.readData(TCNT1H)).toBe(0);
    expect(cpu.readData(TCNT1L)).toBe(5);
    expect(cpu.readData(TCNT2)).toBe(5);
    expect(cpu.readData(TIFR0)).toBe(0);
    expect(cpu.readData(TIFR1)).toBe(0);
    expect(cpu.readData(TIFR2)).toBe(0);
  });

  test("falls back at compare boundaries inside a bulk tick", () => {
    const cpu = makeCpu();
    const timer0 = new Timer0(cpu);
    const timer1 = new Timer1(cpu);
    const timer2 = new Timer2(cpu);
    attachPeripheral(cpu, timer0);
    attachPeripheral(cpu, timer1);
    attachPeripheral(cpu, timer2);

    cpu.writeData(TCNT0, 10);
    cpu.writeData(OCR0A, 15);
    cpu.writeData(TCCR0B, 1 << CS00);

    cpu.writeData(TCNT1H, 0);
    cpu.writeData(TCNT1L, 10);
    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 15);
    cpu.writeData(TCCR1B, 1 << CS10);

    cpu.writeData(TCNT2, 10);
    cpu.writeData(OCR2A, 15);
    cpu.writeData(TCCR2B, 1 << CS20);

    timer0.tick(5);
    timer1.tick(5);
    timer2.tick(5);

    expect(cpu.readData(TCNT0)).toBe(15);
    expect(cpu.readData(TCNT1L)).toBe(15);
    expect(cpu.readData(TCNT2)).toBe(15);
    expect(cpu.readData(TIFR0) & (1 << OCF0A)).toBe(0);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(0);
    expect(cpu.readData(TIFR2) & (1 << OCF2A)).toBe(0);
    timer0.tick(1);
    timer1.tick(1);
    timer2.tick(1);
    expect(cpu.readData(TIFR0) & (1 << OCF0A)).toBe(1 << OCF0A);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(1 << OCF1A);
    expect(cpu.readData(TIFR2) & (1 << OCF2A)).toBe(1 << OCF2A);
  });

  test("handles repeated CTC resets inside one bulk tick", () => {
    const cpu = makeCpu();
    const timer0 = new Timer0(cpu);
    const timer1 = new Timer1(cpu);
    const timer2 = new Timer2(cpu);
    attachPeripheral(cpu, timer0);
    attachPeripheral(cpu, timer1);
    attachPeripheral(cpu, timer2);

    cpu.writeData(OCR0A, 3);
    cpu.writeData(TCCR0A, 1 << WGM01);
    cpu.writeData(TCCR0B, 1 << CS00);

    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 3);
    cpu.writeData(TCCR1B, (1 << WGM12) | (1 << CS10));

    cpu.writeData(OCR2A, 3);
    cpu.writeData(TCCR2A, 1 << WGM21);
    cpu.writeData(TCCR2B, 1 << CS20);

    timer0.tick(10);
    timer1.tick(10);
    timer2.tick(10);

    expect(cpu.readData(TCNT0)).toBe(2);
    expect(cpu.readData(TCNT1L)).toBe(2);
    expect(cpu.readData(TCNT2)).toBe(2);
    expect(cpu.readData(TIFR0) & (1 << OCF0A)).toBe(1 << OCF0A);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(1 << OCF1A);
    expect(cpu.readData(TIFR2) & (1 << OCF2A)).toBe(1 << OCF2A);
  });
});
