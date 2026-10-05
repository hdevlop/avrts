import { describe, expect, test } from "bun:test";
import * as A from "../src";

type Avr = ReturnType<typeof A.AVR>;
const bit = (n: number) => 1 << n;
const timers = [
  { name: "Timer0", controlA: A.TCCR0A, controlB: A.TCCR0B, count: A.TCNT0,
    ocrA: A.OCR0A, ocrB: A.OCR0B, flags: A.TIFR0, mask: A.TIMSK0,
    vector: A.TIMER0_COMPA_VECTOR, gate: A.PRTIM0, reset: A.PSRSYNC,
    pinA: 6, pinB: 5, ddr: A.DDRD, ddrMask: bit(6) | bit(5), port: A.PORTD, portB: bit(5), snapshot: "timer0" },
  { name: "Timer2", controlA: A.TCCR2A, controlB: A.TCCR2B, count: A.TCNT2,
    ocrA: A.OCR2A, ocrB: A.OCR2B, flags: A.TIFR2, mask: A.TIMSK2,
    vector: A.TIMER2_COMPA_VECTOR, gate: A.PRTIM2, reset: A.PSRASY,
    pinA: 11, pinB: 3, ddr: A.DDRB, ddrMask: bit(3), port: A.PORTD, portB: bit(3), snapshot: "timer2" },
] as const;

