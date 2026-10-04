import { describe, expect, test } from "bun:test";
import {
  AVR, ADC_VECTOR, SPI_STC_VECTOR, WDT_VECTOR, SMCR, SE,
  TCCR0B, TCNT0, OCR0A, OCR0B, TIFR0, TIMSK0, TOV0, OCF0A, OCF0B,
  TIMER0_OVF_VECTOR, TIMER0_COMPA_VECTOR, TIMER0_COMPB_VECTOR,
  TCCR1B, TCNT1H, TCNT1L, OCR1AL, OCR1BL, TIFR1, TIMSK1, TOV1, OCF1A, OCF1B,
  ICF1, ICES1, TIMER1_OVF_VECTOR, TIMER1_COMPA_VECTOR, TIMER1_COMPB_VECTOR, TIMER1_CAPT_VECTOR,
  TCCR2B, TCNT2, OCR2A, OCR2B, TIFR2, TIMSK2, TOV2, OCF2A, OCF2B,
  TIMER2_OVF_VECTOR, TIMER2_COMPA_VECTOR, TIMER2_COMPB_VECTOR,
} from "../src";

describe("interrupt instruction boundaries", () => {
  for (const timing of ["fast", "cycle-exact"] as const) {
    for (const engine of ["step", "run", "profile"] as const) {
      test(`${engine}/${timing}: SEI and RETI allow the following instruction before dispatch`, () => {
        const avr = AVR({ timing });
        const cpu = avr.cpu;
        cpu.flash.set([0x9478, 0xe401, 0x9503]); // SEI; LDI r16,0x41; INC r16
        cpu.flash[WDT_VECTOR] = 0x9518; // RETI
        const advance = () => {
          if (engine === "step") avr.step();
          else if (engine === "run") avr.runCycles(1);
          else cpu.profileRun(1, () => {});
        };

        cpu.requestInterrupt(WDT_VECTOR);
        advance();
        expect(cpu.pc).toBe(1);
        expect(cpu.cycles).toBe(1);
        advance();
        expect(cpu.data[16]).toBe(0x41);
        expect(cpu.pc).toBe(WDT_VECTOR);
        cpu.requestInterrupt(SPI_STC_VECTOR);
        advance();
        expect(cpu.pc).toBe(2);
        expect(cpu.sreg.I).toBe(true);
        advance();
        expect(cpu.data[16]).toBe(0x42);
        expect(cpu.pc).toBe(SPI_STC_VECTOR);
      });
    }

    test(`${timing}: a pending interrupt still permits SEI; SLEEP to enter sleep`, () => {
      const avr = AVR({ timing });
      avr.cpu.flash.set([0x9478, 0x9588]);
      avr.cpu.writeData(SMCR, 1 << SE);
      let entries = 0;
      avr.cpu.onSleep(() => entries++);
      avr.cpu.requestInterrupt(ADC_VECTOR);
      avr.runCycles(1);
      const restored = AVR().restore(avr.snapshot());
      restored.cpu.onSleep(() => entries++);
      restored.runCycles(1);
      expect(entries).toBe(1);
      expect(restored.cpu.pc).toBe(ADC_VECTOR);
      expect(restored.cpu.isSleeping).toBe(false);
    });
  }

  test("reset discards pending interrupts", () => {
    const avr = AVR();
    avr.cpu.requestInterrupt(ADC_VECTOR);
    avr.reset();
    avr.cpu.sreg.I = true;
    avr.step();
    expect(avr.cpu.pc).toBe(1);
  });
});

type TimerSource = {
  name: string;
  control: number;
  flag: number;
  mask: number;
  bit: number;
  vector: number;
  prepare(avr: ReturnType<typeof AVR>): void;
};

const sources: TimerSource[] = [
  { name: "Timer0 overflow", control: TCCR0B, flag: TIFR0, mask: TIMSK0, bit: TOV0, vector: TIMER0_OVF_VECTOR,
    prepare: (avr) => avr.cpu.writeData(TCNT0, 255) },
  { name: "Timer0 compare A", control: TCCR0B, flag: TIFR0, mask: TIMSK0, bit: OCF0A, vector: TIMER0_COMPA_VECTOR,
    prepare: (avr) => avr.cpu.writeData(OCR0A, 1) },
  { name: "Timer0 compare B", control: TCCR0B, flag: TIFR0, mask: TIMSK0, bit: OCF0B, vector: TIMER0_COMPB_VECTOR,
    prepare: (avr) => avr.cpu.writeData(OCR0B, 1) },
  { name: "Timer1 overflow", control: TCCR1B, flag: TIFR1, mask: TIMSK1, bit: TOV1, vector: TIMER1_OVF_VECTOR,
    prepare: (avr) => { avr.cpu.writeData(TCNT1H, 255); avr.cpu.writeData(TCNT1L, 255); } },
  { name: "Timer1 compare A", control: TCCR1B, flag: TIFR1, mask: TIMSK1, bit: OCF1A, vector: TIMER1_COMPA_VECTOR,
    prepare: (avr) => avr.cpu.writeData(OCR1AL, 1) },
  { name: "Timer1 compare B", control: TCCR1B, flag: TIFR1, mask: TIMSK1, bit: OCF1B, vector: TIMER1_COMPB_VECTOR,
    prepare: (avr) => avr.cpu.writeData(OCR1BL, 1) },
  { name: "Timer1 capture", control: TCCR1B, flag: TIFR1, mask: TIMSK1, bit: ICF1, vector: TIMER1_CAPT_VECTOR,
    prepare: (avr) => { avr.cpu.writeData(TCCR1B, (1 << ICES1) | 1); avr.pin(8).setInput(true); } },
  { name: "Timer2 overflow", control: TCCR2B, flag: TIFR2, mask: TIMSK2, bit: TOV2, vector: TIMER2_OVF_VECTOR,
    prepare: (avr) => avr.cpu.writeData(TCNT2, 255) },
  { name: "Timer2 compare A", control: TCCR2B, flag: TIFR2, mask: TIMSK2, bit: OCF2A, vector: TIMER2_COMPA_VECTOR,
    prepare: (avr) => avr.cpu.writeData(OCR2A, 1) },
  { name: "Timer2 compare B", control: TCCR2B, flag: TIFR2, mask: TIMSK2, bit: OCF2B, vector: TIMER2_COMPB_VECTOR,
    prepare: (avr) => avr.cpu.writeData(OCR2B, 1) },
];

describe("withdrawn timer interrupts", () => {
  for (const source of sources) {
    for (const cleared of ["flag", "mask"] as const) {
      test(`${source.name}: clearing ${cleared} cancels an overflow/compare/capture request`, () => {
        const avr = AVR();
        avr.cpu.writeData(source.mask, 1 << source.bit);
        avr.cpu.writeData(source.control, 1);
        source.prepare(avr);
        avr.runCycles(1);
        avr.cpu.writeData(source.control, 0);
        expect(avr.cpu.readData(source.flag) & (1 << source.bit)).toBe(1 << source.bit);
        expect(avr.snapshot().cpu.pendingInterrupts).toContain(source.vector);

        // Restore into another runtime to exercise reconstructed acknowledgements too.
        const restored = AVR().restore(avr.snapshot());
        restored.cpu.writeData(cleared === "flag" ? source.flag : source.mask,
          cleared === "flag" ? 1 << source.bit : 0);
        const pc = restored.cpu.pc;
        restored.cpu.sreg.I = true;
        restored.step();
        expect(restored.cpu.pc).toBe(pc + 1);
        expect(restored.cpu.sreg.I).toBe(true);
      });
    }
  }
});
