import { describe, expect, test } from "bun:test";
import * as A from "../src";

const bit = (n: number) => 1 << n;

function chip() {
  const avr = A.AVR();
  avr.cpu.flash.fill(0); // NOPs: every instruction takes one cycle.
  return avr;
}

/** Timer0 fast PWM on OC0A (Arduino D6) with OCR0A = 64, no prescaler. */
function fastPwm(avr: ReturnType<typeof chip>) {
  avr.cpu.writeData(A.DDRD, bit(6));
  avr.cpu.writeData(A.OCR0A, 64);
  avr.cpu.writeData(A.TCCR0A, bit(A.COM0A1) | bit(A.WGM01) | bit(A.WGM00));
  avr.cpu.writeData(A.TCCR0B, bit(A.CS00));
}

describe("output-compare pins show the OCnx latch", () => {
  test("enabling fast PWM at TCNT0 = 0 keeps OC0A low until the first BOTTOM", () => {
    const avr = chip();
    const edges: [boolean, number][] = [];
    avr.pin(6).onChange((high, event) => edges.push([high, event.cycles]));
    fastPwm(avr);
    const started = avr.cpu.cycles;
    expect(avr.pin(6).read()).toBe(false);
    avr.runCycles(3 * 256);
    // First rise is the TOP -> BOTTOM clock, then 65 clocks high every 256.
    expect(edges[0]).toEqual([true, started + 256]);
    expect(edges[1]).toEqual([false, started + 256 + 65]);
    expect(edges[2]).toEqual([true, started + 512]);
  });

  test("reconnecting COM mid-pulse restores the latched level, not a new BOTTOM", () => {
    const avr = chip();
    fastPwm(avr);
    avr.runCycles(256 + 10); // high part of the second period
    expect(avr.pin(6).read()).toBe(true);
    avr.cpu.writeData(A.TCCR0A, bit(A.WGM01) | bit(A.WGM00)); // disconnect: PORTD6 = 0
    expect(avr.pin(6).read()).toBe(false);
    // A compare match passes while COM = 0; the waveform generator leaves the latch alone.
    avr.runCycles(100);
    avr.cpu.writeData(A.TCCR0A, bit(A.COM0A1) | bit(A.WGM01) | bit(A.WGM00));
    expect(avr.pin(6).read()).toBe(true);
  });

  test("Arduino-style analogWrite on a running timer starts from the latch", () => {
    const avr = chip();
    avr.cpu.writeData(A.DDRD, bit(6));
    avr.cpu.writeData(A.TCCR0A, bit(A.WGM01) | bit(A.WGM00)); // init(): fast PWM, COM = 0
    avr.cpu.writeData(A.TCCR0B, bit(A.CS00));
    avr.runCycles(1000);
    avr.cpu.writeData(A.OCR0A, 191);
    avr.cpu.writeData(A.TCCR0A, bit(A.COM0A1) | bit(A.WGM01) | bit(A.WGM00));
    expect(avr.pin(6).read()).toBe(false);
    const toBottom = 256 - avr.cpu.readData(A.TCNT0);
    avr.runCycles(toBottom - 1);
    expect(avr.pin(6).read()).toBe(false);
    avr.runCycles(1);
    expect(avr.pin(6).read()).toBe(true);
  });

  test("snapshots carry the latch and reset clears it", () => {
    const avr = chip();
    fastPwm(avr);
    avr.runCycles(256 + 10);
    avr.cpu.writeData(A.TCCR0A, bit(A.WGM01) | bit(A.WGM00));
    const snapshot = avr.snapshot();
    expect(snapshot.timer0.outputLatches).toEqual({ A: true, B: false });
    const restored = A.AVR().restore(snapshot);
    restored.cpu.writeData(A.TCCR0A, bit(A.COM0A1) | bit(A.WGM01) | bit(A.WGM00));
    expect(restored.pin(6).read()).toBe(true);

    avr.reset();
    expect(avr.snapshot().timer0.outputLatches).toEqual({ A: false, B: false });
  });

  test("Timer1 and Timer2 follow the same first period", () => {
    const one = chip();
    one.cpu.writeData(A.DDRB, bit(1));
    one.cpu.writeData(A.OCR1AL, 64);
    one.cpu.writeData(A.TCCR1A, bit(A.COM1A1) | bit(A.WGM10)); // fast PWM 8-bit (WGM 5)
    one.cpu.writeData(A.TCCR1B, bit(A.WGM12) | bit(A.CS10));
    expect(one.pin(9).read()).toBe(false);
    one.runCycles(255);
    expect(one.pin(9).read()).toBe(false);
    one.runCycles(1);
    expect(one.pin(9).read()).toBe(true);

    const two = chip();
    two.cpu.writeData(A.DDRB, bit(3));
    two.cpu.writeData(A.OCR2A, 64);
    two.cpu.writeData(A.TCCR2A, bit(A.COM2A1) | bit(A.WGM21) | bit(A.WGM20));
    two.cpu.writeData(A.TCCR2B, bit(A.CS20));
    expect(two.pin(11).read()).toBe(false);
    two.runCycles(255);
    expect(two.pin(11).read()).toBe(false);
    two.runCycles(1);
    expect(two.pin(11).read()).toBe(true);
  });
});
