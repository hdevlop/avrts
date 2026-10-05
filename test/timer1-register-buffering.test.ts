import { describe, expect, test } from "bun:test";
import * as A from "../src";

const registers = [
  ["TCNT1", A.TCNT1L, A.TCNT1H],
  ["ICR1", A.ICR1L, A.ICR1H],
  ["OCR1A", A.OCR1AL, A.OCR1AH],
  ["OCR1B", A.OCR1BL, A.OCR1BH],
] as const;
const bit = (index: number) => 1 << index;
const writeWord = (avr: ReturnType<typeof A.AVR>, low: number, value: number) => {
  avr.cpu.writeData(low + 1, value >> 8);
  avr.cpu.writeData(low, value & 0xff);
};
const readWord = (avr: ReturnType<typeof A.AVR>, low: number) =>
  avr.cpu.readData(low) | (avr.cpu.readData(low + 1) << 8);
const counter = (avr: ReturnType<typeof A.AVR>) => readWord(avr, A.TCNT1L);
const phaseCorrect = (mode: number) => [1, 2, 3, 10, 11].includes(mode);

for (const timing of ["fast", "cycle-exact"] as const) {
  const setup = (mode: number, top = 10, compareB = 2, inverted = false) => {
    const avr = A.AVR({ timing });
    const cpu = avr.cpu;
    cpu.writeData(A.DDRB, bit(1) | bit(2));
    // Initialize unbuffered words while stopped. ICR1 requires a TOP mode.
    cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
    writeWord(avr, A.ICR1L, top);
    writeWord(avr, A.OCR1AL, [9, 11, 15].includes(mode) ? top : 3);
    writeWord(avr, A.OCR1BL, compareB);
    cpu.writeData(A.TCCR1A, (mode & 3) | bit(A.COM1B1) | (inverted ? bit(A.COM1B0) : 0));
    cpu.writeData(A.TCCR1B, ((mode >> 2) << A.WGM12) | bit(A.CS10));
    return avr;
  };

  describe(`${timing}: Timer1 atomic byte accesses`, () => {
    for (const [name, low, high] of registers) {
      test(`${name} high writes stage TEMP until a low write commits the pair`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
        writeWord(avr, low, 0x1234);
        avr.cpu.writeData(high, 0xab);
        expect(avr.cpu.data[high]).toBe(0x12);
        // Snapshot/readPwm must not consume the staged high byte.
        const saved = avr.snapshot();
        avr.pwm(10).read();
        avr.cpu.writeData(low, 0xcd);
        expect(readWord(avr, low)).toBe(0xabcd);
        const restored = A.AVR({ timing }).restore(saved);
        restored.cpu.writeData(low, 0xef);
        expect(readWord(restored, low)).toBe(0xabef);
      });

      test(`${name} high write shares TEMP with a different register`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.writeData(high, 0x67);
        avr.cpu.writeData(low === A.TCNT1L ? A.OCR1BL : A.TCNT1L, 0x89);
        expect(readWord(avr, low === A.TCNT1L ? A.OCR1BL : A.TCNT1L)).toBe(0x6789);
      });
    }

    test("low counter reads latch high across rollover and snapshot", () => {
      const avr = A.AVR({ timing });
      writeWord(avr, A.TCNT1L, 0x12ff);
      avr.cpu.writeData(A.TCCR1B, bit(A.CS10));
      expect(avr.cpu.readData(A.TCNT1L)).toBe(0xff);
      avr.runCycles(2);
      const restored = A.AVR({ timing }).restore(avr.snapshot());
      expect(restored.cpu.readData(A.TCNT1H)).toBe(0x12);
      expect(counter(restored)).toBe(0x1301);
      expect(avr.cpu.readData(A.TCNT1H)).toBe(0x12);
    });

    test("capture reads are latched; hardware capture does not overwrite TEMP", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.TCCR1B, bit(A.CS10) | bit(A.ICES1));
      writeWord(avr, A.TCNT1L, 0x12ff);
      avr.pin(8).setInput(true);
      expect(avr.cpu.readData(A.ICR1L)).toBe(0xff);
      // A later capture updates ICR1, but not the CPU's held high byte.
      avr.pin(8).setInput(false);
      avr.runCycles(2);
      avr.pin(8).setInput(true);
      expect(avr.cpu.readData(A.ICR1H)).toBe(0x12);
      expect(readWord(avr, A.ICR1L)).toBe(0x1301);
    });

    test("OCR reads bypass TEMP; an intervening ICR low read corrupts a staged write", () => {
      const avr = setup(12, 0x5678);
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
      writeWord(avr, A.OCR1AL, 0x1234);
      avr.cpu.writeData(A.TCNT1H, 0xab);
      expect(readWord(avr, A.OCR1AL)).toBe(0x1234);
      expect(avr.cpu.readData(A.TCNT1H)).toBe(0xab);
      expect(avr.cpu.readData(A.ICR1L)).toBe(0x78);
      avr.cpu.writeData(A.TCNT1L, 0xcd);
      expect(counter(avr)).toBe(0x56cd);
    });

    test("ICR writes are ignored outside modes that use ICR as TOP", () => {
      const avr = A.AVR({ timing });
      writeWord(avr, A.ICR1L, 0x1234);
      expect(readWord(avr, A.ICR1L)).toBe(0);
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
      writeWord(avr, A.ICR1L, 0x1234);
      expect(readWord(avr, A.ICR1L)).toBe(0x1234);
    });

    test("TCNT low writes preserve prescaler phase and block exactly one compare clock", () => {
      const avr = A.AVR({ timing });
      writeWord(avr, A.OCR1AL, 3);
      writeWord(avr, A.OCR1BL, 3);
      avr.cpu.writeData(A.TCCR1B, bit(A.CS11)); // /8
      avr.runCycles(3);
      writeWord(avr, A.TCNT1L, 2);
      const restored = A.AVR({ timing }).restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.runCycles(4);
        expect(counter(chip)).toBe(2);
        chip.runCycles(1);
        expect(counter(chip)).toBe(3);
        expect(chip.cpu.readData(A.TIFR1) & (bit(A.OCF1A) | bit(A.OCF1B))).toBe(0);
        writeWord(chip, A.OCR1AL, 4);
        chip.runCycles(8);
        expect(chip.cpu.readData(A.TIFR1) & bit(A.OCF1A)).toBe(0);
        chip.runCycles(8); // flag follows the equality by one timer clock.
        expect(chip.cpu.readData(A.TIFR1) & bit(A.OCF1A)).toBe(bit(A.OCF1A));
      }
    });

    test("high-only counter writes neither stop counting nor block compare", () => {
      const avr = A.AVR({ timing });
      writeWord(avr, A.OCR1AL, 1);
      avr.cpu.writeData(A.TCCR1B, bit(A.CS10));
      avr.cpu.writeData(A.TCNT1H, 0x12);
      avr.runCycles(1);
      expect(avr.cpu.readData(A.TIFR1) & bit(A.OCF1A)).toBe(0);
      expect(counter(avr)).toBe(1);
      avr.runCycles(1);
      expect(avr.cpu.readData(A.TIFR1) & bit(A.OCF1A)).toBe(bit(A.OCF1A));
    });
  });

  describe(`${timing}: Timer1 compare buffering`, () => {
    for (const mode of [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 14, 15]) {
      test(`WGM ${mode} transfers both bytes at its PWM update edge`, () => {
        const avr = setup(mode);
        const top = [1, 5].includes(mode) ? 255 : [2, 6].includes(mode) ? 511 : [3, 7].includes(mode) ? 1023 : 10;
        avr.runCycles(1);
        writeWord(avr, A.OCR1BL, 4);
        expect(readWord(avr, A.OCR1BL)).toBe(4);
        expect(avr.pwm(10).read().value).toBe(2);
        const untilUpdate = phaseCorrect(mode) ? top - 1 : [8, 9].includes(mode) ? 2 * top - 1 : top;
        avr.runCycles(untilUpdate - 1);
        expect(avr.pwm(10).read().value).toBe(2);
        avr.runCycles(1);
        expect(avr.pwm(10).read().value).toBe(4);
      });
    }

    for (const mode of [0, 4, 12, 13]) {
      test(`WGM ${mode} uses committed OCR values immediately`, () => {
        const avr = setup(mode);
        avr.cpu.writeData(A.OCR1BH, 0x12);
        expect(avr.pwm(10).read().value).toBe(2);
        avr.cpu.writeData(A.OCR1BL, 0x34);
        expect(avr.pwm(10).read().value).toBe(0x1234);
      });
    }

    for (const inverted of [false, true]) {
      test(`pending duty writes preserve the ${inverted ? "inverted" : "non-inverted"} pulse`, () => {
        const avr = setup(14, 8, 2, inverted);
        avr.runCycles(3);
        expect(avr.pin(10).read()).toBe(inverted);
        const levels: boolean[] = [];
        avr.pin(10).onChange(high => levels.push(high));
        writeWord(avr, A.OCR1BL, 6);
        expect(levels).toEqual([]);
        expect(avr.pin(10).read()).toBe(inverted);
        avr.runCycles(5); // old TOP, before BOTTOM.
        expect(levels).toEqual([]);
        avr.runCycles(1);
        expect(levels).toEqual([!inverted]);
        avr.runCycles(6);
        expect(levels).toEqual([!inverted, inverted]);
      });
    }

    test("fast PWM TOP changes wait for BOTTOM and retain TOP+1 periods", () => {
      const avr = setup(15, 10);
      avr.runCycles(7);
      writeWord(avr, A.OCR1AL, 4);
      avr.runCycles(3);
      expect(counter(avr)).toBe(10);
      expect(avr.pwm(10).read().duty).toBe(2 / 10);
      avr.runCycles(1);
      expect(counter(avr)).toBe(0);
      expect(avr.pwm(10).read().duty).toBe(2 / 4);
      avr.runCycles(4);
      expect(counter(avr)).toBe(4);
      avr.runCycles(1);
      expect(counter(avr)).toBe(0);
    });

    test("phase-correct TOP changes preserve the old falling slope", () => {
      const avr = setup(11, 10);
      avr.runCycles(7);
      writeWord(avr, A.OCR1AL, 4);
      avr.runCycles(3);
      expect(counter(avr)).toBe(10);
      expect(avr.pwm(10).read().duty).toBe(2 / 4);
      avr.runCycles(1);
      expect(counter(avr)).toBe(9);
      avr.runCycles(9);
      expect(counter(avr)).toBe(0);
      avr.runCycles(4);
      expect(counter(avr)).toBe(4);
      avr.runCycles(1);
      expect(counter(avr)).toBe(3);
    });

    test("phase/frequency TOP changes wait for BOTTOM", () => {
      const avr = setup(9, 10);
      avr.runCycles(7);
      writeWord(avr, A.OCR1AL, 4);
      avr.runCycles(12);
      expect(counter(avr)).toBe(1);
      expect(avr.pwm(10).read().duty).toBe(2 / 10);
      avr.runCycles(1);
      expect(counter(avr)).toBe(0);
      expect(avr.pwm(10).read().duty).toBe(2 / 4);
    });

    test("ICR TOP is unbuffered and lowering it below TCNT misses TOP until MAX wraps", () => {
      const avr = setup(14, 10);
      avr.runCycles(7);
      avr.cpu.writeData(A.TIFR1, 0xff);
      writeWord(avr, A.ICR1L, 4);
      expect(avr.pwm(10).read().duty).toBe(2 / 4);
      avr.runCycles(1);
      expect(counter(avr)).toBe(8);
      avr.runCycles(65536 - 8);
      expect(counter(avr)).toBe(0);
      expect(avr.cpu.readData(A.TIFR1) & (bit(A.ICF1) | bit(A.TOV1))).toBe(0);
      avr.runCycles(4);
      expect(counter(avr)).toBe(4);
      expect(avr.cpu.readData(A.TIFR1) & (bit(A.ICF1) | bit(A.TOV1))).toBe(bit(A.ICF1) | bit(A.TOV1));
    });

    test("pending buffers survive snapshot and PRR while the shared divider runs", () => {
      const avr = setup(14, 10);
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12) | bit(A.CS11));
      avr.runCycles(7 * 8 + 3);
      avr.cpu.writeData(A.PRR, bit(A.PRTIM1));
      writeWord(avr, A.OCR1BL, 5);
      const restored = A.AVR({ timing }).restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.runCycles(100);
        expect(counter(chip)).toBe(7);
        expect(chip.pwm(10).read().value).toBe(2);
        chip.cpu.writeData(A.PRR, 0);
        // The shared divider advances while Timer1's counter is gated.
        chip.runCycles(24);
        expect(counter(chip)).toBe(10);
        expect(chip.pwm(10).read().value).toBe(2);
        chip.runCycles(1);
        expect(counter(chip)).toBe(0);
        expect(chip.pwm(10).read().value).toBe(5);
      }
    });

    test("stopped-clock writes remain pending; resuming does not restart a pulse", () => {
      const avr = setup(14, 10);
      avr.runCycles(3);
      expect(avr.pin(10).read()).toBe(false);
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
      writeWord(avr, A.OCR1BL, 5);
      avr.runCycles(50);
      expect(counter(avr)).toBe(3);
      expect(avr.pwm(10).read().value).toBe(2);
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12) | bit(A.CS10));
      expect(avr.pin(10).read()).toBe(false);
      avr.runCycles(8);
      expect(avr.pwm(10).read().value).toBe(5);
      expect(avr.pin(10).read()).toBe(true);
    });

    test("leaving PWM commits the pending register immediately", () => {
      const avr = setup(14, 10);
      avr.runCycles(3);
      writeWord(avr, A.OCR1BL, 6);
      avr.cpu.writeData(A.TCCR1A, 0);
      expect(avr.pwm(10).read().value).toBe(6);
    });

    for (const [mode, mask] of [[1, 255], [2, 511], [3, 1023], [5, 255], [6, 511], [7, 1023]]) {
      test(`WGM ${mode} masks unused OCR bits on committed writes`, () => {
        const avr = setup(mode!);
        writeWord(avr, A.OCR1BL, 0xffff);
        expect(readWord(avr, A.OCR1BL)).toBe(mask!);
      });
    }

    test("dual-slope zero/full compare values hold constant levels", () => {
      for (const inverted of [false, true]) {
        const zero = setup(10, 8, 0, inverted);
        const full = setup(10, 8, 8, inverted);
        for (let cycle = 0; cycle < 24; cycle++) {
          zero.runCycles(1);
          full.runCycles(1);
          expect(zero.pin(10).read()).toBe(inverted);
          expect(full.pin(10).read()).toBe(!inverted);
        }
      }
    });

    test("fast PWM full duty is constant and zero duty has a one-clock pulse", () => {
      const full = setup(14, 8, 8);
      const zero = setup(14, 8, 0);
      full.runCycles(8);
      expect(full.pin(10).read()).toBe(true);
      zero.runCycles(8);
      expect(zero.pin(10).read()).toBe(false);
      zero.runCycles(1);
      expect(zero.pin(10).read()).toBe(true);
      zero.runCycles(1);
      expect(zero.pin(10).read()).toBe(false);
    });

    test("TCNT writes block the following zero-duty compare action", () => {
      const avr = setup(14, 8, 0);
      writeWord(avr, A.TCNT1L, 0);
      avr.runCycles(1);
      expect(avr.pin(10).read()).toBe(true);
      avr.runCycles(8);
      expect(avr.pin(10).read()).toBe(true);
      avr.runCycles(1);
      expect(avr.pin(10).read()).toBe(false);
    });

    for (const mode of [9, 11, 14, 15]) {
      test(`WGM ${mode} toggles OC1A while OC1B's toggle setting disconnects it`, () => {
        const avr = setup(mode, 10);
        avr.cpu.writeData(A.PORTB, bit(2));
        avr.cpu.writeData(A.TCCR1A, (mode & 3) | bit(A.COM1A0) | bit(A.COM1B0));
        const untilMatch = mode === 14 ? 3 : 10;
        avr.runCycles(untilMatch);
        expect(avr.pin(9).read()).toBe(true);
        expect(avr.pin(10).read()).toBe(true);
        const restored = A.AVR({ timing }).restore(avr.snapshot());
        const period = [9, 11].includes(mode) ? 20 : 11;
        restored.runCycles(period);
        expect(restored.pin(9).read()).toBe(false);
        expect(restored.pin(10).read()).toBe(true);
      });
    }

    test("disconnecting OC1B in the middle of a period releases the override", () => {
      const avr = setup(14, 8, 2);
      avr.runCycles(3);
      avr.cpu.writeData(A.PORTB, bit(2));
      expect(avr.pin(10).read()).toBe(false);
      avr.cpu.writeData(A.TCCR1A, bit(A.WGM11) | bit(A.COM1B0));
      expect(avr.pin(10).read()).toBe(true);
    });

    for (const gate of ["sleep", "prescaler reset"] as const) {
      test(`pending compare buffers survive ${gate} and snapshot restore`, () => {
        const avr = setup(14, 8, 2);
        avr.runCycles(3);
        if (gate === "sleep") {
          avr.cpu.writeData(A.SMCR, bit(A.SE) | (2 << 1));
          avr.cpu.sleep();
        } else {
          avr.cpu.writeData(A.GTCCR, bit(A.TSM) | bit(A.PSRSYNC));
        }
        writeWord(avr, A.OCR1BL, 6);
        const restored = A.AVR({ timing }).restore(avr.snapshot());
        restored.runCycles(30);
        expect(counter(restored)).toBe(3);
        expect(restored.pwm(10).read().value).toBe(2);
        if (gate === "sleep") {
          restored.cpu.requestInterrupt(A.INT0_VECTOR);
          restored.runCycles(1); // wake with global I clear.
          restored.cpu.clearInterrupt(A.INT0_VECTOR);
        } else {
          restored.cpu.writeData(A.GTCCR, 0);
        }
        const left = 9 - counter(restored);
        restored.runCycles(left);
        expect(counter(restored)).toBe(0);
        expect(restored.pwm(10).read().value).toBe(6);
      });
    }

    test("ICR TOP raises ICF1 and restores its acknowledgement", () => {
      const avr = setup(14, 8);
      avr.cpu.writeData(A.TIMSK1, bit(A.ICIE1));
      avr.runCycles(8);
      expect(avr.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(bit(A.ICF1));
      const restored = A.AVR({ timing }).restore(avr.snapshot());
      restored.cpu.sreg.I = true;
      restored.step();
      expect(restored.cpu.pc).toBe(A.TIMER1_CAPT_VECTOR);
      expect(restored.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(0);
    });

    test("old snapshots use committed register words and reset discards TEMP/buffers", () => {
      const avr = setup(14, 8);
      const saved = avr.snapshot();
      delete saved.timer1.tempHigh;
      delete saved.timer1.activeOcrA;
      delete saved.timer1.activeOcrB;
      delete saved.timer1.compareBlocked;
      const restored = A.AVR({ timing }).restore(saved);
      expect(restored.pwm(10).read().value).toBe(2);
      restored.cpu.writeData(A.OCR1BH, 0x12);
      restored.reset();
      expect(restored.cpu.readData(A.TCNT1H)).toBe(0);
      restored.cpu.writeData(A.TCNT1L, 0x34);
      expect(counter(restored)).toBe(0x34);
      expect(restored.pwm(10).read().value).toBe(0);
    });
  });
}
