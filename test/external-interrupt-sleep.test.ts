import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as A from "../src";

type Avr = ReturnType<typeof A.AVR>;
const bit = (n: number) => 1 << n;
const flag = (avr: Avr, index: number) => avr.cpu.readData(A.EIFR) & bit(index);
const vector = (index: number) => index === 0 ? A.INT0_VECTOR : A.INT1_VECTOR;
const prepare = (timing: "fast" | "cycle-exact", index: number, sense: number, mode: number, interrupts = false, enabled = true) => {
  const avr = A.AVR({ timing });
  avr.cpu.flash[0] = 0xcfff;
  avr.cpu.flash[vector(index)] = 0xcfff;
  avr.pin(index + 2).setInput(sense === 0 || sense === 2);
  avr.cpu.writeData(A.EICRA, sense << (index * 2));
  avr.cpu.writeData(A.EIFR, 3);
  avr.cpu.writeData(A.EIMSK, enabled ? bit(index) : 0);
  avr.cpu.sreg.I = interrupts;
  avr.cpu.writeData(A.SMCR, (mode << 1) | 1);
  avr.cpu.sleep();
  return avr;
};

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: external interrupt sleep clocks`, () => {
    for (const index of [0, 1]) {
      for (const sense of [1, 2, 3]) {
        for (const mode of [0, 1, 2, 3, 6, 7]) {
          for (const interrupts of [false, true]) {
            test(`INT${index} sense ${sense}, sleep ${mode}, I=${Number(interrupts)}`, () => {
              const avr = prepare(timing, index, sense, mode, interrupts);
              const restored = A.AVR().restore(avr.snapshot());
              for (const chip of [avr, restored]) {
                chip.pin(index + 2).setInput(sense !== 2);
                expect(flag(chip, index)).toBe(mode === 0 ? bit(index) : 0);
                chip.cpu.tick();
                expect(chip.cpu.isSleeping).toBe(mode !== 0);
                if (mode === 0 && interrupts) {
                  expect(chip.cpu.pc).toBe(vector(index));
                  expect(chip.cpu.snapshot().pendingInterrupts).not.toContain(vector(index));
                }
              }
            });
          }
        }
      }
      for (const mode of [0, 1, 2, 3, 6, 7]) {
        for (const interrupts of [false, true]) {
          test(`INT${index} asynchronous low level wakes sleep ${mode}, I=${Number(interrupts)}`, () => {
            const avr = prepare(timing, index, 0, mode, interrupts);
            const restored = A.AVR().restore(avr.snapshot());
            for (const chip of [avr, restored]) {
              chip.pin(index + 2).setInput(false);
              chip.cpu.tick();
              expect(chip.cpu.isSleeping).toBe(false);
              expect(flag(chip, index)).toBe(0);
              if (interrupts) expect(chip.cpu.pc).toBe(vector(index));
            }
          });
        }
      }
    }

    for (const index of [0, 1]) {
      for (const sense of [1, 2, 3]) {
        for (const mode of [1, 2, 3, 6, 7]) {
          for (const completed of [false, true]) {
            test(`INT${index} sense ${sense}, sleep ${mode}, ${completed ? "completed pulse" : "held change"} at external wake`, () => {
              const avr = prepare(timing, index, sense, mode);
              avr.pin(index + 2).setInput(sense !== 2);
              if (completed) avr.pin(index + 2).setInput(sense === 2);
              avr.runCycles(3);
              expect(avr.cpu.isSleeping).toBe(true);
              expect(flag(avr, index)).toBe(0);
              const restored = A.AVR().restore(avr.snapshot());
              for (const chip of [avr, restored]) {
                chip.cpu.writeData(A.PCMSK0, 1);
                chip.cpu.writeData(A.PCICR, 1);
                chip.pin(8).setInput(true);
                chip.cpu.tick();
                expect(chip.cpu.isSleeping).toBe(false);
                expect(flag(chip, index)).toBe(completed ? 0 : bit(index));
                expect(chip.cpu.snapshot().pendingInterrupts.includes(vector(index))).toBe(!completed);
                chip.cpu.writeData(A.EIFR, bit(index));
                expect(flag(chip, index)).toBe(0);
                chip.pin(index + 2).setInput(sense === 2);
                chip.cpu.writeData(A.EIFR, bit(index));
                chip.pin(index + 2).setInput(sense !== 2);
                expect(flag(chip, index)).toBe(bit(index));
              }
            });
          }
        }
      }

      for (const mode of [0, 1, 2, 3, 6, 7]) {
        test(`PCINT on INT${index}'s pin still wakes sleep ${mode} and samples the held edge`, () => {
          const avr = prepare(timing, index, 3, mode);
          avr.cpu.writeData(A.PCMSK2, bit(index + 2));
          avr.cpu.writeData(A.PCICR, 4);
          avr.pin(index + 2).setInput(true);
          expect(avr.cpu.readData(A.PCIFR) & 4).toBe(4);
          expect(flag(avr, index)).toBe(mode === 0 ? bit(index) : 0);
          avr.cpu.tick();
          expect(avr.cpu.isSleeping).toBe(false);
          expect(flag(avr, index)).toBe(bit(index));
          avr.cpu.sreg.I = true;
          avr.cpu.tick();
          expect(avr.cpu.pc).toBe(vector(index));
          expect(avr.cpu.readData(A.PCIFR) & 4).toBe(4);
        });
      }

      for (const sense of [1, 2, 3]) {
        test(`masked INT${index} sense ${sense} retains a held edge for late enable after wake`, () => {
          const avr = prepare(timing, index, sense, 2, false, false);
          avr.pin(index + 2).setInput(sense !== 2);
          expect(flag(avr, index)).toBe(0);
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            chip.cpu.requestInterrupt(A.WDT_VECTOR);
            chip.cpu.tick();
            expect(flag(chip, index)).toBe(bit(index));
            expect(chip.cpu.snapshot().pendingInterrupts).not.toContain(vector(index));
            chip.cpu.writeData(A.EIMSK, bit(index));
            expect(chip.cpu.snapshot().pendingInterrupts).toContain(vector(index));
          }
        });
      }
    }

    test("one pin's asynchronous low level wakes while the sibling edge detector is stopped", () => {
      const avr = prepare(timing, 0, 3, 2);
      avr.pin(3).setInput(true);
      avr.cpu.writeData(A.EIMSK, 3);
      avr.pin(2).setInput(true);
      expect(flag(avr, 0)).toBe(0);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.pin(3).setInput(false);
        chip.cpu.tick();
        expect(chip.cpu.isSleeping).toBe(false);
        expect(flag(chip, 0)).toBe(1);
        expect(flag(chip, 1)).toBe(0);
        chip.cpu.writeData(A.EIMSK, 1);
        chip.cpu.sreg.I = true;
        chip.cpu.tick();
        expect(chip.cpu.pc).toBe(A.INT0_VECTOR);
      }
    });

    for (const completed of [false, true]) {
      test(`compiled power-down probe ignores ${completed ? "a completed pulse" : "a held rising change"} until asynchronous PCINT wake`, () => {
        const hex = readFileSync(new URL("../examples/exti-sleep-probe/exti-sleep-probe.hex", import.meta.url), "utf8");
        const avr = A.AVR({ timing, hex });
        avr.runCycles(1_000);
        expect(avr.cpu.isSleeping).toBe(true);
        expect([...avr.cpu.data.slice(0x300, 0x304)]).toEqual([0xa7, 0, 0, 0]);
        avr.pin(2).setInput(true);
        if (completed) avr.pin(2).setInput(false);
        avr.runCycles(100);
        expect(avr.cpu.isSleeping).toBe(true);
        expect(flag(avr, 0)).toBe(0);
        const restored = A.AVR().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          chip.pin(8).setInput(true);
          chip.runCycles(1_000);
          expect([...chip.cpu.data.slice(0x300, 0x304)]).toEqual([0xa7, completed ? 0 : 1, 1, 0x5c]);
        }
      });
    }
  });
}
