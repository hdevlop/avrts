import { describe, expect, test } from "bun:test";
import * as A from "../src";

type Avr = ReturnType<typeof A.AVR>;
const count = (avr: Avr) => avr.cpu.readData(A.TCNT2);
const taps = [[2, 8], [3, 32], [4, 64], [5, 128], [6, 256], [7, 1024]] as const;
const bit = (n: number) => 1 << n;

for (const timing of ["fast", "cycle-exact"] as const) {
  for (const asynchronous of [false, true]) {
    const period = asynchronous ? 10 : 1;
    const make = () => {
      const avr = A.AVR({ timing, clockHz: 327_680 });
      if (asynchronous) avr.cpu.writeData(A.ASSR, bit(A.AS2));
      return avr;
    };
    describe(`${timing}: ${asynchronous ? "TOSC" : "CPU"} Timer2 divider phase`, () => {
      for (const [cs, divisor] of taps) {
        test(`/ ${divisor} starts on the existing divider tap after CS transfer`, () => {
          const avr = make();
          const boundary = divisor * period;
          // Async CS transfers at the penultimate source edge.
          avr.runCycles(boundary - (asynchronous ? 3 * period : 3));
          avr.cpu.writeData(A.TCCR2B, cs);
          avr.runCycles(asynchronous ? 2 * period : 1);
          expect(count(avr)).toBe(0);
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            chip.runCycles(asynchronous ? period - 1 : 1);
            expect(count(chip)).toBe(0);
            chip.runCycles(1);
            expect(count(chip)).toBe(1);
          }
        });

        test(`/ ${divisor} keeps its phase through stop, restore and restart`, () => {
          const avr = make();
          avr.cpu.writeData(A.TCCR2B, cs);
          avr.runCycles(divisor * period + 1);
          expect(count(avr)).toBe(1);
          avr.cpu.writeData(A.TCCR2B, 0);
          avr.runCycles((divisor - 3) * period - 1);
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            chip.cpu.writeData(A.TCCR2B, cs);
            chip.runCycles(3 * period - 1);
            expect(count(chip)).toBe(1);
            chip.runCycles(1);
            expect(count(chip)).toBe(2);
          }
        });
      }

      test("changing /8 to /32 retains the upper divider bits", () => {
        const avr = make();
        avr.cpu.writeData(A.TCCR2B, 2);
        avr.runCycles((asynchronous ? 29 : 31) * period);
        expect(count(avr)).toBe(3);
        avr.cpu.writeData(A.TCCR2B, 3);
        const restored = A.AVR().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          chip.runCycles((asynchronous ? 3 : 1) * period - 1);
          expect(count(chip)).toBe(3);
          chip.runCycles(1);
          expect(count(chip)).toBe(4);
        }
      });

      test("restored /1 uses the full phase when switching to /32", () => {
        const avr = make();
        avr.cpu.writeData(A.TCCR2B, 1);
        avr.runCycles((asynchronous ? 29 : 31) * period);
        const before = count(avr);
        const restored = A.AVR().restore(avr.snapshot());
        restored.cpu.writeData(A.TCCR2B, 3);
        // /1 continues counting during the async CS transfer.
        const transferred = before + (asynchronous ? 2 : 0);
        restored.runCycles((asynchronous ? 3 : 1) * period - 1);
        expect(count(restored)).toBe(transferred);
        restored.runCycles(1);
        expect(count(restored)).toBe(transferred + 1);
      });

      test("PSRSYNC does not reset Timer2's independent divider", () => {
        const avr = make();
        avr.cpu.writeData(A.TCCR2B, 2);
        avr.runCycles(7 * period);
        avr.cpu.writeData(A.GTCCR, bit(A.PSRSYNC));
        avr.runCycles(period);
        expect(count(avr)).toBe(1);
      });

      test("TSM hold restores phase zero without stopping oscillator transfers", () => {
        const avr = make();
        avr.cpu.writeData(A.TCCR2B, 2);
        avr.runCycles(5 * period);
        avr.cpu.writeData(A.GTCCR, bit(A.TSM) | bit(A.PSRASY));
        avr.runCycles(12 * period);
        const restored = A.AVR().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          chip.cpu.writeData(A.GTCCR, 0);
          chip.runCycles(8 * period - 1);
          expect(count(chip)).toBe(0);
          chip.runCycles(1);
          expect(count(chip)).toBe(1);
        }
      });

      test("divider phase wraps while the counter is stopped", () => {
        const avr = make();
        avr.runCycles((2 * 1024 + (asynchronous ? 29 : 31)) * period);
        avr.cpu.writeData(A.TCCR2B, 3);
        avr.runCycles((asynchronous ? 3 : 1) * period);
        expect(count(avr)).toBe(1);
      });

      test("changing /32 back to /8 preserves the selected lower tap", () => {
        const avr = make();
        avr.cpu.writeData(A.TCCR2B, 3);
        avr.runCycles((asynchronous ? 37 : 39) * period);
        expect(count(avr)).toBe(1);
        avr.cpu.writeData(A.TCCR2B, 2);
        avr.runCycles((asynchronous ? 3 : 1) * period - 1);
        expect(count(avr)).toBe(1);
        avr.runCycles(1);
        expect(count(avr)).toBe(2);
      });

      for (const running of [false, true]) {
        test(`PSRASY resets the divider while CS is ${running ? "running" : "stopped"}`, () => {
          const avr = make();
          if (running) avr.cpu.writeData(A.TCCR2B, 2);
          avr.runCycles(5 * period);
          avr.cpu.writeData(A.GTCCR, bit(A.PSRASY));
          avr.cpu.writeData(A.TCCR2B, 2);
          avr.runCycles(8 * period - 1);
          expect(count(avr)).toBe(0);
          avr.runCycles(1);
          expect(count(avr)).toBe(1);
        });
      }

      test("compare flags are scheduled on divider edges without counter reads", () => {
        const avr = make();
        avr.cpu.writeData(A.OCR2A, 2);
        avr.cpu.writeData(A.TIMSK2, bit(A.OCIE2A));
        avr.runCycles(5 * period);
        avr.cpu.writeData(A.TCCR2B, 2);
        avr.runCycles(19 * period - 1);
        expect(avr.cpu.readData(A.TIFR2) & bit(A.OCF2A)).toBe(0);
        avr.runCycles(1);
        expect(avr.cpu.readData(A.TIFR2) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
        expect(avr.cpu.snapshot().pendingInterrupts).toContain(A.TIMER2_COMPA_VECTOR);
      });
    });
  }

  test(`${timing}: synchronous PRR pauses the independent divider even while CS is zero`, () => {
    const avr = A.AVR({ timing });
    avr.runCycles(5);
    avr.cpu.writeData(A.PRR, bit(A.PRTIM2));
    avr.runCycles(11);
    const restored = A.AVR().restore(avr.snapshot());
    for (const chip of [avr, restored]) {
      chip.cpu.writeData(A.PRR, 0);
      chip.cpu.writeData(A.TCCR2B, 2);
      chip.runCycles(2);
      expect(count(chip)).toBe(0);
      chip.runCycles(1);
      expect(count(chip)).toBe(1);
    }
  });

  test(`${timing}: PRR leaves asynchronous counting and divider phase running`, () => {
    const avr = A.AVR({ timing, clockHz: 327_680 });
    avr.cpu.writeData(A.ASSR, bit(A.AS2));
    avr.cpu.writeData(A.TCCR2B, 2);
    avr.runCycles(30);
    avr.cpu.writeData(A.PRR, bit(A.PRTIM2));
    avr.runCycles(50);
    expect(count(avr)).toBe(1);
    const restored = A.AVR().restore(avr.snapshot());
    restored.runCycles(80);
    expect(count(restored)).toBe(2);
  });

  for (const reset of [false, true]) {
    test(`${timing}: off-edge async ${reset ? "PSRASY" : "TSM release"} retains TOSC edge alignment`, () => {
      const avr = A.AVR({ timing, clockHz: 327_680 });
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.cpu.writeData(A.TCCR2B, 2);
      avr.runCycles(25);
      if (reset) avr.cpu.writeData(A.GTCCR, bit(A.PSRASY));
      else {
        avr.cpu.writeData(A.GTCCR, bit(A.TSM) | bit(A.PSRASY));
        avr.runCycles(80);
        avr.cpu.writeData(A.GTCCR, 0);
      }
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.runCycles(74);
        expect(count(chip)).toBe(0);
        chip.runCycles(1);
        expect(count(chip)).toBe(1);
      }
    });
  }

  for (const clockHz of [256_000, 16_000_000]) {
    test(`${timing}: fractional source at ${clockHz} Hz retains divider phase through restore`, () => {
      const avr = A.AVR({ timing, clockHz });
      const period = clockHz / 32768;
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.runCycles(Math.ceil(29 * period));
      avr.cpu.writeData(A.TCCR2B, 3);
      const restored = A.AVR().restore(avr.snapshot());
      restored.runCycles(Math.ceil(32 * period) - restored.cpu.cycles - 1);
      expect(count(restored)).toBe(0);
      restored.runCycles(1);
      expect(count(restored)).toBe(1);
    });
  }

  for (const running of [false, true]) {
    test(`${timing}: CLKPR scales the full divider and pending CS while ${running ? "running" : "stopped"}`, () => {
      const avr = A.AVR({ timing, clockHz: 327_680 });
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      if (running) avr.cpu.writeData(A.TCCR2B, 2);
      avr.runCycles(running ? 35 : 295);
      if (!running) avr.cpu.writeData(A.TCCR2B, 3);
      avr.cpu.writeData(A.CLKPR, bit(A.CLKPCE));
      avr.cpu.writeData(A.CLKPR, 1);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.runCycles(running ? 22 : 12);
        expect(count(chip)).toBe(0);
        chip.runCycles(1);
        expect(count(chip)).toBe(1);
      }
    });
  }

  for (const asynchronous of [false, true]) {
    for (const mode of [0, 1, 2, 3, 6, 7]) {
      const runs = mode === 0 || (asynchronous && [1, 3, 7].includes(mode));
      test(`${timing}: ${asynchronous ? "TOSC" : "CPU"} divider ${runs ? "runs" : "pauses"} in sleep ${mode}`, () => {
        const avr = A.AVR({ timing, clockHz: 327_680 });
        const period = asynchronous ? 10 : 1;
        if (asynchronous) avr.cpu.writeData(A.ASSR, bit(A.AS2));
        avr.cpu.writeData(A.TCCR2B, 2);
        avr.runCycles(5 * period);
        avr.cpu.writeData(A.SMCR, (mode << 1) | 1);
        avr.cpu.sleep();
        avr.runCycles(2 * period);
        const restored = A.AVR().restore(avr.snapshot());
        restored.runCycles(period - 1);
        expect(count(restored)).toBe(0);
        restored.runCycles(1);
        expect(count(restored)).toBe(runs ? 1 : 0);
        if (!runs) {
          restored.cpu.sreg.I = true;
          restored.cpu.requestInterrupt(A.INT0_VECTOR);
          restored.cpu.tick();
          restored.runCycles(3 * period - 1);
          expect(count(restored)).toBe(0);
          restored.runCycles(1);
          expect(count(restored)).toBe(1);
        }
      });
    }
  }

  test(`${timing}: switching AS2 bypasses PRR and returning to sync reapplies the gate`, () => {
    const avr = A.AVR({ timing, clockHz: 327_680 });
    avr.cpu.writeData(A.TCCR2B, 2);
    avr.runCycles(3);
    avr.cpu.writeData(A.PRR, bit(A.PRTIM2));
    avr.runCycles(11);
    avr.cpu.writeData(A.ASSR, bit(A.AS2));
    avr.runCycles(80);
    expect(count(avr)).toBe(1);
    avr.cpu.writeData(A.ASSR, 0);
    avr.runCycles(11);
    expect(count(avr)).toBe(1);
    avr.cpu.writeData(A.PRR, 0);
    avr.runCycles(7);
    expect(count(avr)).toBe(1);
    avr.runCycles(1);
    expect(count(avr)).toBe(2);
  });

  test(`${timing}: legacy snapshots preserve the current tap's next edge`, () => {
    const avr = A.AVR({ timing });
    avr.cpu.writeData(A.TCCR2B, 3);
    avr.runCycles(29);
    const snap = avr.snapshot();
    delete snap.timer2.dividerPhase;
    const restored = A.AVR().restore(snap);
    restored.runCycles(2);
    expect(count(restored)).toBe(0);
    restored.runCycles(1);
    expect(count(restored)).toBe(1);
  });

  test(`${timing}: frozen async divider rescales through CLKPR and restore before wake`, () => {
    const avr = A.AVR({ timing, clockHz: 327_680 });
    avr.cpu.writeData(A.ASSR, bit(A.AS2));
    avr.cpu.writeData(A.TCCR2B, 2);
    avr.runCycles(35);
    avr.cpu.writeData(A.SMCR, (2 << 1) | 1);
    avr.cpu.sleep();
    avr.runCycles(100);
    avr.cpu.writeData(A.CLKPR, bit(A.CLKPCE));
    avr.cpu.writeData(A.CLKPR, 1);
    const restored = A.AVR().restore(avr.snapshot());
    restored.cpu.sreg.I = true;
    restored.cpu.requestInterrupt(A.INT0_VECTOR);
    restored.cpu.tick();
    restored.runCycles(22);
    expect(count(restored)).toBe(0);
    restored.runCycles(1);
    expect(count(restored)).toBe(1);
  });

  for (const reset of ["reset", "resetExternal", "resetBrownOut"] as const) {
    test(`${timing}: ${reset} clears divider hold and clock gates`, () => {
      const avr = A.AVR({ timing });
      avr.runCycles(5);
      avr.cpu.writeData(A.GTCCR, bit(A.TSM) | bit(A.PSRASY));
      avr.cpu.writeData(A.PRR, bit(A.PRTIM2));
      avr[reset]();
      avr.cpu.writeData(A.TCCR2B, 2);
      avr.runCycles(7);
      expect(count(avr)).toBe(0);
      avr.runCycles(1);
      expect(count(avr)).toBe(1);
    });
  }
}

test("standalone Timer2 ticking while stopped retains the full divider through restore", () => {
  const cpu = new A.CPU();
  const timer = new A.Timer2(cpu);
  A.attachPeripheral(cpu, timer);
  timer.tick(31);
  timer.restore(timer.snapshot());
  cpu.writeData(A.TCCR2B, 3);
  timer.tick(1);
  expect(cpu.readData(A.TCNT2)).toBe(1);
});
