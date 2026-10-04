import { describe, expect, test } from "bun:test";
import {
  AVR,
  COM1A1,
  COM1B1,
  COM2A1,
  COM2B1,
  CPU,
  CS10,
  CS20,
  Decoder,
  FLASH_WORDS,
  OCR1AH,
  OCR1AL,
  OCR1BL,
  OCR2A,
  OCR2B,
  TCCR1A,
  TCCR1B,
  TCCR2A,
  TCCR2B,
  TCNT1H,
  TCNT1L,
  TCNT2,
  TIFR1,
  TIFR2,
  TIMER1_OVF_VECTOR,
  TIMSK1,
  TOIE1,
  WGM10,
  WGM20,
} from "../src";
import { attachPeripheral, Timer1, Timer2 } from "../src/peripherals";

function makeCpu(): CPU {
  const cpu = new CPU(new Uint16Array(FLASH_WORDS));
  cpu.setExecutor(new Decoder());
  return cpu;
}

describe("Timer1 PWM (pins 9, 10)", () => {
  test("analogWrite on pin 9 (OC1A) reports phase-correct PWM duty", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    // The Arduino core path: 8-bit phase-correct PWM, non-inverting OC1A.
    cpu.writeData(TCCR1A, (1 << WGM10) | (1 << COM1A1));
    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 64); // analogWrite(9, 64)

    const sig = avr.pwm(9).read();
    expect(sig.enabled).toBe(true);
    expect(sig.channel).toBe("A");
    expect(sig.mode).toBe("phase-correct-pwm");
    expect(sig.inverted).toBe(false);
    expect(sig.value).toBe(64);
    expect(sig.duty).toBeCloseTo(64 / 255);
  });

  test("pin 10 (OC1B) emits a PWM change when OCR1B is written", () => {
    const avr = AVR();
    const seen: number[] = [];
    avr.pwm(10).onChange((signal) => seen.push(signal.duty));

    avr.cpu.writeData(TCCR1A, (1 << WGM10) | (1 << COM1B1));
    avr.cpu.writeData(OCR1BL, 200); // analogWrite(10, 200)

    expect(seen.at(-1)).toBeCloseTo(200 / 255);
  });
});

describe("Timer2 PWM (pins 11, 3)", () => {
  test("analogWrite on pin 11 (OC2A) and pin 3 (OC2B) report duty", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    cpu.writeData(TCCR2A, (1 << WGM20) | (1 << COM2A1) | (1 << COM2B1));
    cpu.writeData(OCR2A, 51); // analogWrite(11, 51)
    cpu.writeData(OCR2B, 128); // analogWrite(3, 128)

    expect(avr.pwm(11).read().channel).toBe("A");
    expect(avr.pwm(11).read().duty).toBeCloseTo(51 / 255);
    expect(avr.pwm(3).read().channel).toBe("B");
    expect(avr.pwm(3).read().duty).toBeCloseTo(128 / 255);
  });
});

describe("Timer1 counting + overflow", () => {
  test("counts as a 16-bit timer and sets TOV1 on overflow", () => {
    const cpu = makeCpu();
    const timer1 = new Timer1(cpu);
    attachPeripheral(cpu, timer1);

    cpu.writeData(TCCR1B, 1 << CS10); // prescaler /1
    cpu.writeData(TCNT1H, 0xff);
    cpu.writeData(TCNT1L, 0xfe);

    timer1.tick(1); // -> 0xffff
    expect(cpu.readData(TCNT1H)).toBe(0xff);
    expect(cpu.readData(TCNT1L)).toBe(0xff);
    expect(cpu.readData(TIFR1) & 1).toBe(0);

    timer1.tick(1); // 0xffff -> 0x0000, overflow
    expect(cpu.readData(TCNT1L)).toBe(0x00);
    expect(cpu.readData(TIFR1) & 1).toBe(1);

    cpu.writeData(TIFR1, 1); // write-1-to-clear
    expect(cpu.readData(TIFR1) & 1).toBe(0);
  });

  test("enabled overflow interrupt jumps to the TIMER1_OVF vector", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    cpu.flash[0] = 0x9478; // sei
    cpu.flash[1] = 0xcfff; // rjmp -1
    cpu.flash[TIMER1_OVF_VECTOR] = 0x9518; // reti

    cpu.writeData(TCNT1H, 0xff);
    cpu.writeData(TCNT1L, 0xff);
    cpu.writeData(TCCR1B, 1 << CS10); // prescaler /1
    cpu.writeData(TIMSK1, 1 << TOIE1);

    avr.step(); // SEI queues the overflow but permits the following instruction.
    expect(cpu.pc).toBe(1);
    avr.step();
    expect(cpu.pc).toBe(TIMER1_OVF_VECTOR);
  });
});

describe("Timer2 counting + overflow", () => {
  test("counts as an 8-bit timer and sets TOV2 on overflow", () => {
    const cpu = makeCpu();
    const timer2 = new Timer2(cpu);
    attachPeripheral(cpu, timer2);

    cpu.writeData(TCCR2B, 1 << CS20); // prescaler /1
    cpu.writeData(TCNT2, 0xff);
    timer2.tick(1);

    expect(cpu.readData(TCNT2)).toBe(0x00);
    expect(cpu.readData(TIFR2) & 1).toBe(1);

    cpu.writeData(TIFR2, 1); // write-1-to-clear
    expect(cpu.readData(TIFR2) & 1).toBe(0);
  });
});
