import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import {
  ACIC,
  ACSR,
  AS2,
  ASSR,
  DDRB,
  COM1A0,
  COM1A1,
  CS00,
  CS10,
  CS20,
  FOC1A,
  GTCCR,
  ICES1,
  ICF1,
  ICIE1,
  ICNC1,
  ICR1H,
  ICR1L,
  OCF1A,
  PSRSYNC,
  TCCR0B,
  TCCR1A,
  TCCR1B,
  TCCR1C,
  TCCR2B,
  TCN2UB,
  TCNT0,
  TCNT1L,
  TCNT2,
  TIFR1,
  TIFR2,
  TIMER1_CAPT_VECTOR,
  TIMSK1,
  TOV2,
  TSM,
} from "../src/cpu";

// 16 MHz / 32.768 kHz — CPU cycles per asynchronous timer2 tick. The ratio is
// fractional (488.28125); avrts carries the fraction, so N ticks complete after
// ceil(N * ratio) cycles. TOSC_PERIOD is the rounded one-period busy-flag delay.
const TOSC_RATIO = 16_000_000 / 32768;
const TOSC_PERIOD = Math.round(TOSC_RATIO);
function toscCycles(ticks: number): number {
  return Math.ceil(ticks * TOSC_RATIO);
}

function readIcr1(avr: ReturnType<typeof AVR>): number {
  return avr.cpu.readData(ICR1L) | (avr.cpu.readData(ICR1H) << 8);
}

describe("Phase 5: Timer1 input capture", () => {
  test("selected ICP1 edge latches TCNT1 into ICR1 and sets ICF1", () => {
    const avr = AVR();
    avr.cpu.writeData(TCCR1B, (1 << CS10) | (1 << ICES1)); // clk/1, rising edge
    avr.runCycles(100);

    const before = avr.cpu.readData(TCNT1L);
    void before;
    avr.pin(8).setInput(true); // ICP1 = PB0 rising
    expect((avr.cpu.readData(TIFR1) >> ICF1) & 1).toBe(1);
    expect(readIcr1(avr)).toBe(avr.cpu.readData(TCNT1L) | (avr.cpu.readData(0x85) << 8));
    expect(readIcr1(avr)).toBeGreaterThanOrEqual(99);
  });

  test("the unselected edge does not capture", () => {
    const avr = AVR();
    avr.cpu.writeData(TCCR1B, 1 << CS10); // ICES1=0: falling edge selected
    avr.runCycles(10);
    avr.pin(8).setInput(true); // rising: ignored
    expect((avr.cpu.readData(TIFR1) >> ICF1) & 1).toBe(0);
    avr.pin(8).setInput(false); // falling: captures
    expect((avr.cpu.readData(TIFR1) >> ICF1) & 1).toBe(1);
  });

  test("ICNC1 delays the capture by four system cycles", () => {
    const avr = AVR();
    avr.cpu.writeData(TCCR1B, (1 << CS10) | (1 << ICES1) | (1 << ICNC1));
    avr.runCycles(50);
    const atEdge = readTcnt1(avr);
    avr.pin(8).setInput(true);
    expect((avr.cpu.readData(TIFR1) >> ICF1) & 1).toBe(0); // filtering
    avr.runCycles(4);
    expect((avr.cpu.readData(TIFR1) >> ICF1) & 1).toBe(1);
    expect(readIcr1(avr)).toBe(atEdge + 4);
  });

  test("ICIE1 dispatches TIMER1_CAPT one edge later", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    cpu.flash[0] = 0x9478; // SEI
    cpu.flash[1] = 0xcfff; // RJMP -1
    cpu.flash[TIMER1_CAPT_VECTOR] = 0xcfff; // park inside the ISR
    cpu.writeData(TCCR1B, (1 << CS10) | (1 << ICES1));
    cpu.writeData(TIMSK1, 1 << ICIE1);
    avr.runCycles(10);
    avr.pin(8).setInput(true);
    avr.runCycles(10);
    expect(cpu.pc).toBe(TIMER1_CAPT_VECTOR);
  });

  test("ACIC routes comparator edges into the capture unit with ICR1 latched", () => {
    const avr = AVR();
    avr.cpu.writeData(TCCR1B, (1 << CS10) | (1 << ICES1));
    avr.cpu.writeData(ACSR, 1 << ACIC);
    avr.runCycles(64);
    avr.comparator.setInput("ain1", 1);
    avr.comparator.setInput("ain0", 2); // ACO rises
    expect((avr.cpu.readData(TIFR1) >> ICF1) & 1).toBe(1);
    expect(readIcr1(avr)).toBeGreaterThanOrEqual(63);
  });
});

function readTcnt1(avr: ReturnType<typeof AVR>): number {
  return avr.cpu.readData(TCNT1L) | (avr.cpu.readData(0x85) << 8);
}