for (const timing of ["fast", "cycle-exact"] as const) {
  for (const t of timers) {
    const configure = (avr: Avr, mode: number, prescaler = 1, inverted = false) => {
      avr.cpu.writeData(t.controlA, (mode & 3) | (2 << 6) | ((inverted ? 3 : 2) << 4));
      avr.cpu.writeData(t.controlB, ((mode >> 2) << 3) | prescaler);
    };
    const setup = (mode: number, top = 8, compare = 2, inverted = false) => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(t.ddr, t.ddrMask);
      if (t.name === "Timer2") avr.cpu.writeData(A.DDRD, bit(3));
      avr.cpu.writeData(t.ocrA, top);
      avr.cpu.writeData(t.ocrB, compare);
      configure(avr, mode, 1, inverted);
      return avr;
    };
    const count = (avr: Avr) => avr.cpu.readData(t.count);
    const flags = (avr: Avr) => avr.cpu.readData(t.flags);

    describe(`${timing}: ${t.name} PWM buffers and boundaries`, () => {
      for (const mode of [1, 3, 5, 7]) {
        test(`WGM ${mode} transfers both OCR buffers at its update edge`, () => {
          const avr = setup(mode);
          const top = mode < 4 ? 255 : 8;
          avr.runCycles(1);
          avr.cpu.writeData(t.ocrA, 6);
          avr.cpu.writeData(t.ocrB, 4);
          expect(avr.cpu.readData(t.ocrB)).toBe(4);
          expect(avr.pwm(t.pinB).read().value).toBe(2);
          expect(avr.pwm(t.pinA).read().value).toBe(8);
          const untilUpdate = mode === 1 || mode === 5 ? top - 1 : top;
          avr.runCycles(untilUpdate - 1);
          expect(avr.pwm(t.pinB).read().value).toBe(2);
          avr.runCycles(1);
          expect(avr.pwm(t.pinB).read().value).toBe(4);
          expect(avr.pwm(t.pinA).read().value).toBe(6);
          expect(avr.pwm(t.pinB).read().duty).toBe(4 / (mode < 4 ? 255 : 6));
        });

        test(`WGM ${mode} has the specified period and overflow edge`, () => {
          const avr = setup(mode);
          const top = mode < 4 ? 255 : 8;
          const phase = mode === 1 || mode === 5;
          avr.runCycles(top);
          expect(count(avr)).toBe(top);
          expect(flags(avr) & 1).toBe(0);
          avr.cpu.writeData(t.flags, 1);
          avr.runCycles(phase ? top : 1);
          expect(count(avr)).toBe(0);
          expect(flags(avr) & 1).toBe(1);
          const restored = A.AVR({ timing }).restore(avr.snapshot());
          restored.runCycles(phase ? 2 * top : top + 1);
          expect(count(restored)).toBe(0);
        });
      }

      for (const inverted of [false, true]) {
        test(`pending fast-PWM duty preserves the ${inverted ? "inverted" : "normal"} pulse`, () => {
          const avr = setup(7, 8, 2, inverted);
          avr.runCycles(3);
          const levels: boolean[] = [];
          avr.pin(t.pinB).onChange(high => levels.push(high));
          avr.cpu.writeData(t.ocrB, 6);
          avr.runCycles(5);
          expect(levels).toEqual([]);
          avr.runCycles(1);
          expect(levels).toEqual([!inverted]);
          avr.runCycles(6);
          expect(levels).toEqual([!inverted, inverted]);
        });

        test(`phase-correct PWM drives both slopes with ${inverted ? "inverted" : "normal"} polarity`, () => {
          const avr = setup(5, 8, 2, inverted);
          avr.runCycles(3);
          expect(avr.pin(t.pinB).read()).toBe(inverted);
          const restored = A.AVR({ timing }).restore(avr.snapshot());
          restored.runCycles(5);
          expect(count(restored)).toBe(8);
          restored.runCycles(6);
          expect(count(restored)).toBe(2);
          expect(restored.pin(t.pinB).read()).toBe(!inverted);
          restored.runCycles(2);
          expect(count(restored)).toBe(0);
          expect(flags(restored) & 1).toBe(1);
        });

        for (const value of [0, 8]) {
          test(`phase-correct duty ${value} stays constant with polarity ${inverted}`, () => {
            const avr = setup(5, 8, value, inverted);
            const levels: boolean[] = [];
            avr.pin(t.pinB).onChange(high => levels.push(high));
            avr.runCycles(50);
            expect(levels).toEqual([]);
            expect(avr.pin(t.pinB).read()).toBe(value === 0 ? inverted : !inverted);
          });
        }

        test(`fast-PWM zero emits a one-clock pulse with polarity ${inverted}`, () => {
          const avr = setup(7, 8, 0, inverted);
          avr.runCycles(1);
          expect(avr.pin(t.pinB).read()).toBe(inverted);
          avr.runCycles(8);
          expect(avr.pin(t.pinB).read()).toBe(!inverted);
          avr.runCycles(1);
          expect(avr.pin(t.pinB).read()).toBe(inverted);
        });

        test(`fast-PWM full duty stays constant with polarity ${inverted}`, () => {
          const avr = setup(7, 8, 8, inverted);
          const levels: boolean[] = [];
          avr.pin(t.pinB).onChange(high => levels.push(high));
          avr.runCycles(50);
          expect(levels).toEqual([]);
          expect(avr.pin(t.pinB).read()).toBe(!inverted);
        });
      }

      for (const mode of [5, 7]) {
        test(`WGM ${mode} permits A toggle and disconnects B toggle`, () => {
          const avr = setup(mode);
          avr.cpu.writeData(t.port, t.portB);
          avr.cpu.writeData(t.controlA, (mode & 3) | (1 << 6) | (1 << 4));
          const initialA = avr.pin(t.pinA).read();
          avr.runCycles(8);
          expect(avr.pin(t.pinA).read()).toBe(!initialA);
          expect(avr.pin(t.pinB).read()).toBe(true);
          const restored = A.AVR({ timing }).restore(avr.snapshot());
          restored.runCycles(mode === 5 ? 16 : 9);
          expect(restored.pin(t.pinA).read()).toBe(initialA);
        });
      }

      test("dynamic phase-correct TOP preserves the old falling slope", () => {
        const avr = setup(5);
        avr.runCycles(3);
        avr.cpu.writeData(t.ocrA, 4);
        const restored = A.AVR({ timing }).restore(avr.snapshot());
        restored.runCycles(5);
        expect(count(restored)).toBe(8);
        expect(restored.pwm(t.pinA).read().value).toBe(4);
        restored.runCycles(1);
        expect(count(restored)).toBe(7);
        restored.runCycles(7);
        expect(count(restored)).toBe(0);
        restored.runCycles(8);
        expect(count(restored)).toBe(0);
      });

      test("full-duty to partial-duty transfer fixes the output at TOP", () => {
        const avr = setup(5, 8, 8);
        avr.runCycles(3);
        avr.cpu.writeData(t.ocrB, 2);
        avr.runCycles(5);
        expect(avr.pin(t.pinB).read()).toBe(false);
        avr.runCycles(6);
        expect(avr.pin(t.pinB).read()).toBe(true);
      });

      for (const inverted of [false, true]) {
        test(`phase-correct compare above TOP does not create a ${inverted ? "inverted" : "normal"} TOP transition`, () => {
          const avr = setup(5, 8, 10, inverted);
          avr.runCycles(16);
          const restored = A.AVR({ timing }).restore(avr.snapshot());
          expect(restored.pin(t.pinB).read()).toBe(!inverted);
          const edges: boolean[] = [];
          restored.pin(t.pinB).onChange(high => edges.push(high));
          restored.cpu.writeData(t.flags, bit(2));
          restored.runCycles(32);
          expect(edges).toEqual([]);
          expect(restored.cpu.readData(t.flags) & bit(2)).toBe(0);
        });
      }

      for (const gate of ["PRR", "sleep", "GTCCR", "clock stop"] as const) {
        test(`pending buffers survive ${gate} and restore`, () => {
          const avr = setup(7);
          avr.runCycles(3);
          if (gate === "PRR") avr.cpu.writeData(A.PRR, bit(t.gate));
          else if (gate === "sleep") {
            avr.cpu.writeData(A.SMCR, bit(A.SE) | (2 << 1));
            avr.cpu.sleep();
          } else if (gate === "GTCCR") avr.cpu.writeData(A.GTCCR, bit(A.TSM) | bit(t.reset));
          else avr.cpu.writeData(t.controlB, bit(3));
          avr.cpu.writeData(t.ocrB, 6);
          const restored = A.AVR({ timing }).restore(avr.snapshot());
          restored.runCycles(30);
          expect(count(restored)).toBe(3);
          expect(restored.pwm(t.pinB).read().value).toBe(2);
          if (gate === "PRR") restored.cpu.writeData(A.PRR, 0);
          else if (gate === "sleep") {
            restored.cpu.requestInterrupt(A.INT0_VECTOR);
            restored.runCycles(1);
            restored.cpu.clearInterrupt(A.INT0_VECTOR);
          } else if (gate === "GTCCR") restored.cpu.writeData(A.GTCCR, 0);
          else restored.cpu.writeData(t.controlB, bit(3) | 1);
          restored.runCycles(9 - count(restored));
          expect(count(restored)).toBe(0);
          expect(restored.pwm(t.pinB).read().value).toBe(6);
        });
      }

      test("writing variable fast-PWM TOP blocks the clear and misses TOP until wrap", () => {
        const avr = setup(7);
        avr.cpu.writeData(t.count, 8);
        const restored = A.AVR({ timing }).restore(avr.snapshot());
        restored.runCycles(1);
        expect(count(restored)).toBe(9);
        expect(flags(restored) & 1).toBe(0);
        restored.runCycles(256 - 9);
        expect(count(restored)).toBe(0);
        restored.runCycles(9);
        expect(count(restored)).toBe(0);
        expect(flags(restored) & 1).toBe(1);
      });

      test("writing BOTTOM on the falling slope misses it until the counter wraps", () => {
        const avr = setup(5);
        avr.runCycles(8);
        avr.cpu.writeData(t.count, 0);
        const restored = A.AVR({ timing }).restore(avr.snapshot());
        restored.runCycles(1);
        expect(count(restored)).toBe(255);
        expect(flags(restored) & 1).toBe(0);
        restored.runCycles(255);
        expect(count(restored)).toBe(0);
        expect(flags(restored) & 1).toBe(1);
      });

      test("leaving PWM promotes buffers and legacy snapshots have safe defaults", () => {
        const avr = setup(7);
        avr.runCycles(3);
        avr.cpu.writeData(t.ocrB, 6);
        configure(avr, 0);
        expect(avr.pwm(t.pinB).read().value).toBe(6);
        const saved = avr.snapshot();
        delete saved[t.snapshot].activeOcrA;
        delete saved[t.snapshot].activeOcrB;
        delete saved[t.snapshot].countingDown;
        delete saved[t.snapshot].compareBlocked;
        const restored = A.AVR({ timing }).restore(saved);
        expect(restored.pwm(t.pinB).read().value).toBe(6);
        restored.reset();
        expect(restored.pwm(t.pinB).read().value).toBe(0);
        expect(count(restored)).toBe(0);
      });

      for (const mode of [1, 3, 5, 7]) {
        test(`WGM ${mode} bulk advance matches one-clock stepping through duty and TOP writes`, () => {
          const bulk = setup(mode);
          const single = setup(mode);
          let seed = 0x328;
          for (let i = 0; i < 30; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const cycles = 1 + (seed % 120);
            bulk.runCycles(cycles);
            for (let clock = 0; clock < cycles; clock++) single.runCycles(1);
            expect(count(bulk)).toBe(count(single));
            expect(flags(bulk)).toBe(flags(single));
            expect(bulk.pin(t.pinB).read()).toBe(single.pin(t.pinB).read());
            expect(bulk.pwm(t.pinB).read()).toEqual(single.pwm(t.pinB).read());
            for (const chip of [bulk, single]) {
              chip.cpu.writeData(t.flags, 7);
              chip.cpu.writeData(t.ocrA, 4 + (seed % 12));
              chip.cpu.writeData(t.ocrB, seed % 8);
            }
          }
        });
      }

      test("force-compare strobes change pins without flags or CTC clear", () => {
        const avr = setup(2);
        avr.cpu.writeData(t.controlA, 2 | (1 << 6) | (1 << 4));
        avr.runCycles(3);
        avr.cpu.writeData(t.flags, 7);
        const initialA = avr.pin(t.pinA).read();
        const initialB = avr.pin(t.pinB).read();
        avr.cpu.writeData(t.controlB, 1 | 0xc0);
        expect(avr.cpu.readData(t.controlB)).toBe(1);
        expect(count(avr)).toBe(3);
        expect(flags(avr)).toBe(0);
        expect(avr.pin(t.pinA).read()).toBe(!initialA);
        expect(avr.pin(t.pinB).read()).toBe(!initialB);
      });

      test("TCNT and control-only writes retain prescaler phase", () => {
        const avr = setup(0);
        configure(avr, 0, 2); // /8
        avr.runCycles(3);
        avr.cpu.writeData(t.count, 4);
        avr.cpu.writeData(t.controlB, 2 | 0x80);
        const restored = A.AVR({ timing }).restore(avr.snapshot());
        restored.runCycles(4);
        expect(count(restored)).toBe(4);
        restored.runCycles(1);
        expect(count(restored)).toBe(5);
      });
    });
  }

  describe(`${timing}: all timer CTC and compare-flag boundaries`, () => {
    const all = [
      ...timers.map(t => ({ ...t, max: 255, mode: 2,
        write: (avr: Avr, addr: number, value: number) => avr.cpu.writeData(addr, value),
        read: (avr: Avr, addr: number) => avr.cpu.readData(addr) })),
      { name: "Timer1", controlA: A.TCCR1A, controlB: A.TCCR1B, count: A.TCNT1L,
        ocrA: A.OCR1AL, ocrB: A.OCR1BL, flags: A.TIFR1, mask: A.TIMSK1,
        vector: A.TIMER1_COMPA_VECTOR, max: 65535, mode: 4,
        write: (avr: Avr, addr: number, value: number) => {
          avr.cpu.writeData(addr + 1, value >> 8);
          avr.cpu.writeData(addr, value & 255);
        },
        read: (avr: Avr, addr: number) => avr.cpu.readData(addr) | (avr.cpu.readData(addr + 1) << 8) },
    ];
    for (const t of all) {
      const setup = (top: number, mode = t.mode) => {
        const avr = A.AVR({ timing });
        t.write(avr, t.ocrA, top);
        t.write(avr, t.ocrB, 2);
        avr.cpu.writeData(t.controlA, mode & 3);
        avr.cpu.writeData(t.controlB, ((mode >> 2) << 3) | 1);
        return avr;
      };
      for (const top of [0, 1, 3, t.max]) {
        test(`${t.name} CTC TOP ${top} lasts TOP+1 clocks`, () => {
          const avr = setup(top);
          avr.runCycles(top);
          expect(t.read(avr, t.count)).toBe(top);
          expect(avr.cpu.readData(t.flags) & bit(1)).toBe(0);
          const restored = A.AVR({ timing }).restore(avr.snapshot());
          restored.runCycles(1);
          expect(t.read(restored, t.count)).toBe(0);
          expect(restored.cpu.readData(t.flags) & bit(1)).toBe(bit(1));
          restored.cpu.writeData(t.flags, 7);
          restored.runCycles(top + 1);
          expect(t.read(restored, t.count)).toBe(0);
          expect(restored.cpu.readData(t.flags) & bit(1)).toBe(bit(1));
        });
      }

      test(`${t.name} normal compare flags follow equality by one clock`, () => {
        const avr = setup(3, 0);
        avr.runCycles(2);
        expect(avr.cpu.readData(t.flags) & bit(2)).toBe(0);
        avr.runCycles(1);
        expect(avr.cpu.readData(t.flags) & bit(2)).toBe(bit(2));
        expect(avr.cpu.readData(t.flags) & bit(1)).toBe(0);
        avr.runCycles(1);
        expect(avr.cpu.readData(t.flags) & bit(1)).toBe(bit(1));
      });

      test(`${t.name} TCNT write suppresses equality on the following clock`, () => {
        const avr = setup(3, 0);
        t.write(avr, t.count, 3);
        const restored = A.AVR({ timing }).restore(avr.snapshot());
        restored.runCycles(1);
        expect(avr.cpu.readData(t.flags) & bit(1)).toBe(0);
        expect(restored.cpu.readData(t.flags) & bit(1)).toBe(0);
        t.write(restored, t.ocrA, 4); // OCR equal to current count is not blocked.
        restored.runCycles(1);
        expect(restored.cpu.readData(t.flags) & bit(1)).toBe(bit(1));
      });

      test(`${t.name} lowering CTC TOP below TCNT misses it until MAX wraps`, () => {
        const avr = setup(8);
        avr.runCycles(5);
        t.write(avr, t.ocrA, 3);
        avr.runCycles(t.max - 5);
        expect(t.read(avr, t.count)).toBe(t.max);
        expect(avr.cpu.readData(t.flags) & bit(1)).toBe(0);
        avr.runCycles(1);
        expect(t.read(avr, t.count)).toBe(0);
        expect(avr.cpu.readData(t.flags) & 1).toBe(1);
        avr.runCycles(4);
        expect(t.read(avr, t.count)).toBe(0);
        expect(avr.cpu.readData(t.flags) & bit(1)).toBe(bit(1));
      });

      test(`${t.name} writing CTC TOP blocks the clear and misses TOP until MAX wraps`, () => {
        const avr = setup(3);
        t.write(avr, t.count, 3);
        const restored = A.AVR({ timing }).restore(avr.snapshot());
        restored.runCycles(1);
        expect(t.read(restored, t.count)).toBe(4);
        expect(restored.cpu.readData(t.flags) & bit(1)).toBe(0);
        restored.runCycles(t.max - 3);
        expect(t.read(restored, t.count)).toBe(0);
        expect(restored.cpu.readData(t.flags) & 1).toBe(1);
        restored.runCycles(4);
        expect(t.read(restored, t.count)).toBe(0);
        expect(restored.cpu.readData(t.flags) & bit(1)).toBe(bit(1));
      });

      test(`${t.name} restored equality dispatches COMPA only on the next clock`, () => {
        const avr = setup(8);
        avr.cpu.writeData(t.mask, bit(1));
        avr.runCycles(8);
        const restored = A.AVR({ timing }).restore(avr.snapshot());
        restored.cpu.sreg.I = true;
        restored.step();
        expect(restored.cpu.pc).toBe(t.vector);
        expect(restored.cpu.readData(t.flags) & bit(1)).toBe(0);
      });
    }
  });

  test(`${timing}: Timer1 phase-correct full-to-partial duty changes at TOP`, () => {
    const avr = A.AVR({ timing });
    const word = (addr: number, value: number) => {
      avr.cpu.writeData(addr + 1, value >> 8);
      avr.cpu.writeData(addr, value & 255);
    };
    avr.cpu.writeData(A.DDRB, bit(2));
    avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
    word(A.ICR1L, 8);
    word(A.OCR1BL, 8);
    avr.cpu.writeData(A.TCCR1A, bit(A.WGM11) | bit(A.COM1B1));
    avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.CS10)); // WGM10
    avr.runCycles(3);
    word(A.OCR1BL, 2);
    avr.runCycles(5);
    expect(avr.pin(10).read()).toBe(false);
    avr.runCycles(6);
    expect(avr.pin(10).read()).toBe(true);
  });

  for (const inverted of [false, true]) {
    test(`${timing}: Timer1 phase-correct compare above TOP preserves the ${inverted ? "inverted" : "normal"} output`, () => {
      const avr = A.AVR({ timing });
      const word = (addr: number, value: number) => {
        avr.cpu.writeData(addr + 1, value >> 8);
        avr.cpu.writeData(addr, value & 255);
      };
      avr.cpu.writeData(A.DDRB, bit(2));
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
      word(A.ICR1L, 8);
      word(A.OCR1BL, 10);
      avr.cpu.writeData(A.TCCR1A, bit(A.WGM11) | ((inverted ? 3 : 2) << 4));
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.CS10));
      avr.runCycles(16);
      const restored = A.AVR({ timing }).restore(avr.snapshot());
      expect(restored.pin(10).read()).toBe(!inverted);
      const edges: boolean[] = [];
      restored.pin(10).onChange(high => edges.push(high));
      restored.cpu.writeData(A.TIFR1, bit(A.OCF1B));
      restored.runCycles(32);
      expect(edges).toEqual([]);
      expect(restored.cpu.readData(A.TIFR1) & bit(A.OCF1B)).toBe(0);
    });
  }

  for (const mode of [14, 15]) {
    test(`${timing}: Timer1 WGM ${mode} TCNT at TOP blocks clearing until MAX wraps`, () => {
      const avr = A.AVR({ timing });
      const word = (addr: number, value: number) => {
        avr.cpu.writeData(addr + 1, value >> 8);
        avr.cpu.writeData(addr, value & 255);
      };
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
      word(A.ICR1L, 8);
      word(A.OCR1AL, 8);
      avr.cpu.writeData(A.TCCR1A, mode & 3);
      avr.cpu.writeData(A.TCCR1B, ((mode >> 2) << 3) | 1);
      word(A.TCNT1L, 8);
      const restored = A.AVR({ timing }).restore(avr.snapshot());
      restored.runCycles(1);
      expect(restored.cpu.readData(A.TCNT1L)).toBe(9);
      expect(restored.cpu.readData(A.TIFR1) & 1).toBe(0);
      restored.runCycles(65536 - 9);
      expect(restored.cpu.readData(A.TCNT1L)).toBe(0);
      restored.runCycles(9);
      expect(restored.cpu.readData(A.TCNT1L)).toBe(0);
      expect(restored.cpu.readData(A.TIFR1) & 1).toBe(1);
    });
  }

  test(`${timing}: Timer1 BOTTOM written on the falling slope misses BOTTOM until wrap`, () => {
    const avr = A.AVR({ timing });
    avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
    avr.cpu.writeData(A.ICR1H, 0);
    avr.cpu.writeData(A.ICR1L, 8);
    avr.cpu.writeData(A.TCCR1A, bit(A.WGM11));
    avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.CS10));
    avr.runCycles(8);
    avr.cpu.writeData(A.TCNT1H, 0);
    avr.cpu.writeData(A.TCNT1L, 0);
    const restored = A.AVR({ timing }).restore(avr.snapshot());
    restored.runCycles(1);
    expect(restored.cpu.readData(A.TCNT1L)).toBe(255);
    expect(restored.cpu.readData(A.TCNT1H)).toBe(255);
    expect(restored.cpu.readData(A.TIFR1) & 1).toBe(0);
    restored.runCycles(65535);
    expect(restored.cpu.readData(A.TCNT1L)).toBe(0);
    expect(restored.cpu.readData(A.TIFR1) & 1).toBe(1);
  });

  for (const mode of [9, 11, 12, 15]) {
    test(`${timing}: Timer1 WGM ${mode} raises its dedicated TOP flag at TOP`, () => {
      const avr = A.AVR({ timing });
      const word = (addr: number, value: number) => {
        avr.cpu.writeData(addr + 1, value >> 8);
        avr.cpu.writeData(addr, value & 255);
      };
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
      word(A.ICR1L, 8);
      word(A.OCR1AL, 8);
      avr.cpu.writeData(A.TCCR1A, mode & 3);
      avr.cpu.writeData(A.TCCR1B, ((mode >> 2) << 3) | 1);
      avr.runCycles(3);
      if (mode !== 12) word(A.OCR1AL, 4);
      const flag = bit(mode === 12 ? A.ICF1 : A.OCF1A);
      avr.runCycles(4);
      expect(avr.cpu.readData(A.TIFR1) & flag).toBe(0);
      avr.runCycles(1);
      expect(avr.cpu.readData(A.TIFR1) & flag).toBe(flag);
      const restored = A.AVR({ timing }).restore(avr.snapshot());
      restored.cpu.writeData(A.TIFR1, flag);
      restored.runCycles(1);
      expect(restored.cpu.readData(A.TIFR1) & flag).toBe(0);
    });
  }

  test(`${timing}: Timer1 control-only writes preserve prescaler phase`, () => {
    const avr = A.AVR({ timing });
    avr.cpu.writeData(A.TCCR1B, bit(A.CS11));
    avr.runCycles(3);
    avr.cpu.writeData(A.TCCR1B, bit(A.CS11) | bit(A.ICES1));
    const restored = A.AVR({ timing }).restore(avr.snapshot());
    restored.runCycles(5);
    expect(restored.cpu.readData(A.TCNT1L)).toBe(1);
  });

  test(`${timing}: quiet Timer1 CTC re-arms when a latched flag or mask changes`, () => {
    const avr = A.AVR({ timing });
    avr.cpu.writeData(A.OCR1AL, 8);
    avr.cpu.writeData(A.OCR1BL, 2);
    avr.cpu.writeData(A.TCCR1B, bit(A.WGM12) | 1);
    avr.runCycles(19); // both compare flags latched, TCNT=1.
    // Clear without reading TCNT first: this also settles the lazy counter.
    avr.cpu.writeData(A.TIFR1, bit(A.OCF1B));
    avr.runCycles(1);
    expect(avr.cpu.readData(A.TIFR1) & bit(A.OCF1B)).toBe(0);
    avr.runCycles(1);
    expect(avr.cpu.readData(A.TIFR1) & bit(A.OCF1B)).toBe(bit(A.OCF1B));
    avr.cpu.writeData(A.TIMSK1, bit(A.OCIE1B));
    avr.cpu.sreg.I = true;
    avr.step();
    expect(avr.cpu.pc).toBe(A.TIMER1_COMPB_VECTOR);
    expect(avr.cpu.readData(A.TIFR1) & bit(A.OCF1B)).toBe(0);
    avr.cpu.sreg.I = false;
    const left = 3 + ((9 - avr.cpu.readData(A.TCNT1L)) % 9);
    avr.runCycles(left);
    expect(avr.cpu.readData(A.TIFR1) & bit(A.OCF1B)).toBe(bit(A.OCF1B));
  });
}

test("asynchronous Timer2 distinguishes ASSR busy clear from the PWM transfer edge", () => {
  const avr = A.AVR();
  avr.cpu.writeData(A.OCR2A, 8);
  avr.cpu.writeData(A.OCR2B, 2);
  avr.cpu.writeData(A.TCCR2A, 3 | (2 << 4));
  avr.cpu.writeData(A.TCCR2B, bit(3) | 1);
  avr.cpu.writeData(A.ASSR, bit(A.AS2));
  const tick = 16_000_000 / 32768;
  avr.runCycles(Math.ceil(tick));
  avr.cpu.writeData(A.OCR2B, 6);
  expect(avr.cpu.readData(A.ASSR) & bit(A.OCR2BUB)).toBe(bit(A.OCR2BUB));
  const restored = A.AVR().restore(avr.snapshot());
  restored.runCycles(Math.round(tick));
  expect(restored.cpu.readData(A.ASSR) & bit(A.OCR2BUB)).toBe(0);
  expect(restored.pwm(3).read().value).toBe(2);
  restored.runCycles(Math.ceil(7 * tick));
  expect(restored.pwm(3).read().value).toBe(6);
});
