import { describe, expect, test } from "bun:test";
import * as A from "../src";
const bit = (n: number) => 1 << n;
const edge = (avr: ReturnType<typeof A.AVR>) => { avr.timer2Clock.setInput(false); avr.timer2Clock.setInput(true); };

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: Timer2 clock and handshake`, () => {
    test("manual EXCLK drives register transfers and counts with no autonomous source", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.timer2Clock.setFrequency(null);
      avr.cpu.writeData(A.ASSR, bit(A.AS2) | bit(A.EXCLK));
      avr.cpu.writeData(A.TCCR2B, 2);
      edge(avr);
      expect(avr.cpu.data[A.TCCR2B]).toBe(0);
      expect(avr.cpu.readData(A.ASSR) & bit(A.TCR2BUB)).toBe(bit(A.TCR2BUB));
      edge(avr);
      expect(avr.cpu.data[A.TCCR2B]).toBe(2);
      avr.runCycles(5000);
      expect(avr.cpu.readData(A.TCNT2)).toBe(0);
      for (let i = 0; i < 6; i++) edge(avr);
      expect(avr.cpu.readData(A.TCNT2)).toBe(1);
      avr.cpu.writeData(A.TCNT2, 50);
      edge(avr);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.timer2Clock.setInput(true); // A held high level supplies no new edge.
        expect(chip.cpu.readData(A.TCNT2)).toBe(1);
        edge(chip);
        expect(chip.cpu.readData(A.TCNT2)).toBe(50);
        expect(chip.cpu.readData(A.ASSR) & bit(A.TCN2UB)).toBe(0);
      }
    });

    test("configured source frequency preserves fractional phase and pending writes", () => {
      const avr = A.AVR({ timing, clockHz: 327_680 });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.runCycles(5);
      avr.cpu.writeData(A.TCCR2B, 1);
      avr.timer2Clock.setFrequency(16_384);
      avr.runCycles(29);
      expect(avr.cpu.data[A.TCCR2B]).toBe(0);
      avr.runCycles(1);
      expect(avr.cpu.data[A.TCCR2B]).toBe(1);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        const before = chip.cpu.readData(A.TCNT2);
        chip.runCycles(20);
        expect(chip.cpu.readData(A.TCNT2)).toBe(before + 1);
      }
      expect(() => avr.timer2Clock.setFrequency(0)).toThrow();
      expect(() => avr.timer2Clock.setFrequency(NaN)).toThrow();
    });

    test("PSRASY stays high until the next source edge and restores mid-handshake", () => {
      const avr = A.AVR({ timing, clockHz: 327_680 });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.TCCR2B, 2);
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.runCycles(35);
      avr.cpu.writeData(A.GTCCR, bit(A.PSRASY));
      expect(avr.cpu.readData(A.GTCCR)).toBe(bit(A.PSRASY));
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.runCycles(4);
        expect(chip.cpu.readData(A.GTCCR)).toBe(bit(A.PSRASY));
        chip.runCycles(1);
        expect(chip.cpu.readData(A.GTCCR)).toBe(0);
        chip.runCycles(79);
        expect(chip.cpu.readData(A.TCNT2)).toBe(0);
        chip.runCycles(1);
        expect(chip.cpu.readData(A.TCNT2)).toBe(1);
      }
    });

    test("sleep before async clear acknowledgement causes the documented repeated wake", () => {
      const avr = A.AVR({ timing, clockHz: 1_638_400 });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.TCNT2, 254);
      avr.cpu.writeData(A.TCCR2B, 1);
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.cpu.writeData(A.TIMSK2, bit(A.TOIE2));
      avr.runCycles(153);
      expect(avr.cpu.readData(A.TIFR2) & 1).toBe(1);
      avr.cpu.writeData(A.TIFR2, 1);
      expect(avr.cpu.readData(A.TIFR2) & 1).toBe(0);
      avr.cpu.writeData(A.SMCR, (3 << 1) | 1);
      avr.cpu.sleep();
      avr.runCycles(1);
      expect(avr.cpu.isSleeping).toBe(false);
      expect(avr.cpu.readData(A.TIFR2) & 1).toBe(1);
      avr.cpu.writeData(A.TIFR2, 1);
      avr.runCycles(200 - avr.cpu.cycles);
      avr.cpu.sleep();
      avr.runCycles(10);
      expect(avr.cpu.isSleeping).toBe(true);
    });

    test("restoring into a power-down target schedules pending reset and flag-clear handshakes", () => {
      const source = A.AVR({ timing, clockHz: 327_680 });
      source.cpu.flash.fill(0);
      source.cpu.writeData(A.TCNT2, 254);
      source.cpu.writeData(A.TCCR2B, 1);
      source.cpu.writeData(A.ASSR, bit(A.AS2));
      source.cpu.cycles += 33;
      expect(source.cpu.readData(A.TIFR2) & 1).toBe(1);
      source.cpu.writeData(A.TIFR2, 1);
      source.cpu.writeData(A.GTCCR, bit(A.PSRASY));
      const snap = source.snapshot();
      expect(snap.timer2.asyncClearRemaining).toBeGreaterThan(0);
      expect(snap.timer2.asyncResetRemaining).toBeGreaterThan(0);
      const target = A.AVR({ timing });
      target.cpu.flash.fill(0);
      target.cpu.writeData(A.ASSR, bit(A.AS2));
      target.cpu.writeData(A.SMCR, (2 << 1) | 1);
      target.cpu.sleep();
      expect(target.cpu.isSleeping).toBe(true);
      target.restore(snap);
      expect(target.cpu.isSleeping).toBe(false);
      target.cpu.cycles += 6;
      expect(target.cpu.readData(A.GTCCR) & bit(A.PSRASY)).toBe(bit(A.PSRASY));
      target.cpu.cycles++;
      expect(target.cpu.readData(A.GTCCR) & bit(A.PSRASY)).toBe(0);
      expect(target.snapshot().timer2.asyncClearRemaining).toBeUndefined();
      expect(target.snapshot().timer2.asyncTimerFlags! & 1).toBe(0);
    });

    test("manual clock acknowledges reset on an edge and stops in power down", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.TCCR2B, 1);
      avr.timer2Clock.setFrequency(null);
      avr.cpu.writeData(A.ASSR, bit(A.AS2) | bit(A.EXCLK));
      edge(avr);
      avr.cpu.writeData(A.GTCCR, bit(A.PSRASY));
      expect(avr.cpu.readData(A.GTCCR)).toBe(bit(A.PSRASY));
      edge(avr);
      expect(avr.cpu.readData(A.GTCCR)).toBe(0);
      expect(avr.cpu.readData(A.TCNT2)).toBe(1);
      avr.cpu.writeData(A.SMCR, (2 << 1) | 1);
      avr.cpu.sleep();
      edge(avr);
      expect(avr.cpu.readData(A.TCNT2)).toBe(1);
    });
  });
}
