import { describe, expect, test } from "bun:test";
import * as A from "../src";
import { Gpio } from "../src/peripherals/gpio";

const bit = (n: number) => 1 << n;
// Datasheet bit layouts, including registers already masked before this pass.
const registers = [
  { name: "TCCR0A", addr: A.TCCR0A, mask: 0xf3 },
  { name: "TCCR0B", addr: A.TCCR0B, mask: 0x0f },
  { name: "TCCR1A", addr: A.TCCR1A, mask: 0xf3 },
  { name: "TCCR1B", addr: A.TCCR1B, mask: 0xdf },
  { name: "TCCR1C", addr: A.TCCR1C, mask: 0 },
  { name: "TCCR2A", addr: A.TCCR2A, mask: 0xf3 },
  { name: "TCCR2B", addr: A.TCCR2B, mask: 0x0f },
  { name: "TIMSK0", addr: A.TIMSK0, mask: 0x07 },
  { name: "TIMSK1", addr: A.TIMSK1, mask: 0x27 },
  { name: "TIMSK2", addr: A.TIMSK2, mask: 0x07 },
  { name: "PCICR", addr: A.PCICR, mask: 0x07 },
  { name: "PCMSK1", addr: A.PCMSK1, mask: 0x7f },
  { name: "EICRA", addr: A.EICRA, mask: 0x0f },
  { name: "EIMSK", addr: A.EIMSK, mask: 0x03 },
  { name: "ADCSRB", addr: A.ADCSRB, mask: 0x47 },
  { name: "ADMUX", addr: A.ADMUX, mask: 0xef },
  { name: "DIDR0", addr: A.DIDR0, mask: 0x3f },
  { name: "DIDR1", addr: A.DIDR1, mask: 0x03 },
  { name: "EEARH", addr: A.EEARH, mask: 0x03 },
  { name: "UBRR0H", addr: A.UBRR0H, mask: 0x0f },
  { name: "SMCR", addr: A.SMCR, mask: 0x0f },
  { name: "TWAMR", addr: A.TWAMR, mask: 0xfe },
  { name: "DDRC", addr: A.DDRC, mask: 0x7f },
  { name: "PORTC", addr: A.PORTC, mask: 0x7f },
] as const;

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: register bit ownership`, () => {
    for (const r of registers) {
      test(`${r.name} retains implemented bits and reads reserved/strobe bits as zero`, () => {
        const avr = A.AVR({ timing });
        for (const value of [0xff, 0xa5, 0x5a, 0]) {
          avr.cpu.writeData(r.addr, value);
          expect(avr.cpu.readData(r.addr)).toBe(value & r.mask);
          const restored = A.AVR().restore(avr.snapshot());
          expect(restored.cpu.readData(r.addr)).toBe(value & r.mask);
        }
      });
    }

    test("MCUSR firmware writes preserve or clear reset flags but cannot set them", () => {
      const avr = A.AVR({ timing });
      expect(avr.cpu.readData(A.MCUSR)).toBe(bit(A.PORF));
      avr.cpu.writeData(A.MCUSR, 0xff);
      expect(avr.cpu.readData(A.MCUSR)).toBe(bit(A.PORF));
      avr.cpu.writeData(A.MCUSR, 0);
      avr.cpu.writeData(A.MCUSR, 0xff);
      expect(avr.cpu.readData(A.MCUSR)).toBe(0);
      const restored = A.AVR().restore(avr.snapshot());
      restored.cpu.writeData(A.MCUSR, 0xff);
      expect(restored.cpu.readData(A.MCUSR)).toBe(0);
      restored.cpu.writeData(A.WDTCSR, 0);
      expect(restored.cpu.readData(A.WDTCSR) & bit(A.WDE)).toBe(0);
      restored.resetBrownOut();
      restored.cpu.writeData(A.MCUSR, bit(A.BORF) | bit(A.WDRF));
      expect(restored.cpu.readData(A.MCUSR)).toBe(bit(A.BORF));
    });

    test("reset causes accumulate across external, brown-out and watchdog resets until cleared", () => {
      const avr = A.AVR({ timing, clockHz: 1_000 });
      avr.cpu.flash[0] = 0xcfff;
      avr.resetExternal();
      expect(avr.cpu.readData(A.MCUSR)).toBe(bit(A.PORF) | bit(A.EXTRF));
      avr.resetBrownOut();
      expect(avr.cpu.readData(A.MCUSR)).toBe(bit(A.PORF) | bit(A.EXTRF) | bit(A.BORF));
      const restored = A.AVR().restore(avr.snapshot());
      restored.cpu.writeData(A.WDTCSR, bit(A.WDE));
      restored.runCycles(16);
      expect(restored.cpu.readData(A.MCUSR)).toBe(0x0f);
      restored.cpu.writeData(A.MCUSR, 0xff & ~bit(A.WDRF));
      expect(restored.cpu.readData(A.MCUSR)).toBe(0x07);
      restored.resetExternal();
      expect(restored.cpu.readData(A.MCUSR)).toBe(0x07);
      restored.reset(); // Power-on clears other causes.
      expect(restored.cpu.readData(A.MCUSR)).toBe(bit(A.PORF));
    });

    test("reserved PC7 never creates an input, output, toggle or pin-change request", () => {
      const avr = A.AVR({ timing });
      const gpio = new Gpio(avr.cpu);
      avr.cpu.writeData(A.PCMSK1, 0xff);
      avr.cpu.writeData(A.PCICR, bit(1));
      gpio.setInput("C", 7, true);
      expect(gpio.readPinByte("C")).toBe(0);
      expect(avr.cpu.readData(A.PINC)).toBe(0);
      avr.cpu.writeData(A.DDRC, 0x80);
      avr.cpu.writeData(A.PORTC, 0x80);
      avr.cpu.writeData(A.PINC, 0x80);
      expect(avr.cpu.readData(A.PORTC)).toBe(0);
      expect(avr.cpu.readData(A.PINC)).toBe(0);
      expect(avr.cpu.readData(A.PCIFR)).toBe(0);
      expect(avr.cpu.snapshot().pendingInterrupts).not.toContain(A.PCINT1_VECTOR);
      // A real implemented port-C bit still toggles and raises the interrupt.
      avr.cpu.writeData(A.DDRC, 1);
      avr.cpu.writeData(A.PINC, 1);
      expect(avr.cpu.readData(A.PORTC)).toBe(1);
      expect(avr.cpu.readData(A.PINC)).toBe(1);
      expect(avr.cpu.readData(A.PCIFR) & bit(1)).toBe(bit(1));
    });

    test("baud high-byte reserved bits cannot multiply frame time", () => {
      const avr = A.AVR({ timing });
      const bytes: number[] = [];
      avr.serial.onByte(byte => bytes.push(byte));
      avr.cpu.writeData(A.UBRR0H, 0xf0);
      avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0));
      avr.cpu.writeData(A.UDR0, 0x55);
      avr.runCycles(175);
      expect(bytes).toEqual([]);
      avr.runCycles(1);
      expect(bytes).toEqual([0x55]);
    });

    test("EEPROM's two high address bits still select the last byte", () => {
      const avr = A.AVR({ timing });
      avr.eeprom.write(1023, 0x5a);
      avr.cpu.writeData(A.EEARH, 0xff);
      avr.cpu.writeData(A.EEARL, 0xff);
      avr.cpu.writeData(A.EECR, bit(A.EERE));
      expect(avr.cpu.readData(A.EEARH)).toBe(3);
      expect(avr.cpu.readData(A.EEDR)).toBe(0x5a);
    });

    for (const left of [false, true]) {
      for (const restored of [false, true]) {
        test(`ADC data writes preserve ${left ? "left" : "right"}-aligned results and read locking (${restored ? "restored" : "direct"})`, () => {
          const source = A.AVR({ timing });
          source.cpu.writeData(A.ADMUX, left ? bit(A.ADLAR) : 0);
          source.analog(0).setValue(0x155);
          source.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
          source.runCycles(50);
          source.cpu.writeData(A.ADCL, 0xff);
          source.cpu.writeData(A.ADCH, 0xff);
          const low = source.cpu.readData(A.ADCL); // Lock the result.
          const high = source.cpu.data[A.ADCH]!;
          expect(low).toBe(left ? 0x40 : 0x55);
          expect(high).toBe(left ? 0x55 : 1);
          const avr = restored ? A.AVR().restore(source.snapshot()) : source;
          avr.cpu.writeData(A.ADCL, 0);
          avr.cpu.writeData(A.ADCH, 0);
          avr.analog(0).setValue(0x2aa);
          avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | bit(A.ADIF));
          avr.runCycles(26);
          expect(avr.cpu.data[A.ADCL]).toBe(low);
          expect(avr.cpu.readData(A.ADCH)).toBe(high); // Unlock only with a read.
          avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC) | bit(A.ADIF));
          avr.runCycles(26);
          expect(avr.cpu.readData(A.ADCL)).toBe(left ? 0x80 : 0xaa);
          expect(avr.cpu.readData(A.ADCH)).toBe(left ? 0xaa : 2);
        });
      }
    }

    for (const r of [
      { name: "TIFR0", addr: A.TIFR0, mask: 0x07 },
      { name: "TIFR1", addr: A.TIFR1, mask: 0x27 },
      { name: "TIFR2", addr: A.TIFR2, mask: 0x07 },
      { name: "PCIFR", addr: A.PCIFR, mask: 0x07 },
      { name: "EIFR", addr: A.EIFR, mask: 0x03 },
    ]) {
      test(`${r.name} masks unsupported flags while preserving its write-one-to-clear protocol`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.writeData(A.EICRA, 0x0f); // Edge mode retains external flags.
        avr.cpu.data[r.addr] = 0xff; // Seed hardware flags, including invalid legacy bits.
        avr.cpu.writeData(r.addr, 0);
        expect(avr.cpu.readData(r.addr)).toBe(r.mask);
        avr.cpu.writeData(r.addr, 1);
        expect(avr.cpu.readData(r.addr)).toBe(r.mask & ~1);
        avr.cpu.writeData(r.addr, 0xff);
        expect(avr.cpu.readData(r.addr)).toBe(0);
      });
    }
  });
}
