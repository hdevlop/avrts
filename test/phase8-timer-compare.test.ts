import { describe, expect, test } from "bun:test";
import {
  AVR,
  CS00,
  CS10,
  CS20,
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

    expect(cpu.readData(TCNT0)).toBe(0);
    expect(cpu.readData(TCNT1L)).toBe(0);
    expect(cpu.readData(TCNT2)).toBe(0);
    expect(cpu.readData(TIFR0) & (1 << OCF0A)).toBe(1 << OCF0A);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(1 << OCF1A);
    expect(cpu.readData(TIFR2) & (1 << OCF2A)).toBe(1 << OCF2A);
  });
});
