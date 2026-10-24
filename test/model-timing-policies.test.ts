import { describe, expect, test } from "bun:test";
import * as A from "../src";
const bit = (n: number) => 1 << n;

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: explicit timing policies`, () => {
    test("INT0 synchronizer rejects sub-sample pulses and preserves pipeline through snapshot", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.EICRA, 3);
      avr.cpu.writeData(A.EIMSK, 1);
      avr.gpio.useInterruptSynchronization();
      avr.pin(2).setInput(true); avr.pin(2).setInput(false);
      avr.runCycles(3);
      expect(avr.cpu.readData(A.EIFR) & 1).toBe(0);
      avr.pin(2).setInput(true);
      avr.runCycles(1);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.runCycles(1);
        expect(chip.cpu.readData(A.EIFR) & 1).toBe(0);
        chip.runCycles(1);
        expect(chip.cpu.readData(A.EIFR) & 1).toBe(1);
        expect(chip.cpu.snapshot().pendingInterrupts).toContain(A.INT0_VECTOR);
      }
    });

    test("comparator delay rejects short excursions and preserves pending capture timing", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.comparator.setTiming({ propagationCycles: 2 });
      avr.comparator.setInput("ain1", 1);
      avr.cpu.writeData(A.ACSR, bit(A.ACIE) | bit(A.ACIC));
      avr.cpu.writeData(A.TCCR1B, bit(A.ICES1) | 1);
      avr.comparator.setInput("ain0", 2);
      avr.runCycles(1);
      expect(avr.comparator.readOutput()).toBe(false);
      avr.comparator.setInput("ain0", 0);
      avr.runCycles(3);
      expect(avr.cpu.readData(A.ACSR) & bit(A.ACI)).toBe(0);
      avr.comparator.setInput("ain0", 2);
      avr.runCycles(1);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.runCycles(1);
        expect(chip.comparator.readOutput()).toBe(true);
        expect(chip.cpu.readData(A.ACSR) & bit(A.ACI)).toBe(bit(A.ACI));
        expect(chip.cpu.readData(A.ICR1L)).toBe(6);
      }
    });

    test("comparator re-enable honors configured settling before propagation", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.comparator.setTiming({ propagationCycles: 2, settlingCycles: 4 });
      avr.cpu.writeData(A.ACSR, bit(A.ACD));
      avr.comparator.setInput("ain0", 2);
      avr.cpu.writeData(A.ACSR, 0);
      avr.runCycles(5);
      expect(avr.comparator.readOutput()).toBe(false);
      avr.runCycles(1);
      expect(avr.comparator.readOutput()).toBe(true);
      expect(() => avr.comparator.setTiming({ propagationCycles: -1 })).toThrow();
    });

    test("OSCCAL host curve affects internal RC, preserves CLKPR and restores independently", () => {
      const avr = A.AVR({ timing, fuses: { low: 0xe2 } });
      avr.cpu.flash.fill(0);
      const curve = Array.from({ length: 256 }, (_, i) => 8_000_000 + i * 1000);
      avr.useOscillatorCalibration(curve);
      expect(avr.status().clockHz).toBe(8_000_000);
      curve[128] = 1; // Runtime owns a copy.
      avr.cpu.writeData(A.OSCCAL, 128);
      expect(avr.status().clockHz).toBe(8_128_000);
      avr.cpu.writeData(A.CLKPR, bit(A.CLKPCE)); avr.cpu.writeData(A.CLKPR, 1);
      expect(avr.status().clockHz).toBe(4_064_000);
      const restored = A.AVR().restore(avr.snapshot());
      restored.cpu.writeData(A.OSCCAL, 64);
      expect(restored.status().clockHz).toBe(4_032_000);
      restored.useFuses({ low: 0xff });
      restored.cpu.writeData(A.OSCCAL, 0);
      expect(restored.status().clockHz).toBe(4_032_000);
      expect(() => avr.useOscillatorCalibration([1])).toThrow();
    });

    test("OSCCAL factory reset code survives firmware changes and snapshots", () => {
      const curve = Array.from({ length: 256 }, (_, i) => 8_000_000 + i * 1000);
      const avr = A.AVR({ timing, fuses: { low: 0xe2 } });
      avr.cpu.flash.fill(0);
      avr.useOscillatorCalibration(curve, { resetCode: 128 });
      expect(avr.cpu.data[A.OSCCAL]).toBe(128);
      expect(avr.status().clockHz).toBe(8_128_000);
      avr.cpu.writeData(A.OSCCAL, 64);
      const restored = A.AVR().restore(avr.snapshot());
      expect(restored.cpu.data[A.OSCCAL]).toBe(64);
      for (const reset of [() => restored.reset(), () => restored.resetExternal(), () => restored.resetBrownOut()]) {
        restored.cpu.writeData(A.OSCCAL, 1);
        reset();
        expect(restored.cpu.data[A.OSCCAL]).toBe(128);
        expect(restored.status().clockHz).toBe(8_128_000);
      }
      for (const resetCode of [-1, 256, 1.5, NaN]) {
        expect(() => avr.useOscillatorCalibration(curve, { resetCode })).toThrow(/resetCode/);
      }
      const snap = avr.snapshot();
      snap.runtime.oscillatorCalibrationResetCode = 256;
      expect(() => restored.restore(snap)).toThrow(/reset code/);
      delete snap.runtime.oscillatorCalibrationResetCode;
      restored.restore(snap).reset();
      expect(restored.cpu.data[A.OSCCAL]).toBe(0);
    });
  });
}
