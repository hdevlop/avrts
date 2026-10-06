import { describe, expect, test } from "bun:test";
import * as A from "../src";

type Avr = ReturnType<typeof A.AVR>;
const count0 = (avr: Avr) => avr.cpu.readData(A.TCNT0);
const count1 = (avr: Avr) => avr.cpu.readData(A.TCNT1L) | (avr.cpu.readData(A.TCNT1H) << 8);
const counts = (avr: Avr) => [count0(avr), count1(avr)] as const;
const taps = [[2, 8], [3, 64], [4, 256], [5, 1024]] as const;

for (const timing of ["fast", "cycle-exact"] as const) {
  const make = () => A.AVR({ timing });
  describe(`${timing}: shared Timer0/1 prescaler`, () => {
    for (const [cs, divisor] of taps) {
      for (const timer of [0, 1]) {
        const control = timer === 0 ? A.TCCR0B : A.TCCR1B;
        const read = timer === 0 ? count0 : count1;
        test(`Timer${timer} starts on the existing /${divisor} tap`, () => {
          const avr = make();
          avr.runCycles(divisor - 3);
          avr.cpu.writeData(control, cs);
          avr.runCycles(2);
          expect(read(avr)).toBe(0);
          avr.runCycles(1);
          expect(read(avr)).toBe(1);
        });

        test(`Timer${timer} retains the /${divisor} divider through stop/restore/start`, () => {
          const avr = make();
          avr.cpu.writeData(control, cs);
          avr.runCycles(divisor + 1);
          avr.cpu.writeData(control, 0);
          avr.runCycles(divisor - 3);
          const restored = make().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            expect(read(chip)).toBe(1);
            chip.cpu.writeData(control, cs);
            chip.runCycles(1);
            expect(read(chip)).toBe(1);
            chip.runCycles(1);
            expect(read(chip)).toBe(2);
          }
        });
      }

      test(`staggered /${divisor} starts share clock edges`, () => {
        const avr = make();
        avr.cpu.writeData(A.TCCR0B, cs);
        avr.runCycles(divisor - 2);
        avr.cpu.writeData(A.TCCR1B, cs);
        avr.runCycles(1);
        expect(counts(avr)).toEqual([0, 0]);
        avr.runCycles(1);
        expect(counts(avr)).toEqual([1, 1]);
        const restored = make().restore(avr.snapshot());
        restored.runCycles(divisor);
        expect(counts(restored)).toEqual([2, 2]);
      });
    }

    test("switching /8 to /64 and back selects taps without resetting the divider", () => {
      const avr = make();
      avr.cpu.writeData(A.TCCR0B, 2);
      avr.cpu.writeData(A.TCCR1B, 3);
      avr.runCycles(61);
      expect(counts(avr)).toEqual([7, 0]);
      avr.cpu.writeData(A.TCCR0B, 3);
      const restored = make().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.runCycles(2);
        expect(counts(chip)).toEqual([7, 0]);
        chip.runCycles(1);
        expect(counts(chip)).toEqual([8, 1]);
        chip.runCycles(3);
        chip.cpu.writeData(A.TCCR0B, 2);
        chip.cpu.writeData(A.TCCR1B, 2);
        chip.runCycles(4);
        expect(counts(chip)).toEqual([8, 1]);
        chip.runCycles(1);
        expect(counts(chip)).toEqual([9, 2]);
      }
    });

    test("direct /1 counting still advances the phase of higher divider taps", () => {
      const avr = make();
      avr.cpu.writeData(A.TCCR0B, 1);
      avr.runCycles(63);
      avr.cpu.writeData(A.TCCR0B, 3);
      avr.cpu.writeData(A.TCCR1B, 3);
      avr.runCycles(1);
      expect(counts(avr)).toEqual([64, 1]);
    });

    for (const running of [false, true]) {
      test(`PSRSYNC resets both taps while counters are ${running ? "running" : "stopped"}`, () => {
        const avr = make();
        if (running) {
          avr.cpu.writeData(A.TCCR0B, 2);
          avr.cpu.writeData(A.TCCR1B, 3);
        }
        avr.runCycles(61);
        const before = counts(avr);
        avr.cpu.writeData(A.GTCCR, 1 << A.PSRSYNC);
        expect(avr.cpu.readData(A.GTCCR)).toBe(0);
        expect(counts(avr)).toEqual(before);
        avr.cpu.writeData(A.TCCR0B, 2);
        avr.cpu.writeData(A.TCCR1B, 3);
        avr.runCycles(7);
        expect(counts(avr)).toEqual(before);
        avr.runCycles(1);
        expect(counts(avr)).toEqual([before[0]! + 1, before[1]]);
        avr.runCycles(55);
        expect(count1(avr)).toBe(before[1]!);
        avr.runCycles(1);
        expect(counts(avr)).toEqual([before[0]! + 8, before[1]! + 1]);
      });
    }

    test("TSM hold and restore release both timers from phase zero", () => {
      const avr = make();
      avr.cpu.writeData(A.TCCR0B, 2);
      avr.runCycles(5);
      avr.cpu.writeData(A.GTCCR, (1 << A.TSM) | (1 << A.PSRSYNC));
      avr.cpu.writeData(A.TCCR1B, 2);
      avr.runCycles(107);
      const restored = make().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.cpu.writeData(A.GTCCR, 0);
        chip.runCycles(7);
        expect(counts(chip)).toEqual([0, 0]);
        chip.runCycles(1);
        expect(counts(chip)).toEqual([1, 1]);
      }
    });

    for (const mode of [0, 1, 2, 3, 6, 7]) {
      test(`sleep mode ${mode} ${mode === 0 ? "runs" : "pauses"} the common divider even with counters stopped`, () => {
        const avr = make();
        avr.runCycles(5);
        avr.cpu.writeData(A.SMCR, (mode << 1) | 1);
        avr.cpu.sleep();
        avr.runCycles(11);
        const restored = make().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          chip.cpu.sreg.I = true;
          chip.cpu.requestInterrupt(A.INT0_VECTOR);
          chip.cpu.tick();
          expect(chip.cpu.isSleeping).toBe(false);
          chip.cpu.writeData(A.TCCR0B, 2);
          chip.cpu.writeData(A.TCCR1B, 2);
          // Idle includes wake/interrupt cycles in the free-running divider.
          // Deeper sleep resumes phase five plus eight wake/dispatch clocks.
          chip.runCycles(mode === 0 ? 6 : 2);
          expect(counts(chip)).toEqual([0, 0]);
          chip.runCycles(1);
          expect(counts(chip)).toEqual([1, 1]);
        }
      });
    }

    for (const timer of [0, 1]) {
      test(`PRR gates Timer${timer}'s counter while the sibling keeps the shared divider running`, () => {
        const avr = make();
        avr.cpu.writeData(A.TCCR0B, 2);
        avr.cpu.writeData(A.TCCR1B, 2);
        avr.runCycles(3);
        avr.cpu.writeData(A.PRR, 1 << (timer === 0 ? A.PRTIM0 : A.PRTIM1));
        avr.runCycles(12);
        const restored = make().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          expect(counts(chip)).toEqual(timer === 0 ? [0, 1] : [1, 0]);
          chip.cpu.writeData(A.PRR, 0);
          chip.runCycles(1);
          expect(counts(chip)).toEqual(timer === 0 ? [1, 2] : [2, 1]);
        }
      });
    }

    test("PSRASY does not reset the synchronous divider", () => {
      const avr = make();
      avr.runCycles(7);
      avr.cpu.writeData(A.GTCCR, 1 << A.PSRASY);
      avr.cpu.writeData(A.TCCR0B, 2);
      avr.cpu.writeData(A.TCCR1B, 2);
      avr.runCycles(1);
      expect(counts(avr)).toEqual([1, 1]);
    });

    for (const cs of [0, 1, 2]) {
      test(`restore retains the full divider while Timer0 uses CS=${cs}`, () => {
        const avr = make();
        avr.cpu.writeData(A.TCCR0B, cs);
        avr.runCycles(61);
        const restored = make().restore(avr.snapshot());
        const before = counts(restored);
        restored.cpu.writeData(A.TCCR0B, 3);
        restored.cpu.writeData(A.TCCR1B, 3);
        restored.runCycles(2);
        expect(counts(restored)).toEqual(before);
        restored.runCycles(1);
        expect(counts(restored)).toEqual([before[0] + 1, before[1] + 1]);
      });
    }

    test("legacy snapshots retain each running timer's next edge", () => {
      const avr = make();
      avr.cpu.writeData(A.TCCR1B, 3);
      avr.runCycles(3);
      const snap = avr.snapshot();
      delete snap.timerPrescaler;
      const restored = make().restore(snap);
      restored.runCycles(60);
      expect(count1(restored)).toBe(0);
      restored.runCycles(1);
      expect(count1(restored)).toBe(1);
    });

    test("divider phase wraps across multiple 1024-cycle periods", () => {
      const avr = make();
      avr.runCycles(2 * 1024 + 61);
      avr.cpu.writeData(A.TCCR0B, 3);
      avr.cpu.writeData(A.TCCR1B, 3);
      avr.runCycles(2);
      expect(counts(avr)).toEqual([0, 0]);
      avr.runCycles(1);
      expect(counts(avr)).toEqual([1, 1]);
    });

    test("TSM without PSRSYNC leaves the shared divider running", () => {
      const avr = make();
      avr.runCycles(5);
      avr.cpu.writeData(A.GTCCR, 1 << A.TSM);
      avr.cpu.writeData(A.TCCR0B, 2);
      avr.cpu.writeData(A.TCCR1B, 2);
      avr.runCycles(3);
      expect(counts(avr)).toEqual([1, 1]);
    });

    test("compare flags use aligned timer-clock edges without counter reads", () => {
      const avr = make();
      avr.cpu.writeData(A.OCR0A, 2);
      avr.cpu.writeData(A.OCR1AH, 0);
      avr.cpu.writeData(A.OCR1AL, 2);
      avr.cpu.writeData(A.TIMSK0, 1 << A.OCIE0A);
      avr.cpu.writeData(A.TIMSK1, 1 << A.OCIE1A);
      avr.runCycles(5);
      avr.cpu.writeData(A.TCCR0B, 2);
      avr.runCycles(2);
      avr.cpu.writeData(A.TCCR1B, 2);
      avr.runCycles(16);
      expect(avr.cpu.readData(A.TIFR0) & (1 << A.OCF0A)).toBe(0);
      expect(avr.cpu.readData(A.TIFR1) & (1 << A.OCF1A)).toBe(0);
      avr.runCycles(1);
      expect(avr.cpu.readData(A.TIFR0) & (1 << A.OCF0A)).toBe(1 << A.OCF0A);
      expect(avr.cpu.readData(A.TIFR1) & (1 << A.OCF1A)).toBe(1 << A.OCF1A);
    });

    for (const reset of ["reset", "resetExternal", "resetBrownOut"] as const) {
      test(`${reset} clears sleep/hold and starts the divider at phase zero`, () => {
        const avr = make();
        avr.runCycles(5);
        avr.cpu.writeData(A.GTCCR, (1 << A.TSM) | (1 << A.PSRSYNC));
        avr.cpu.writeData(A.SMCR, (2 << 1) | 1);
        avr.cpu.sleep();
        avr.runCycles(11);
        avr[reset]();
        avr.cpu.writeData(A.TCCR0B, 2);
        avr.cpu.writeData(A.TCCR1B, 2);
        avr.runCycles(7);
        expect(counts(avr)).toEqual([0, 0]);
        avr.runCycles(1);
        expect(counts(avr)).toEqual([1, 1]);
      });
    }
  });
}

for (const timer of [0, 1]) {
  test(`standalone Timer${timer} explicit ticking retains divider phase across CS and restore`, () => {
    const cpu = new A.CPU();
    const peripheral = timer === 0 ? new A.Timer0(cpu) : new A.Timer1(cpu);
    A.attachPeripheral(cpu, peripheral);
    const control = timer === 0 ? A.TCCR0B : A.TCCR1B;
    const count = () => timer === 0 ? cpu.readData(A.TCNT0) : cpu.readData(A.TCNT1L);
    peripheral.tick(61); // Counters stopped; the divider still runs.
    cpu.writeData(control, 2);
    peripheral.tick(2);
    expect(count()).toBe(0);
    if (peripheral instanceof A.Timer0) peripheral.restore(peripheral.snapshot());
    else peripheral.restore(peripheral.snapshot());
    cpu.writeData(control, 3);
    peripheral.tick(1);
    expect(count()).toBe(1);
  });
}
