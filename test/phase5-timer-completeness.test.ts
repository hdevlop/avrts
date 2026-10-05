import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import {
  AS2,
  ASSR,
  COM1A0,
  COM1A1,
  COM1B1,
  CS10,
  CS20,
  DDRB,
  FOC1A,
  ICES1,
  ICF1,
  ICIE1,
  ICNC1,
  ICR1H,
  ICR1L,
  OCF1A,
  OCF1B,
  OCR1AH,
  OCR1AL,
  OCR1BH,
  OCR1BL,
  OCR2A,
  OCR2AUB,
  OCR2B,
  OCR2BUB,
  TCNT2,
  TCNT1H,
  TCNT1L,
  TCN2UB,
  TCCR1A,
  TCCR1B,
  TCCR1C,
  TCCR2A,
  TCCR2B,
  TCR2AUB,
  TCR2BUB,
  TIFR1,
  TIMER1_CAPT_VECTOR,
  TIMSK1,
  TOV1,
  WGM10,
  WGM11,
  WGM12,
  WGM13,
} from "../src/cpu";

function readTcnt1(avr: ReturnType<typeof AVR>): number {
  return avr.cpu.readData(TCNT1L) | (avr.cpu.readData(TCNT1H) << 8);
}

describe("Phase 5 timer completeness", () => {
  test("Timer1 FOC1A strobe drives compare output in non-PWM mode", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(DDRB, 1 << 1); // PB1 / OC1A / Arduino D9.
    cpu.writeData(TCCR1A, (1 << COM1A1) | (1 << COM1A0)); // set OC1A on compare.

    expect(avr.pin(9).read()).toBe(false);
    cpu.writeData(TCCR1C, 1 << FOC1A);
    expect(avr.pin(9).read()).toBe(true);
    expect(cpu.readData(TCCR1C)).toBe(0);
  });

  test("Timer1 input capture latches ICP1 edges and requests TIMER1_CAPT", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.flash[0] = 0x0000; // NOP, so interrupt dispatch has a safe instruction.
    avr.pin(8).setInput(false); // PB0 / ICP1 starts low.
    cpu.writeData(TCCR1B, (1 << CS10) | (1 << ICES1));
    cpu.writeData(TIMSK1, 1 << ICIE1);
    cpu.sreg.I = true;
    avr.runCycles(7);

    avr.pin(8).setInput(true);
    expect((cpu.readData(TIFR1) >> ICF1) & 1).toBe(1);
    expect(cpu.readData(ICR1L) | (cpu.readData(ICR1H) << 8)).toBe(7);

    avr.step();
    expect(cpu.pc).toBe(TIMER1_CAPT_VECTOR);
    expect((cpu.readData(TIFR1) >> ICF1) & 1).toBe(0);
  });

  test("Timer1 input-capture noise canceler delays capture by four cycles", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    avr.pin(8).setInput(false);
    cpu.writeData(TCCR1B, (1 << CS10) | (1 << ICES1) | (1 << ICNC1));
    avr.runCycles(5);
    avr.pin(8).setInput(true);

    avr.runCycles(3);
    expect((cpu.readData(TIFR1) >> ICF1) & 1).toBe(0);
    avr.runCycles(1);
    expect((cpu.readData(TIFR1) >> ICF1) & 1).toBe(1);
    expect(cpu.readData(ICR1L) | (cpu.readData(ICR1H) << 8)).toBe(9);
  });

  test("Timer1 CTC mode 12 clears at ICR1 TOP while OCR1A/OCR1B still compare", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(TCCR1B, (1 << WGM13) | (1 << WGM12)); // ICR1 is writable as TOP.
    cpu.writeData(ICR1H, 0);
    cpu.writeData(ICR1L, 4);
    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 2);
    cpu.writeData(OCR1BH, 0);
    cpu.writeData(OCR1BL, 3);
    cpu.writeData(TCCR1B, (1 << WGM13) | (1 << WGM12) | (1 << CS10));

    avr.runCycles(4);

    expect(readTcnt1(avr)).toBe(4);
    avr.runCycles(1); // CTC holds TOP for one timer clock.
    expect(readTcnt1(avr)).toBe(0);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(1 << OCF1A);
    expect(cpu.readData(TIFR1) & (1 << OCF1B)).toBe(1 << OCF1B);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(0);
  });

  test("Timer1 fast PWM mode 14 uses ICR1 TOP for wrap, overflow, pins, and duty", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(DDRB, (1 << 1) | (1 << 2)); // PB1/PB2 = OC1A/OC1B.
    cpu.writeData(TCCR1B, (1 << WGM13) | (1 << WGM12)); // stopped CTC for initialization.
    cpu.writeData(ICR1H, 0);
    cpu.writeData(ICR1L, 5);
    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 2);
    cpu.writeData(OCR1BH, 0);
    cpu.writeData(OCR1BL, 4);
    cpu.writeData(TCCR1A, (1 << COM1A1) | (1 << COM1B1) | (1 << WGM11));
    cpu.writeData(TCCR1B, (1 << WGM13) | (1 << WGM12) | (1 << CS10));

    expect(avr.pin(9).read()).toBe(true);
    expect(avr.pwm(9).read()).toMatchObject({
      enabled: true,
      mode: "fast-pwm",
      duty: 2 / 5,
    });

    avr.runCycles(2);
    expect(readTcnt1(avr)).toBe(2);
    expect(avr.pin(9).read()).toBe(false);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(0);
    avr.runCycles(1);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(1 << OCF1A);

    avr.runCycles(2);
    expect(readTcnt1(avr)).toBe(5); // TOP is held for a timer clock.
    expect(avr.pin(9).read()).toBe(false);
    avr.runCycles(1);
    expect(readTcnt1(avr)).toBe(0);
    expect(avr.pin(9).read()).toBe(true);
    expect(cpu.readData(TIFR1) & (1 << OCF1B)).toBe(1 << OCF1B);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(1 << TOV1);
  });

  test.each([
    ["phase and frequency correct", 1 << WGM13],
    ["phase correct", (1 << WGM13) | (1 << WGM11)],
  ])("Timer1 %s PWM uses ICR1 TOP on both slopes", (_name, wgmBits) => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(DDRB, 1 << 1); // PB1 / OC1A / Arduino D9.
    cpu.writeData(TCCR1B, (1 << WGM13) | (1 << WGM12));
    cpu.writeData(ICR1H, 0);
    cpu.writeData(ICR1L, 4);
    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 2);
    cpu.writeData(TCCR1A, (1 << COM1A1) | (wgmBits & ((1 << WGM11) | 1)));
    cpu.writeData(TCCR1B, (wgmBits & (1 << WGM13)) | (1 << CS10));

    expect(avr.pin(9).read()).toBe(true);
    expect(avr.pwm(9).read()).toMatchObject({
      enabled: true,
      mode: "phase-correct-pwm",
      duty: 2 / 4,
    });

    avr.runCycles(2);
    expect(readTcnt1(avr)).toBe(2);
    expect(avr.pin(9).read()).toBe(false);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(0);
    avr.runCycles(1);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(1 << OCF1A);

    cpu.writeData(TIFR1, (1 << OCF1A) | (1 << TOV1));
    avr.runCycles(1);
    expect(readTcnt1(avr)).toBe(4);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(0);

    avr.runCycles(2);
    expect(readTcnt1(avr)).toBe(2);
    expect(avr.pin(9).read()).toBe(true);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(0);
    avr.runCycles(1);
    expect(cpu.readData(TIFR1) & (1 << OCF1A)).toBe(1 << OCF1A);

    avr.runCycles(1);
    expect(readTcnt1(avr)).toBe(0);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(1 << TOV1);
  });

  test("Timer1 fast PWM mode 5 wraps at the fixed 8-bit TOP and sets TOV1 at TOP", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(TCCR1A, 1 << WGM10);
    cpu.writeData(TCCR1B, (1 << WGM12) | (1 << CS10)); // mode 5: fast PWM, TOP=0x00FF.

    avr.runCycles(254);
    expect(readTcnt1(avr)).toBe(254);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(0);

    avr.runCycles(1); // reaches TOP (255).
    expect(readTcnt1(avr)).toBe(255);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(1 << TOV1);
    avr.runCycles(1);
    expect(readTcnt1(avr)).toBe(0);
  });

  test("Timer1 phase-correct mode 1 dual-slopes at the fixed 8-bit TOP with TOV1 at BOTTOM", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(TCCR1A, 1 << WGM10);
    cpu.writeData(TCCR1B, 1 << CS10); // mode 1: phase-correct PWM, TOP=0x00FF.

    avr.runCycles(255);
    expect(readTcnt1(avr)).toBe(255);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(0);

    avr.runCycles(1);
    expect(readTcnt1(avr)).toBe(254); // counting down after TOP.

    avr.runCycles(254);
    expect(readTcnt1(avr)).toBe(0);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(1 << TOV1);
  });

  test("Timer1 fast PWM mode 15 uses OCR1A as TOP", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 3);
    cpu.writeData(TCCR1A, (1 << WGM11) | (1 << WGM10));
    cpu.writeData(TCCR1B, (1 << WGM13) | (1 << WGM12) | (1 << CS10)); // mode 15.

    avr.runCycles(2);
    expect(readTcnt1(avr)).toBe(2);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(0);

    avr.runCycles(1); // reaches OCR1A TOP (3).
    expect(readTcnt1(avr)).toBe(3);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(1 << TOV1);
    avr.runCycles(1);
    expect(readTcnt1(avr)).toBe(0);
  });

  test("Timer1 phase/frequency-correct mode 9 dual-slopes at OCR1A", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(OCR1AH, 0);
    cpu.writeData(OCR1AL, 4);
    cpu.writeData(TCCR1A, 1 << WGM10);
    cpu.writeData(TCCR1B, (1 << WGM13) | (1 << CS10)); // mode 9.

    avr.runCycles(4);
    expect(readTcnt1(avr)).toBe(4);

    avr.runCycles(1);
    expect(readTcnt1(avr)).toBe(3); // counting down at OCR1A TOP.

    avr.runCycles(3);
    expect(readTcnt1(avr)).toBe(0);
    expect(cpu.readData(TIFR1) & (1 << TOV1)).toBe(1 << TOV1);
  });

  test("Timer1 fast PWM mode 7 reports the 10-bit TOP for duty", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(DDRB, 1 << 1); // PB1 / OC1A.
    cpu.writeData(OCR1AH, 0x01);
    cpu.writeData(OCR1AL, 0xff); // 511.
    cpu.writeData(TCCR1A, (1 << COM1A1) | (1 << WGM11) | (1 << WGM10));
    cpu.writeData(TCCR1B, (1 << WGM12) | (1 << CS10)); // mode 7: fast PWM, TOP=0x03FF.

    expect(avr.pwm(9).read()).toMatchObject({
      enabled: true,
      mode: "fast-pwm",
      duty: 511 / 1023,
    });
  });

  test("Timer1 reserved mode 13 free-runs to the 16-bit MAX (documented approximation)", () => {
    const avr = AVR();
    const cpu = avr.cpu;

    cpu.writeData(TCCR1A, 1 << WGM10);
    cpu.writeData(TCCR1B, (1 << WGM13) | (1 << WGM12) | (1 << CS10)); // mode 13 (reserved).

    avr.runCycles(300); // past every fixed 8/9/10-bit TOP without wrapping.
    expect(readTcnt1(avr)).toBe(300);
    expect(avr.pwm(9).read().enabled).toBe(false);
  });

  test("Timer2 async mode uses the TOSC cycle ratio and ASSR busy flags", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    const busyMask =
      (1 << TCN2UB) | (1 << OCR2AUB) | (1 << OCR2BUB) | (1 << TCR2AUB) | (1 << TCR2BUB);

    cpu.writeData(ASSR, 1 << AS2);
    cpu.writeData(TCNT2, 0x12);
    cpu.writeData(OCR2A, 0x34);
    cpu.writeData(OCR2B, 0x56);
    cpu.writeData(TCCR2A, 0);
    cpu.writeData(TCCR2B, 1 << CS20);

    expect(cpu.readData(ASSR) & busyMask).toBe(busyMask);
    expect(cpu.readData(TCNT2)).toBe(0x12);

    avr.runCycles(487);
    expect(cpu.readData(TCNT2)).toBe(0x12);
    expect(cpu.readData(ASSR) & busyMask).toBe(busyMask);

    avr.runCycles(1); // cycle 488: the ~TOSC-period busy clear fires here.
    expect(cpu.readData(ASSR) & busyMask).toBe(0);
    expect(cpu.readData(TCNT2)).toBe(0x12); // counter not ticked yet (ratio 488.28).

    avr.runCycles(1); // cycle 489: first tick at the exact 488.28125-cycle TOSC ratio.
    expect(cpu.readData(TCNT2)).toBe(0x13);
  });
});
