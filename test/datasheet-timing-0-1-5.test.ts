import { describe, expect, test } from "bun:test";
import * as A from "../src";
import type { AdcSample } from "../src";

const bit = (n: number) => 1 << n;

function chip() {
  const avr = A.AVR();
  avr.cpu.flash.fill(0); // NOPs: every instruction takes one cycle.
  return avr;
}

describe("USART byte mode paces 8N1 frames at 10 bit times", () => {
  // 9600 baud at 16 MHz: UBRR0 = 103, 104 x 16 cycles a bit, 16,640 cycles a frame.
  const frame = 10 * 104 * 16;

  test("back-to-back transmitted bytes complete one frame apart", () => {
    const avr = chip();
    const done: number[] = [];
    avr.serial.onByte(() => done.push(avr.cpu.cycles));
    avr.cpu.writeData(A.UBRR0L, 103);
    avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0));
    let sent = 0;
    while (done.length < 3 && avr.cpu.cycles < 10 * frame) {
      if (sent < 3 && avr.cpu.readData(A.UCSR0A) & bit(A.UDRE0)) avr.cpu.writeData(A.UDR0, 0x41 + sent++);
      avr.runCycles(1);
    }
    expect(done).toHaveLength(3);
    expect(done[1]! - done[0]!).toBe(frame);
    expect(done[2]! - done[1]!).toBe(frame);
  });

  test("back-to-back host bytes arrive one frame apart", () => {
    const avr = chip();
    avr.cpu.writeData(A.UBRR0L, 103);
    avr.cpu.writeData(A.UCSR0B, bit(A.RXEN0));
    avr.serial.write("abc");
    const arrived: number[] = [];
    while (arrived.length < 3 && avr.cpu.cycles < 10 * frame) {
      avr.runCycles(1);
      if (avr.cpu.readData(A.UCSR0A) & bit(A.RXC0)) {
        avr.cpu.readData(A.UDR0);
        arrived.push(avr.cpu.cycles);
      }
    }
    expect(arrived).toEqual([frame, 2 * frame, 3 * frame]);
  });
});

describe("fast PWM holds the output through the compare value", () => {
  test("Timer0 OCR0A = 64 is high for 65 of every 256 clocks", () => {
    const avr = chip();
    const edges: [boolean, number][] = [];
    avr.pin(6).onChange((high, event) => edges.push([high, event.cycles]));
    avr.cpu.writeData(A.DDRD, bit(6));
    avr.cpu.writeData(A.OCR0A, 64);
    avr.cpu.writeData(A.TCCR0A, bit(A.COM0A1) | bit(A.WGM01) | bit(A.WGM00));
    avr.cpu.writeData(A.TCCR0B, bit(A.CS00));
    avr.runCycles(4 * 256);
    const rises = edges.filter(([high]) => high).map(([, cycles]) => cycles);
    const falls = edges.filter(([high]) => !high).map(([, cycles]) => cycles);
    for (let i = 1; i < rises.length; i++) expect(rises[i]! - rises[i - 1]!).toBe(256);
    // The last rise is on the run's final cycle; its fall comes after the run.
    expect(rises.length).toBeGreaterThan(3);
    for (const rise of rises.slice(0, -1)) expect(falls).toContain(rise + 65);
    expect(avr.pwm(6).read().duty).toBe(65 / 256);
  });
});

describe("ADC sampler", () => {
  const prescale = bit(A.ADPS2) | bit(A.ADPS1) | bit(A.ADPS0); // /128
  const start = (avr: ReturnType<typeof chip>, admux: number) => {
    avr.cpu.writeData(A.ADMUX, admux);
    avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | prescale);
    return avr.cpu.cycles;
  };
  const result = (avr: ReturnType<typeof chip>) => {
    avr.runCycles(25 * 128 + 8);
    expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(0);
    return avr.cpu.readData(A.ADCL) | (avr.cpu.readData(A.ADCH) << 8);
  };
  const avccRef = bit(A.REFS0);

  test("is asked at the sample point and converts by Vin x 1024 / Vref", () => {
    const avr = chip();
    const samples: AdcSample[] = [];
    avr.useAnalogSampler((sample) => (samples.push(sample), 2.5));
    const started = start(avr, avccRef | 3);
    expect(result(avr)).toBe(512);
    // The first conversion samples 13.5 ADC clocks after it starts.
    expect(samples).toEqual([{ channel: 3, cycles: started + 13.5 * 128, reference: "avcc" }]);
  });

  test("converts against the configured AVcc, AREF and the internal 1.1 V reference", () => {
    const avr = chip();
    avr.useAnalogReference({ avcc: 4, aref: 2 });
    avr.useAnalogSampler(() => 1);
    start(avr, avccRef);
    expect(result(avr)).toBe(256);
    start(avr, 0); // AREF
    expect(result(avr)).toBe(512);
    start(avr, bit(A.REFS1) | bit(A.REFS0));
    expect(result(avr)).toBe(Math.floor(1024 / 1.1));
  });

  test("undefined falls back to the set value; internal channels are not sampled", () => {
    const avr = chip();
    const channels: number[] = [];
    avr.useAnalogSampler(({ channel }) => (channels.push(channel), undefined));
    avr.analog(0).setVoltage(1.25);
    start(avr, avccRef);
    expect(result(avr)).toBe(256);
    start(avr, avccRef | 14); // bandgap
    expect(result(avr)).toBe(Math.floor((1.1 * 1024) / 5));
    expect(channels).toEqual([0]);
    avr.useAnalogSampler(null);
    start(avr, avccRef);
    expect(result(avr)).toBe(256);
    expect(channels).toEqual([0]);
  });

  test("rejects non-finite samples and invalid references", () => {
    const avr = chip();
    avr.useAnalogSampler(() => Number.NaN);
    start(avr, avccRef);
    expect(() => avr.runCycles(25 * 128)).toThrow(RangeError);
    expect(() => avr.useAnalogReference({ avcc: 0 })).toThrow(RangeError);
  });
});