describe("Phase 5: TCCR1C forced output compare", () => {
  test("FOC1A drives OC1A per COM bits without setting OCF1A", () => {
    const avr = AVR();
    // Non-PWM (WGM=0), COM1A=3 (set OC1A on compare match), clock stopped.
    avr.cpu.writeData(DDRB, 1 << 1); // OC1A/PB1 as output (pinMode(9, OUTPUT))
    avr.cpu.writeData(TCCR1A, (1 << COM1A1) | (1 << COM1A0));
    expect(avr.pin(9).read()).toBe(false);

    avr.cpu.writeData(TCCR1C, 1 << FOC1A);
    expect(avr.pin(9).read()).toBe(true);
    expect((avr.cpu.readData(TIFR1) >> OCF1A) & 1).toBe(0);
    expect(avr.cpu.readData(TCCR1C)).toBe(0); // strobes read as zero
  });
});

describe("Phase 5: GTCCR prescaler control", () => {
  test("TSM+PSRSYNC freezes timer0/timer1 until TSM is cleared", () => {
    const avr = AVR();
    avr.cpu.writeData(TCCR0B, 1 << CS00);
    avr.cpu.writeData(TCCR1B, 1 << CS10);
    avr.cpu.writeData(GTCCR, (1 << TSM) | (1 << PSRSYNC));

    avr.runCycles(100);
    expect(avr.cpu.readData(TCNT0)).toBe(0);
    expect(readTcnt1(avr)).toBe(0);
    expect(avr.cpu.readData(GTCCR)).toBe((1 << TSM) | (1 << PSRSYNC));

    avr.cpu.writeData(GTCCR, 0);
    avr.runCycles(50);
    expect(avr.cpu.readData(TCNT0)).toBe(50);
    expect(readTcnt1(avr)).toBe(50);
  });

  test("PSRSYNC without TSM strobes once and reads back zero", () => {
    const avr = AVR();
    avr.cpu.writeData(TCCR0B, 1 << CS00);
    avr.cpu.writeData(GTCCR, 1 << PSRSYNC);
    expect(avr.cpu.readData(GTCCR)).toBe(0);
    avr.runCycles(25);
    expect(avr.cpu.readData(TCNT0)).toBe(25); // still counting
  });
});

describe("Phase 5: Timer2 asynchronous mode", () => {
  test("AS2 clocks TCNT2 at the 32.768 kHz TOSC ratio", () => {
    const avr = AVR();
    avr.cpu.writeData(ASSR, 1 << AS2);
    avr.cpu.writeData(TCCR2B, 1 << CS20); // TOSC/1
    avr.runCycles(toscCycles(10));
    expect(avr.cpu.readData(TCNT2)).toBe(10);
  });

  test("TOV2 sets after 256 asynchronous ticks", () => {
    const avr = AVR();
    avr.cpu.flash[0] = 0xcfff; // rjmp -1: the run is longer than empty flash
    avr.cpu.writeData(ASSR, 1 << AS2);
    avr.cpu.writeData(TCCR2B, 1 << CS20);
    avr.runCycles(toscCycles(256));
    expect((avr.cpu.readData(TIFR2) >> TOV2) & 1).toBe(1);
  });

  test("async register writes set the ASSR busy flag for one TOSC period", () => {
    const avr = AVR();
    avr.cpu.writeData(ASSR, 1 << AS2);
    avr.cpu.writeData(TCNT2, 42);
    expect((avr.cpu.readData(ASSR) >> TCN2UB) & 1).toBe(1);
    avr.runCycles(TOSC_PERIOD - 1);
    expect((avr.cpu.readData(ASSR) >> TCN2UB) & 1).toBe(1);
    avr.runCycles(1);
    expect((avr.cpu.readData(ASSR) >> TCN2UB) & 1).toBe(0);
    expect(avr.cpu.readData(TCNT2)).toBe(42);
  });

  test("synchronous mode never sets busy flags", () => {
    const avr = AVR();
    avr.cpu.writeData(TCNT2, 7);
    expect(avr.cpu.readData(ASSR) & 0x1f).toBe(0);
  });

  test("snapshot/restore keeps the async rate and pending busy flag", () => {
    const avr = AVR();
    avr.cpu.writeData(ASSR, 1 << AS2);
    avr.cpu.writeData(TCCR2B, 1 << CS20);
    avr.runCycles(toscCycles(3));
    avr.cpu.writeData(TCNT2, 100); // resets the prescaler remainder to 0.

    const snap = avr.snapshot();
    const restored = AVR();
    restored.restore(snap);

    expect((restored.cpu.readData(ASSR) >> TCN2UB) & 1).toBe(1);
    restored.runCycles(TOSC_PERIOD); // one period clears the busy flag.
    expect((restored.cpu.readData(ASSR) >> TCN2UB) & 1).toBe(0);
    restored.runCycles(toscCycles(6) - TOSC_PERIOD);
    // Six TOSC periods elapsed since TCNT2 was written to 100.
    expect(restored.cpu.readData(TCNT2)).toBe(106);
  });
});
