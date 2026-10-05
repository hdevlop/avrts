import { describe, expect, test } from "bun:test";
import * as A from "../src";

type Avr = ReturnType<typeof A.AVR>;
const bit = (n: number) => 1 << n;
const count = (avr: Avr) => avr.cpu.readData(A.TCNT2);
const sleep = (avr: Avr, mode = 3) => {
  avr.cpu.writeData(A.SMCR, (mode << 1) | 1);
  avr.cpu.sleep();
};
const wake = (avr: Avr, interrupts = false) => {
  avr.cpu.sreg.I = interrupts;
  avr.cpu.requestInterrupt(A.INT0_VECTOR);
  avr.cpu.tick();
  expect(avr.cpu.isSleeping).toBe(false);
  avr.cpu.clearInterrupt(A.INT0_VECTOR);
};
const runTo = (avr: Avr, cycle: number) => avr.runCycles(cycle - avr.cpu.cycles);

for (const timing of ["fast", "cycle-exact"] as const) {
  const make = (cs = 1) => {
    const avr = A.AVR({ timing, clockHz: 3_276_800 }); // 100 CPU cycles per TOSC edge.
    avr.cpu.writeData(A.TCNT2, 40);
    avr.cpu.writeData(A.TCCR2B, cs);
    avr.cpu.writeData(A.ASSR, bit(A.AS2));
    avr.runCycles(150);
    return avr;
  };
  describe(`${timing}: asynchronous Timer2 wake read synchronization`, () => {
    for (const interrupts of [false, true]) {
      test(`power-save retains the pre-sleep read until the next edge, I=${Number(interrupts)}`, () => {
        const avr = make();
        expect(count(avr)).toBe(41);
        sleep(avr);
        avr.runCycles(200);
        // Host inspection while asleep still synchronizes the running counter.
        expect(count(avr)).toBe(43);
        wake(avr, interrupts);
        expect(count(avr)).toBe(41);
        expect(avr.cpu.data[A.TCNT2]).toBe(43);
        runTo(avr, 399);
        expect(count(avr)).toBe(41);
        avr.runCycles(1);
        expect(count(avr)).toBe(44);
        runTo(avr, 500);
        expect(count(avr)).toBe(45);
      });

      test(`an edge during wake entry already refreshes the read, I=${Number(interrupts)}`, () => {
        const avr = make();
        sleep(avr);
        runTo(avr, 398); // Wake begins at 399, before the TOSC edge at 400.
        let wakeCycle = -1;
        avr.cpu.onWake((cycle) => { wakeCycle = cycle; });
        wake(avr, interrupts);
        expect(wakeCycle).toBe(399);
        expect(avr.cpu.cycles).toBe(interrupts ? 407 : 403);
        expect(count(avr)).toBe(44);
      });
    }

    test("wake on a source edge waits for the following source edge", () => {
      const avr = make();
      sleep(avr);
      runTo(avr, 399);
      wake(avr);
      expect(count(avr)).toBe(41);
      runTo(avr, 499);
      expect(count(avr)).toBe(41);
      avr.runCycles(1);
      expect(count(avr)).toBe(45);
    });

    for (const cs of [0, 2, 3, 4, 5, 6, 7]) {
      test(`read synchronization uses TOSC rather than the selected counter clock, CS=${cs}`, () => {
        const avr = make(cs);
        sleep(avr);
        avr.cpu.writeData(A.TCNT2, 90);
        avr.runCycles(200);
        expect(count(avr)).toBe(90);
        wake(avr);
        expect(count(avr)).toBe(40);
        runTo(avr, 399);
        expect(count(avr)).toBe(40);
        avr.runCycles(1);
        expect(count(avr)).toBe(90);
      });
    }

    for (const gate of ["PRR", "TSM", "PSRASY"] as const) {
      test(`${gate} does not postpone the wake read source edge`, () => {
        const avr = make();
        sleep(avr);
        avr.runCycles(200);
        wake(avr);
        if (gate === "PRR") avr.cpu.writeData(A.PRR, bit(A.PRTIM2));
        else avr.cpu.writeData(A.GTCCR, bit(A.PSRASY) | (gate === "TSM" ? bit(A.TSM) : 0));
        expect(count(avr)).toBe(41);
        runTo(avr, 400);
        expect(count(avr)).toBe(gate === "TSM" ? 43 : 44);
      });
    }

    for (const stage of ["asleep", "awake"] as const) {
      test(`snapshot while ${stage} retains the pre-sleep value and first-edge deadline`, () => {
        const avr = make();
        sleep(avr);
        avr.runCycles(200);
        if (stage === "awake") wake(avr);
        const snap = avr.snapshot();
        expect(snap.timer2.asyncSleepCounter).toBe(41);
        const restored = A.AVR().restore(snap);
        for (const chip of [avr, restored]) {
          if (stage === "asleep") wake(chip);
          expect(count(chip)).toBe(41);
          runTo(chip, 399);
          expect(count(chip)).toBe(41);
          chip.runCycles(1);
          expect(count(chip)).toBe(44);
        }
      });
    }

    for (const clock of ["host", "CLKPR"] as const) {
      for (const stage of ["asleep", "awake"] as const) {
        test(`${clock} change while ${stage} preserves latch and remaining source phase`, () => {
          const avr = make();
          sleep(avr);
          avr.runCycles(200);
          if (stage === "awake") wake(avr);
          if (clock === "host") avr.useClock(1_638_400);
          else {
            avr.cpu.writeData(A.CLKPR, bit(A.CLKPCE));
            avr.cpu.writeData(A.CLKPR, 1);
          }
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            if (stage === "asleep") wake(chip);
            expect(count(chip)).toBe(41);
            // Original next edge 400 is now 375 asleep, or 377.5 awake.
            const boundary = stage === "asleep" ? 375 : 378;
            runTo(chip, boundary - 1);
            expect(count(chip)).toBe(41);
            chip.runCycles(1);
            expect(count(chip)).toBe(44);
          }
        });
      }
    }

    for (const clockHz of [256_000, 16_000_000]) {
      test(`fractional ${clockHz} Hz source refreshes on the first rounded edge`, () => {
        const avr = A.AVR({ timing, clockHz });
        const period = clockHz / 32768;
        avr.cpu.writeData(A.TCNT2, 40);
        avr.cpu.writeData(A.TCCR2B, 1);
        avr.cpu.writeData(A.ASSR, bit(A.AS2));
        avr.runCycles(Math.ceil(1.5 * period));
        sleep(avr);
        runTo(avr, Math.floor(3 * period));
        wake(avr);
        expect(count(avr)).toBe(41);
        const restored = A.AVR().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          runTo(chip, Math.ceil(4 * period) - 1);
          expect(count(chip)).toBe(41);
          chip.runCycles(1);
          expect(count(chip)).toBe(44);
        }
      });
    }

    test("a TCNT2 transfer on the refresh edge exposes its destination", () => {
      const avr = make();
      sleep(avr);
      runTo(avr, 250);
      avr.cpu.writeData(A.TCNT2, 90); // Transfers at edge 400.
      runTo(avr, 350);
      wake(avr);
      expect(count(avr)).toBe(41);
      expect(avr.cpu.readData(A.ASSR) & bit(A.TCN2UB)).toBe(bit(A.TCN2UB));
      runTo(avr, 400);
      expect(count(avr)).toBe(90);
      expect(avr.cpu.readData(A.ASSR) & bit(A.TCN2UB)).toBe(0);
    });

    test("firmware's documented busy-wait procedure returns the current counter", () => {
      const avr = make();
      sleep(avr);
      avr.runCycles(200);
      wake(avr);
      expect(count(avr)).toBe(41);
      avr.cpu.writeData(A.OCR2B, 120);
      runTo(avr, 500);
      expect(avr.cpu.readData(A.ASSR) & bit(A.OCR2BUB)).toBe(0);
      expect(count(avr)).toBe(45);
    });

    test("LDS in a Timer2 compare ISR reads the latch while counting and OC2B continue", () => {
      const avr = make();
      avr.cpu.writeData(A.DDRD, bit(3));
      avr.cpu.writeData(A.OCR2A, 43);
      avr.cpu.writeData(A.OCR2B, 44);
      avr.cpu.writeData(A.TCCR2A, bit(A.COM2B0));
      // Finish these async transfers before sleep, at cycle 300.
      runTo(avr, 300);
      expect(count(avr)).toBe(43);
      avr.cpu.flash[A.TIMER2_COMPA_VECTOR] = 0x9100; // LDS r16, TCNT2.
      avr.cpu.flash[A.TIMER2_COMPA_VECTOR + 1] = A.TCNT2;
      avr.cpu.flash[A.TIMER2_COMPA_VECTOR + 2] = 0xcfff; // RJMP .
      avr.cpu.writeData(A.TIMSK2, bit(A.OCIE2A));
      avr.cpu.sreg.I = true;
      sleep(avr);
      avr.runCycles(100);
      expect(avr.cpu.isSleeping).toBe(false);
      expect(avr.cpu.pc).toBe(A.TIMER2_COMPA_VECTOR);
      avr.cpu.tick();
      expect(avr.cpu.data[16]).toBe(43);
      expect(avr.cpu.data[A.TCNT2]).toBe(44);
      expect(avr.pin(3).read()).toBe(true);
      runTo(avr, 500);
      expect(count(avr)).toBe(45);
      expect(avr.cpu.readData(A.TIFR2) & bit(A.OCF2B)).toBe(bit(A.OCF2B));
    });

    test("re-entering power-save before refresh retains the CPU-visible latch", () => {
      const avr = make();
      sleep(avr);
      avr.runCycles(200);
      wake(avr);
      sleep(avr);
      runTo(avr, 450);
      const restored = A.AVR().restore(avr.snapshot());
      wake(restored);
      expect(count(restored)).toBe(41);
      runTo(restored, 500);
      expect(count(restored)).toBe(45);
    });

    test("an expired window cannot be resurrected by restore or a later sleep", () => {
      const avr = make();
      sleep(avr);
      avr.runCycles(200);
      wake(avr);
      runTo(avr, 450); // No TCNT2 read before snapshot clears the saved window.
      const snap = avr.snapshot();
      expect(snap.timer2.asyncSleepCounter).toBeUndefined();
      const restored = A.AVR().restore(snap);
      expect(count(restored)).toBe(44);
      sleep(restored);
      runTo(restored, 650);
      wake(restored);
      expect(count(restored)).toBe(44);
      runTo(restored, 700);
      expect(count(restored)).toBe(47);
    });

    test("an AS2 switch clears the wake read latch", () => {
      const avr = make();
      sleep(avr);
      avr.runCycles(200);
      wake(avr);
      expect(count(avr)).toBe(41);
      avr.cpu.writeData(A.ASSR, 0);
      expect(count(avr)).toBe(43);
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      expect(count(avr)).toBe(43);
    });

    for (const reset of ["reset", "resetExternal", "resetBrownOut"] as const) {
      test(`${reset} clears the wake read latch`, () => {
        const avr = make();
        sleep(avr);
        avr.runCycles(200);
        wake(avr);
        expect(count(avr)).toBe(41);
        avr[reset]();
        expect(count(avr)).toBe(0);
        avr.cpu.writeData(A.TCNT2, 70);
        expect(count(avr)).toBe(70);
      });
    }

    for (const mode of [0, 1, 2, 6, 7]) {
      test(`sleep mode ${mode} retains its existing read behavior`, () => {
        const avr = make();
        sleep(avr, mode);
        avr.runCycles(200);
        wake(avr);
        expect(count(avr)).toBe([0, 1, 7].includes(mode) ? 43 : 41);
      });
    }

    test("legacy sleeping snapshots cannot reconstruct an unrecorded read latch", () => {
      const avr = make();
      sleep(avr);
      avr.runCycles(200);
      const snap = avr.snapshot();
      delete snap.timer2.asyncSleepCounter;
      delete snap.timer2.asyncWakeReadRemaining;
      const restored = A.AVR().restore(snap);
      wake(restored);
      expect(count(restored)).toBe(43);
    });

    test("synchronous power-save does not introduce an async read window", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.TCNT2, 40);
      sleep(avr);
      avr.runCycles(200);
      wake(avr);
      avr.cpu.writeData(A.TCNT2, 70);
      expect(count(avr)).toBe(70);
    });
  });
}
