import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as A from "../src";

type Avr = ReturnType<typeof A.AVR>;
const bit = (n: number) => 1 << n;
const flags = (avr: Avr) => avr.cpu.readData(A.TIFR2);
const runTo = (avr: Avr, cycle: number) => avr.runCycles(cycle - avr.cpu.cycles);
const sleep = (avr: Avr, mode: number) => {
  avr.cpu.writeData(A.SMCR, (mode << 1) | 1);
  avr.cpu.sleep();
};

for (const timing of ["fast", "cycle-exact"] as const) {
  const make = (cs = 1, counter = 0, compareOutput = false) => {
    const avr = A.AVR({ timing, clockHz: 1_638_400 }); // 50 CPU cycles per TOSC.
    avr.cpu.writeData(A.TCNT2, counter);
    avr.cpu.writeData(A.OCR2A, 2);
    avr.cpu.writeData(A.OCR2B, 3);
    if (compareOutput) avr.cpu.writeData(A.TCCR2A, bit(A.COM2A0));
    avr.cpu.writeData(A.TCCR2B, cs);
    avr.cpu.writeData(A.ASSR, bit(A.AS2));
    return avr;
  };
  describe(`${timing}: Timer2 asynchronous flag and wake stages`, () => {
    for (const [cs, divisor] of [[1, 1], [2, 8], [3, 32], [4, 64], [5, 128], [6, 256], [7, 1024]] as const) {
      test(`/ ${divisor} compare output precedes its CPU flag by one timer clock and three CPU clocks`, () => {
        const avr = make(cs, 0, true);
        avr.cpu.writeData(A.DDRB, bit(3));
        avr.cpu.writeData(A.TIMSK2, bit(A.OCIE2A));
        runTo(avr, 2 * divisor * 50);
        expect(avr.pin(11).read()).toBe(true);
        expect(flags(avr) & bit(A.OCF2A)).toBe(0);
        runTo(avr, 3 * divisor * 50 + 2);
        expect(flags(avr) & bit(A.OCF2A)).toBe(0);
        expect(avr.cpu.snapshot().pendingInterrupts).not.toContain(A.TIMER2_COMPA_VECTOR);
        avr.runCycles(1);
        expect(flags(avr) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
        expect(avr.cpu.snapshot().pendingInterrupts).toContain(A.TIMER2_COMPA_VECTOR);
        expect(avr.cpu.readData(A.TCNT2)).toBe(3);
      });
    }

    for (const interrupts of [false, true]) {
      for (const mode of [1, 3, 7]) {
        test(`sleep ${mode} wakes on the next timer clock and synchronizes flags during startup, I=${Number(interrupts)}`, () => {
          const avr = make();
          avr.cpu.writeData(A.TIMSK2, bit(A.OCIE2A));
          avr.cpu.sreg.I = interrupts;
          avr.runCycles(75);
          sleep(avr, mode);
          let wakeCycle = -1;
          avr.cpu.onWake((cycle) => { wakeCycle = cycle; });
          runTo(avr, 149);
          expect(avr.cpu.isSleeping).toBe(true);
          expect(flags(avr) & bit(A.OCF2A)).toBe(0);
          avr.runCycles(1);
          expect(wakeCycle).toBe(150);
          expect(avr.cpu.cycles).toBe(interrupts ? 158 : 154);
          expect(avr.cpu.isSleeping).toBe(false);
          expect(avr.cpu.data[A.TCNT2]).toBe(3);
          expect(avr.cpu.readData(A.TCNT2)).toBe(mode === 3 ? 1 : 3);
          expect(flags(avr) & bit(A.OCF2A)).toBe(interrupts ? 0 : bit(A.OCF2A));
          expect(avr.cpu.pc).toBe(interrupts ? A.TIMER2_COMPA_VECTOR : 75);
        });
      }
    }

    test("overflow is staged at the following timer clock before its three CPU clocks", () => {
      const avr = make(1, 254);
      runTo(avr, 100);
      expect(avr.cpu.readData(A.TCNT2)).toBe(0);
      expect(flags(avr) & bit(A.TOV2)).toBe(0);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        runTo(chip, 152);
        expect(chip.cpu.readData(A.TCNT2)).toBe(1);
        expect(flags(chip) & bit(A.TOV2)).toBe(0);
        chip.runCycles(1);
        expect(flags(chip) & bit(A.TOV2)).toBe(bit(A.TOV2));
      }
    });

    for (const interrupts of [false, true]) {
      test(`overflow wakes with counter advanced beyond BOTTOM, I=${Number(interrupts)}`, () => {
        const avr = make(1, 254);
        avr.cpu.writeData(A.TIMSK2, bit(A.TOIE2));
        avr.cpu.sreg.I = interrupts;
        avr.runCycles(75);
        sleep(avr, 3);
        runTo(avr, 149);
        expect(avr.cpu.isSleeping).toBe(true);
        avr.runCycles(1);
        expect(avr.cpu.isSleeping).toBe(false);
        expect(avr.cpu.data[A.TCNT2]).toBe(1);
        expect(avr.cpu.cycles).toBe(interrupts ? 158 : 154);
        expect(avr.cpu.pc).toBe(interrupts ? A.TIMER2_OVF_VECTOR : 75);
      });
    }

    test("idle leaves the CPU synchronizer clock running", () => {
      const avr = make();
      avr.cpu.writeData(A.TIMSK2, bit(A.OCIE2A));
      avr.runCycles(75);
      sleep(avr, 0);
      runTo(avr, 152);
      expect(avr.cpu.isSleeping).toBe(true);
      avr.runCycles(1);
      expect(avr.cpu.isSleeping).toBe(false);
      expect(avr.cpu.cycles).toBe(157);
      expect(flags(avr) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
    });

    test("masked timer-domain flags wait for an external wake to cross stopped I/O clocks", () => {
      const avr = make();
      avr.runCycles(75);
      sleep(avr, 3);
      runTo(avr, 250);
      expect(avr.cpu.isSleeping).toBe(true);
      expect(flags(avr) & 6).toBe(0);
      expect(avr.cpu.readData(A.TCNT2)).toBe(5);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.cpu.requestInterrupt(A.INT0_VECTOR);
        chip.cpu.tick();
        expect(chip.cpu.cycles).toBe(255);
        expect(flags(chip) & 6).toBe(6);
        chip.cpu.clearInterrupt(A.INT0_VECTOR);
        expect(chip.cpu.snapshot().pendingInterrupts).not.toContain(A.TIMER2_COMPA_VECTOR);
        chip.cpu.writeData(A.TIMSK2, bit(A.OCIE2A));
        expect(chip.cpu.snapshot().pendingInterrupts).toContain(A.TIMER2_COMPA_VECTOR);
      }
    });

    test("enabling a staged flag while asleep starts wake without a counter read", () => {
      const avr = make();
      avr.runCycles(75);
      sleep(avr, 3);
      runTo(avr, 175);
      expect(avr.cpu.isSleeping).toBe(true);
      avr.cpu.writeData(A.TIMSK2, bit(A.OCIE2A));
      avr.runCycles(1);
      expect(avr.cpu.isSleeping).toBe(false);
      expect(avr.cpu.cycles).toBe(180);
      expect(flags(avr) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
    });

    for (const mode of [2, 6]) {
      test(`sleep ${mode} freezes an incomplete CPU stage until an external wake`, () => {
        const avr = make();
        avr.runCycles(151);
        sleep(avr, mode);
        avr.runCycles(200);
        expect(flags(avr) & bit(A.OCF2A)).toBe(0);
        const snap = avr.snapshot();
        expect(snap.timer2.asyncFlags).toContainEqual({ mask: bit(A.OCF2A), remainingCycles: 2 });
        const restored = A.AVR().restore(snap);
        restored.cpu.requestInterrupt(A.INT0_VECTOR);
        restored.cpu.tick();
        expect(restored.cpu.isSleeping).toBe(false);
        expect(flags(restored) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
      });
    }

    for (const change of ["CLKPR", "host", "stop", "TSM", "PRR"] as const) {
      test(`${change} does not rescale or stop the three CPU clocks of an in-flight flag`, () => {
        const avr = make();
        avr.runCycles(151);
        if (change === "CLKPR") {
          avr.cpu.writeData(A.CLKPR, bit(A.CLKPCE));
          avr.cpu.writeData(A.CLKPR, 1);
        } else if (change === "host") avr.useClock(819_200);
        else if (change === "stop") avr.cpu.writeData(A.TCCR2B, 0);
        else if (change === "TSM") avr.cpu.writeData(A.GTCCR, bit(A.TSM) | bit(A.PSRASY));
        else avr.cpu.writeData(A.PRR, bit(A.PRTIM2));
        const restored = A.AVR().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          chip.runCycles(1);
          expect(flags(chip) & bit(A.OCF2A)).toBe(0);
          chip.runCycles(1);
          expect(flags(chip) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
        }
      });
    }

    test("mask changes and W1C before arrival retain an already detected condition", () => {
      const avr = make();
      avr.cpu.writeData(A.TIMSK2, bit(A.OCIE2A));
      avr.runCycles(151);
      avr.cpu.writeData(A.TIFR2, bit(A.OCF2A));
      avr.cpu.writeData(A.TIMSK2, 0);
      avr.runCycles(2);
      expect(flags(avr) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
      expect(avr.cpu.snapshot().pendingInterrupts).not.toContain(A.TIMER2_COMPA_VECTOR);
      avr.cpu.writeData(A.TIMSK2, bit(A.OCIE2A));
      expect(avr.cpu.snapshot().pendingInterrupts).toContain(A.TIMER2_COMPA_VECTOR);
      avr.cpu.writeData(A.TIFR2, bit(A.OCF2A));
      avr.runCycles(20);
      expect(flags(avr) & bit(A.OCF2A)).toBe(0);
      expect(avr.cpu.snapshot().pendingInterrupts).not.toContain(A.TIMER2_COMPA_VECTOR);
    });

    test("simultaneous flags wake once and preserve interrupt priority", () => {
      const avr = make();
      avr.cpu.writeData(A.OCR2B, 2);
      avr.cpu.writeData(A.TIMSK2, 6);
      avr.cpu.sreg.I = true;
      avr.runCycles(75);
      sleep(avr, 3);
      let wakes = 0;
      avr.cpu.onWake(() => { wakes++; });
      runTo(avr, 149);
      avr.runCycles(1);
      expect(wakes).toBe(1);
      expect(avr.cpu.pc).toBe(A.TIMER2_COMPA_VECTOR);
      expect(flags(avr) & 6).toBe(bit(A.OCF2B));
      expect(avr.cpu.snapshot().pendingInterrupts).toContain(A.TIMER2_COMPB_VECTOR);
    });

    for (const clockHz of [256_000, 16_000_000]) {
      test(`fractional ${clockHz} Hz counter edges retain the CPU-stage deadline`, () => {
        const avr = make();
        avr.useClock(clockHz);
        const boundary = Math.ceil(3 * clockHz / 32768);
        runTo(avr, boundary + 1);
        const restored = A.AVR().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          chip.runCycles(1);
          expect(flags(chip) & bit(A.OCF2A)).toBe(0);
          chip.runCycles(1);
          expect(flags(chip) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
        }
      });
    }

    test("a coalesced instruction crossing the flag deadline does not add a fourth CPU cycle", () => {
      const avr = make();
      avr.runCycles(149);
      avr.cpu.cycles += 4; // Timer edge 150 and CPU flag 153 within one instruction.
      expect(flags(avr) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
    });

    for (const reset of ["reset", "resetExternal", "resetBrownOut"] as const) {
      test(`${reset} discards incomplete flag synchronizers`, () => {
        const avr = make();
        avr.runCycles(151);
        avr[reset]();
        avr.runCycles(200);
        expect(flags(avr)).toBe(0);
        expect(avr.snapshot().timer2.asyncFlags).toEqual([]);
      });
    }

    test("AS2 switching discards incomplete flags but preserves visible flags", () => {
      const avr = make();
      avr.runCycles(151);
      avr.cpu.writeData(A.ASSR, 0);
      avr.cpu.writeData(A.TCCR2B, 0);
      avr.runCycles(4);
      expect(flags(avr) & bit(A.OCF2A)).toBe(0);
      avr.cpu.data[A.TIFR2] = bit(A.OCF2B);
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      expect(flags(avr)).toBe(bit(A.OCF2B));
    });

    test("legacy snapshots add no phantom pending flags", () => {
      const avr = make();
      avr.runCycles(151);
      const snap = avr.snapshot();
      delete snap.timer2.asyncFlags;
      delete snap.timer2.asyncOverflowPending;
      const restored = A.AVR().restore(snap);
      restored.runCycles(10);
      expect(flags(restored) & bit(A.OCF2A)).toBe(0);
    });

    test("synchronous overflow remains immediate", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.TCNT2, 254);
      avr.cpu.writeData(A.TCCR2B, 1);
      avr.runCycles(2);
      expect(flags(avr) & bit(A.TOV2)).toBe(bit(A.TOV2));
    });

    test("compiled polling and power-save ISR probe completes with source-domain flags and read synchronization", () => {
      const hex = readFileSync(new URL("../examples/timer2-sync-probe/timer2-sync-probe.hex", import.meta.url), "utf8");
      const avr = A.AVR({ hex, timing });
      avr.runCycles(100_000);
      const result = [...avr.cpu.data.slice(0x300, 0x308)];
      expect(result[0]).toBe(0xa7);
      expect(result[1]).toBe(0); // Existing reset convention; exact handshake uncalibrated.
      expect(result[2]).toBe(0);
      expect(result[3]).toBe(3);
      expect(result[4]! & bit(A.OCF2A)).toBe(bit(A.OCF2A));
      expect(result[5]).toBe(3); // Power-save pre-sleep CPU read, until the next TOSC edge.
      expect(result[6]! & bit(A.OCF2A)).toBe(0);
      expect(result[7]).toBe(0x5c);
    });
  });
}
