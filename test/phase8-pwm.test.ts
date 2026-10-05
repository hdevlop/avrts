import { describe, expect, test } from "bun:test";
import {
  AVR,
  COM0A0,
  COM0A1,
  COM0B0,
  COM0B1,
  COM1A0,
  COM1A1,
  COM1B0,
  COM1B1,
  COM2A0,
  COM2A1,
  COM2B0,
  COM2B1,
  CPU,
  CS00,
  CS10,
  CS20,
  DDRB,
  DDRD,
  Decoder,
  FLASH_WORDS,
  OCR0A,
  OCR0B,
  OCR1AH,
  OCR1AL,
  OCR1BH,
  OCR1BL,
  OCR2A,
  OCR2B,
  PORTD,
  TCCR0A,
  TCCR0B,
  TCCR1A,
  TCCR1B,
  TCCR2A,
  TCCR2B,
  TCNT0,
  TCNT1L,
  TCNT2,
  WGM00,
  WGM01,
  WGM12,
  WGM21,
} from "../src";
import { attachPeripheral, Timer0 } from "../src/peripherals";

function makeCpu(): CPU {
  const cpu = new CPU(new Uint16Array(FLASH_WORDS));
  cpu.setExecutor(new Decoder());
  return cpu;
}

describe("Timer0 PWM", () => {
  test("reports non-inverting Fast PWM duty for OC0B", () => {
    const cpu = makeCpu();
    const timer0 = new Timer0(cpu);
    attachPeripheral(cpu, timer0);

    cpu.writeData(TCCR0A, (1 << WGM01) | (1 << WGM00) | (1 << COM0B1));
    cpu.writeData(OCR0B, 128);
    cpu.writeData(TCCR0B, 1 << CS00);
    timer0.tick(256); // CPU write queues the fast-PWM buffer until BOTTOM.

    const signal = timer0.readPwm("B");
    expect(signal.enabled).toBe(true);
    expect(signal.mode).toBe("fast-pwm");
    expect(signal.inverted).toBe(false);
    expect(signal.value).toBe(128);
    expect(signal.duty).toBeCloseTo(128 / 255);
  });

  test("reports inverted PWM duty for OC0A", () => {
    const cpu = makeCpu();
    const timer0 = new Timer0(cpu);
    attachPeripheral(cpu, timer0);

    cpu.writeData(TCCR0A, (1 << WGM01) | (1 << WGM00) | (1 << COM0A1) | (1 << COM0A0));
    cpu.writeData(OCR0A, 64);
    cpu.writeData(TCCR0B, 1 << CS00);
    timer0.tick(256);

    const signal = timer0.readPwm("A");
    expect(signal.enabled).toBe(true);
    expect(signal.inverted).toBe(true);
    expect(signal.duty).toBeCloseTo(1 - 64 / 255);
  });

  test("facade exposes PWM handles for Timer0 pins", () => {
    const avr = AVR();
    const seen: number[] = [];

    avr.pwm(5).onChange((signal) => {
      seen.push(signal.duty);
    });

    avr.cpu.writeData(TCCR0A, (1 << WGM01) | (1 << WGM00) | (1 << COM0B1));
    avr.cpu.writeData(OCR0B, 191);
    expect(avr.pwm(5).read().value).toBe(0);
    avr.cpu.writeData(TCCR0B, 1 << CS00);
    avr.runCycles(256);

    const signal = avr.pwm(5).read();
    expect(signal.enabled).toBe(true);
    expect(signal.channel).toBe("B");
    expect(signal.duty).toBeCloseTo(191 / 255);
    expect(seen.at(-1)).toBeCloseTo(191 / 255);
  });

  test("PWM compare output drives the virtual output pin", () => {
    const avr = AVR();
    const seen: boolean[] = [];

    avr.pin(5).onChange((high) => seen.push(high));
    avr.cpu.writeData(DDRD, 1 << 5); // D5 / OC0B output
    avr.cpu.writeData(OCR0B, 2);
    avr.cpu.writeData(TCCR0A, (1 << WGM01) | (1 << WGM00) | (1 << COM0B1));
    avr.cpu.writeData(TCCR0B, 1); // no prescale

    expect(avr.pin(5).read()).toBe(true); // PWM bottom state

    avr.runCycles(2); // compare match at OCR0B
    expect(avr.cpu.readData(TCNT0)).toBe(2);
    expect(avr.pin(5).read()).toBe(false);

    avr.runCycles(254); // wrap to BOTTOM
    expect(avr.cpu.readData(TCNT0)).toBe(0);
    expect(avr.pin(5).read()).toBe(true);
    expect(seen).toEqual([true, false, true]);
  });

  test("normal/CTC compare toggle drives the virtual output pin", () => {
    const avr = AVR();
    const seen: boolean[] = [];

    avr.pin(11).onChange((high) => seen.push(high));
    avr.cpu.writeData(DDRB, 1 << 3); // D11 / OC2A output
    avr.cpu.writeData(OCR2A, 2);
    avr.cpu.writeData(TCCR2A, (1 << WGM21) | (1 << COM2A0));
    avr.cpu.writeData(TCCR2B, 1); // no prescale

    expect(avr.pin(11).read()).toBe(false);

    avr.runCycles(2);
    expect(avr.cpu.readData(TCNT2)).toBe(2);
    expect(avr.pin(11).read()).toBe(true);

    avr.runCycles(3); // TOP+1 CTC period.
    expect(avr.pin(11).read()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  test("CTC toggle output drives every OC pin", () => {
    const avr = AVR();

    // Timer0: OC0A = D6, OC0B = D5.
    avr.cpu.writeData(DDRD, (1 << 6) | (1 << 5));
    avr.cpu.writeData(OCR0A, 2);
    avr.cpu.writeData(OCR0B, 2);
    avr.cpu.writeData(TCCR0A, (1 << WGM01) | (1 << COM0A0) | (1 << COM0B0));
    avr.cpu.writeData(TCCR0B, 1 << CS00);

    // Timer1: OC1A = D9, OC1B = D10.
    avr.cpu.writeData(DDRB, (1 << 1) | (1 << 2) | (1 << 3)); // D11 is Timer2 OC2A.
    avr.cpu.writeData(OCR1AH, 0);
    avr.cpu.writeData(OCR1AL, 2);
    avr.cpu.writeData(OCR1BH, 0);
    avr.cpu.writeData(OCR1BL, 2);
    avr.cpu.writeData(TCCR1A, (1 << COM1A0) | (1 << COM1B0));
    avr.cpu.writeData(TCCR1B, (1 << WGM12) | (1 << CS10));

    // Timer2: OC2A = D11, OC2B = D3.
    avr.cpu.writeData(DDRD, avr.cpu.readData(DDRD) | (1 << 3));
    avr.cpu.writeData(OCR2A, 2);
    avr.cpu.writeData(OCR2B, 2);
    avr.cpu.writeData(TCCR2A, (1 << WGM21) | (1 << COM2A0) | (1 << COM2B0));
    avr.cpu.writeData(TCCR2B, 1 << CS20);

    const pins = [3, 5, 6, 9, 10, 11];
    for (const pin of pins) expect(avr.pin(pin).read()).toBe(false);

    avr.runCycles(2);
    expect(avr.cpu.readData(TCNT0)).toBe(2);
    expect(avr.cpu.readData(TCNT1L)).toBe(2);
    expect(avr.cpu.readData(TCNT2)).toBe(2);
    for (const pin of pins) expect(avr.pin(pin).read()).toBe(true);

    avr.runCycles(3);
    for (const pin of pins) expect(avr.pin(pin).read()).toBe(false);
  });

  test("normal compare clear and set modes drive virtual pins", () => {
    const clear = AVR();
    clear.cpu.writeData(DDRD, 1 << 5); // D5 / OC0B output
    clear.cpu.writeData(PORTD, 1 << 5); // start high from the firmware PORT latch
    clear.cpu.writeData(OCR0B, 2);
    clear.cpu.writeData(TCCR0A, 1 << COM0B1); // clear on compare
    clear.cpu.writeData(TCCR0B, 1 << CS00);

    expect(clear.pin(5).read()).toBe(true);
    clear.runCycles(2);
    expect(clear.pin(5).read()).toBe(false);

    const set = AVR();
    set.cpu.writeData(DDRD, 1 << 5);
    set.cpu.writeData(OCR0B, 2);
    set.cpu.writeData(TCCR0A, (1 << COM0B1) | (1 << COM0B0)); // set on compare
    set.cpu.writeData(TCCR0B, 1 << CS00);

    expect(set.pin(5).read()).toBe(false);
    set.runCycles(2);
    expect(set.pin(5).read()).toBe(true);
  });

  test("real Timer2 CTC tone-style firmware emits pin 11 edges", async () => {
    const hex = await Bun.file(
      new URL("../examples/timer2-ctc-tone/timer2-ctc-tone.hex", import.meta.url),
    ).text();
    const avr = AVR({ hex, timing: "cycle-exact" });
    const edges: Array<{ high: boolean; cycles: number }> = [];

    avr.runCycles(80); // let firmware configure Timer2 and OC2A.
    avr.pin(11).onChange((high, event) => edges.push({ high, cycles: event.cycles }));
    avr.runCycles(40);

    expect(edges.length).toBeGreaterThanOrEqual(8);
    expect(edges.slice(1).every((edge, index) => edge.high !== edges[index]!.high)).toBe(true);
    const gaps = edges.slice(1).map((edge, index) => edge.cycles - edges[index]!.cycles);
    expect(gaps.every((gap) => gap === 5)).toBe(true); // OCR2A = 4 gives TOP+1.
  });

  test("facade rejects pins that have no PWM output", () => {
    const avr = AVR();
    expect(() => avr.pwm(7)).toThrow("PWM is not available on pin 7");
  });
});
