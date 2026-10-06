import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as A from "../src";

const bit = (n: number) => 1 << n;
type Avr = ReturnType<typeof A.AVR>;
const result = (avr: Avr) => avr.cpu.readData(A.ADCL) | (avr.cpu.readData(A.ADCH) << 8);
const flag = (avr: Avr) => avr.cpu.data[A.ACSR]! & bit(A.ACI);
const sleep = (avr: Avr, mode: number) => {
  avr.cpu.writeData(A.SMCR, (mode << 1) | 1);
  avr.cpu.sleep();
};

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: analog input and sleep boundaries`, () => {
    for (const completed of [false, true]) {
      test(`compiled idle ADC / power-down comparator probe with ${completed ? "completed pulse" : "held level"}`, () => {
        const hex = readFileSync(new URL("../examples/analog-sleep-probe/analog-sleep-probe.hex", import.meta.url), "utf8");
        const avr = A.AVR({ timing, hex });
        avr.analog(0).setValue(123);
        avr.comparator.setInput("ain1", 1);
        avr.runCycles(20_000);
        expect([...avr.cpu.data.slice(0x300, 0x307)]).toEqual([0xa7, 123, 0, 0, 0, 0, 0]);
        expect(avr.cpu.isSleeping).toBe(true);
        expect(avr.cpu.sleepMode).toBe(2);
        avr.comparator.setInput("ain0", 2);
        if (completed) avr.comparator.setInput("ain0", 0);
        avr.runCycles(100);
        expect(avr.cpu.isSleeping).toBe(true);
        const restored = A.AVR().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          chip.pin(8).setInput(true);
          chip.runCycles(2_000);
          expect([...chip.cpu.data.slice(0x300, 0x307)]).toEqual([0xa7, 123, 0, completed ? 0 : 1, 1, completed ? 0 : 1, 0x5c]);
        }
      });
    }

    for (const mode of [0, 1]) {
      test(`sleep ${mode} keeps ordinary conversion timing after the first conversion`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.flash[0] = 0xcfff;
        avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
        avr.runCycles(50);
        avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADIF));
        avr.analog(0).setValue(654);
        sleep(avr, mode);
        avr.runCycles(20);
        expect(avr.cpu.data[A.ADCSRA]! & bit(A.ADIF)).toBe(0);
        const restored = A.AVR().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          chip.runCycles(6);
          expect(result(chip)).toBe(654);
          expect(chip.cpu.data[A.ADCSRA]! & bit(A.ADSC)).toBe(0);
        }
      });

      for (const interrupts of [false, true]) {
        for (const autoTrigger of [false, true]) {
          test(`sleep ${mode} starts enabled ADC, I=${Number(interrupts)}, ADATE=${Number(autoTrigger)}`, () => {
            const avr = A.AVR({ timing });
            avr.cpu.flash[0] = 0xcfff;
            avr.analog(0).setValue(321);
            // External trigger selected but absent: sleep entry supplies the start.
            avr.cpu.writeData(A.ADCSRB, 2);
            avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADIE) | (autoTrigger ? bit(A.ADATE) : 0));
            avr.cpu.sreg.I = interrupts;
            sleep(avr, mode);
            expect(avr.cpu.data[A.ADCSRA]! & bit(A.ADSC)).toBe(bit(A.ADSC));
            avr.runCycles(20);
            const restored = A.AVR().restore(avr.snapshot());
            for (const chip of [avr, restored]) {
              chip.runCycles(60);
              expect(result(chip)).toBe(321);
              expect(chip.cpu.isSleeping).toBe(false);
              expect(chip.cpu.data[A.ADCSRA]! & bit(A.ADSC)).toBe(0);
            }
          });
        }
      }

      test(`sleep ${mode} does not restart an in-flight ADC sample`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.flash[0] = 0xcfff;
        avr.analog(0).setValue(456);
        avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
        avr.runCycles(30); // First-conversion sample already held, completion at 50.
        avr.analog(0).setValue(789);
        sleep(avr, mode);
        const restored = A.AVR().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          chip.runCycles(20);
          expect(result(chip)).toBe(456);
          expect(chip.cpu.data[A.ADCSRA]! & bit(A.ADIF)).toBe(bit(A.ADIF));
        }
      });

      for (const gated of ["disabled", "PRADC"] as const) {
        test(`sleep ${mode} does not convert with ADC ${gated}`, () => {
          const avr = A.AVR({ timing });
          avr.cpu.flash[0] = 0xcfff;
          if (gated === "PRADC") {
            avr.cpu.writeData(A.PRR, bit(A.PRADC));
            avr.cpu.writeData(A.ADCSRA, bit(A.ADEN));
          }
          sleep(avr, mode);
          avr.runCycles(60);
          expect(avr.cpu.data[A.ADCSRA]! & (bit(A.ADSC) | bit(A.ADIF))).toBe(0);
        });
      }
    }

    for (const channel of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const setter of ["value", "voltage"] as const) {
        test(`ACME channel ${channel} ${setter} changes request interrupt/capture without an ACSR read`, () => {
          const avr = A.AVR({ timing });
          avr.cpu.flash[0] = 0xcfff;
          avr.analog(channel).setVoltage(3);
          avr.comparator.setInput("ain0", 2);
          avr.cpu.writeData(A.ADMUX, channel);
          avr.cpu.writeData(A.ADCSRB, bit(A.ACME));
          avr.cpu.writeData(A.TCCR1B, bit(A.ICES1) | 1);
          avr.cpu.writeData(A.ACSR, bit(A.ACIS1) | bit(A.ACIS0) | bit(A.ACIE) | bit(A.ACIC) | bit(A.ACI));
          avr.cpu.writeData(A.TIFR1, bit(A.ICF1));
          expect(flag(avr)).toBe(0);
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            if (setter === "value") chip.analog(channel).setValue(100);
            else chip.analog(channel).setVoltage(0.5);
            // Inspect raw register image: a read hook must not create the event.
            expect(flag(chip)).toBe(bit(A.ACI));
            expect(chip.cpu.snapshot().pendingInterrupts).toContain(A.ANALOG_COMP_VECTOR);
            expect(chip.cpu.data[A.TIFR1]! & bit(A.ICF1)).toBe(bit(A.ICF1));
            expect(chip.cpu.data[A.ACSR]! & bit(A.ACO)).toBe(bit(A.ACO));
          }
        });
      }
    }

    for (const context of ["ACD", "ADEN", "ACME off", "unselected channel"] as const) {
      for (const setter of ["value", "voltage"] as const) {
        test(`analog ${setter} changes do not affect comparator with ${context}`, () => {
          const avr = A.AVR({ timing });
          avr.analog(0).setVoltage(3);
          avr.comparator.setInput("ain1", 3);
          avr.comparator.setInput("ain0", 2);
          avr.cpu.writeData(A.ADCSRB, context === "ACME off" ? 0 : bit(A.ACME));
          avr.cpu.writeData(A.ADCSRA, context === "ADEN" ? bit(A.ADEN) : 0);
          avr.cpu.writeData(A.ACSR, bit(A.ACIE) | bit(A.ACIS1) | bit(A.ACIS0) | bit(A.ACI) | (context === "ACD" ? bit(A.ACD) : 0));
          const channel = context === "unselected channel" ? 1 : 0;
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            if (setter === "value") chip.analog(channel).setValue(100);
            else chip.analog(channel).setVoltage(0.5);
            expect(flag(chip)).toBe(0);
            expect(chip.cpu.snapshot().pendingInterrupts).not.toContain(A.ANALOG_COMP_VECTOR);
            expect(chip.cpu.data[A.ACSR]! & bit(A.ACO)).toBe(0);
          }
        });
      }
    }

    for (const sense of [0, 2, 3]) {
      for (const interrupts of [false, true]) {
        test(`noise-reduction comparator sense ${sense} retains flag without waking, I=${Number(interrupts)}`, () => {
          const avr = A.AVR({ timing });
          avr.cpu.flash[0] = 0xcfff;
          avr.comparator.setInput("ain1", 1);
          avr.comparator.setInput("ain0", sense === 2 ? 2 : 0);
          avr.cpu.writeData(A.ACSR, sense | bit(A.ACIE) | bit(A.ACI));
          avr.cpu.sreg.I = interrupts;
          sleep(avr, 1);
          avr.comparator.setInput("ain0", sense === 2 ? 0 : 2);
          expect(flag(avr)).toBe(bit(A.ACI));
          avr.runCycles(5);
          expect(avr.cpu.isSleeping).toBe(true);
          expect(avr.cpu.snapshot().pendingInterrupts).not.toContain(A.ANALOG_COMP_VECTOR);
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            chip.cpu.writeData(A.PCMSK0, 1);
            chip.cpu.writeData(A.PCICR, 1);
            chip.pin(8).setInput(true);
            chip.cpu.tick();
            expect(chip.cpu.isSleeping).toBe(false);
            expect(chip.cpu.snapshot().pendingInterrupts).toContain(A.ANALOG_COMP_VECTOR);
          }
        });
      }

      for (const interrupts of [false, true]) {
        test(`idle comparator sense ${sense} wakes, I=${Number(interrupts)}, without duplicate acknowledgement`, () => {
          const avr = A.AVR({ timing });
          avr.cpu.flash[0] = 0xcfff;
          avr.comparator.setInput("ain1", 1);
          avr.comparator.setInput("ain0", sense === 2 ? 2 : 0);
          avr.cpu.writeData(A.ACSR, sense | bit(A.ACIE) | bit(A.ACI));
          avr.cpu.sreg.I = interrupts;
          sleep(avr, 0);
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            chip.comparator.setInput("ain0", sense === 2 ? 0 : 2);
            chip.cpu.tick();
            expect(chip.cpu.isSleeping).toBe(false);
            if (interrupts) {
              expect(chip.cpu.pc).toBe(A.ANALOG_COMP_VECTOR);
              expect(flag(chip)).toBe(0);
              expect(chip.cpu.snapshot().pendingInterrupts).not.toContain(A.ANALOG_COMP_VECTOR);
            } else {
              expect(flag(chip)).toBe(bit(A.ACI));
            }
          }
        });
      }
    }

    for (const mode of [1, 2, 3, 6, 7]) {
      for (const cleared of [false, true]) {
        test(`sleep ${mode} blocks previously pending comparator wake, ${cleared ? "W1C cleared" : "flag retained"}`, () => {
          const avr = A.AVR({ timing });
          avr.cpu.flash[0] = 0xcfff;
          avr.comparator.setInput("ain1", 1);
          avr.cpu.writeData(A.ACSR, bit(A.ACIE) | bit(A.ACIS1) | bit(A.ACIS0) | bit(A.ACI));
          avr.comparator.setInput("ain0", 2);
          expect(avr.cpu.snapshot().pendingInterrupts).toContain(A.ANALOG_COMP_VECTOR);
          sleep(avr, mode);
          if (cleared) avr.cpu.writeData(A.ACSR, bit(A.ACIE) | bit(A.ACIS1) | bit(A.ACIS0) | bit(A.ACI));
          avr.runCycles(5);
          expect(avr.cpu.isSleeping).toBe(true);
          expect(flag(avr)).toBe(cleared ? 0 : bit(A.ACI));
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            chip.cpu.writeData(A.PCMSK0, 1);
            chip.cpu.writeData(A.PCICR, 1);
            chip.pin(8).setInput(true);
            chip.cpu.tick();
            expect(flag(chip)).toBe(cleared ? 0 : bit(A.ACI));
            expect(chip.cpu.snapshot().pendingInterrupts.includes(A.ANALOG_COMP_VECTOR)).toBe(!cleared);
          }
        });
      }
    }

    for (const mode of [2, 3, 6, 7]) {
      for (const completed of [false, true]) {
        test(`deep sleep ${mode} ACME input ${completed ? "completed pulse" : "held level"} stays quiet until wake`, () => {
          const avr = A.AVR({ timing });
          avr.cpu.flash[0] = 0xcfff;
          avr.analog(5).setVoltage(3);
          avr.comparator.setInput("ain0", 2);
          avr.cpu.writeData(A.ADMUX, 5);
          avr.cpu.writeData(A.ADCSRB, bit(A.ACME));
          avr.cpu.writeData(A.ACSR, bit(A.ACIS1) | bit(A.ACIS0) | bit(A.ACI));
          sleep(avr, mode);
          avr.analog(5).setValue(100);
          if (completed) avr.analog(5).setVoltage(3);
          expect(flag(avr)).toBe(0);
          expect(avr.comparator.readOutput()).toBe(false);
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            chip.cpu.writeData(A.PCMSK0, 1);
            chip.cpu.writeData(A.PCICR, 1);
            chip.pin(8).setInput(true);
            chip.cpu.tick();
            expect(flag(chip)).toBe(completed ? 0 : bit(A.ACI));
            expect(chip.cpu.data[A.ACSR]! & bit(A.ACO)).toBe(completed ? 0 : bit(A.ACO));
            expect(chip.cpu.snapshot().pendingInterrupts).not.toContain(A.ANALOG_COMP_VECTOR);
          }
        });
      }

      for (const completed of [false, true]) {
        test(`deep sleep ${mode} comparator ${completed ? "completed pulse" : "held level"} reaches ADC only after its wake gate resumes`, () => {
          const avr = A.AVR({ timing });
          avr.cpu.flash[0] = 0xcfff;
          avr.analog(0).setValue(432);
          avr.comparator.setInput("ain1", 1);
          avr.cpu.writeData(A.ACSR, bit(A.ACIS1) | bit(A.ACIS0) | bit(A.ACI));
          avr.cpu.writeData(A.ADCSRB, 1);
          avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE));
          sleep(avr, mode);
          avr.comparator.setInput("ain0", 2);
          if (completed) avr.comparator.setInput("ain0", 0);
          expect(avr.cpu.data[A.ADCSRA]! & bit(A.ADSC)).toBe(0);
          const restored = A.AVR().restore(avr.snapshot());
          for (const chip of [avr, restored]) {
            chip.cpu.writeData(A.PCMSK0, 1);
            chip.cpu.writeData(A.PCICR, 1);
            chip.pin(8).setInput(true);
            chip.cpu.tick();
            expect(chip.cpu.data[A.ADCSRA]! & bit(A.ADSC)).toBe(completed ? 0 : bit(A.ADSC));
            chip.runCycles(60);
            expect(result(chip)).toBe(completed ? 0 : 432);
            expect(chip.cpu.data[A.ADCSRA]! & bit(A.ADIF)).toBe(completed ? 0 : bit(A.ADIF));
          }
        });
      }

      test(`deep sleep ${mode} does not start an enabled ADC`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.flash[0] = 0xcfff;
        avr.cpu.writeData(A.ADCSRA, bit(A.ADEN));
        sleep(avr, mode);
        avr.runCycles(60);
        expect(avr.cpu.data[A.ADCSRA]! & (bit(A.ADSC) | bit(A.ADIF))).toBe(0);
      });

      test(`deep sleep ${mode} wake preserves explicit comparator disable`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.flash[0] = 0xcfff;
        avr.cpu.writeData(A.ACSR, bit(A.ACD) | bit(A.ACIE));
        sleep(avr, mode);
        avr.comparator.setInput("ain0", 2);
        const restored = A.AVR().restore(avr.snapshot());
        for (const chip of [avr, restored]) {
          chip.cpu.writeData(A.PCMSK0, 1);
          chip.cpu.writeData(A.PCICR, 1);
          chip.pin(8).setInput(true);
          chip.cpu.tick();
          expect(flag(chip)).toBe(0);
          expect(chip.cpu.data[A.ACSR]! & bit(A.ACO)).toBe(0);
          expect(chip.cpu.data[A.ACSR]! & bit(A.ACD)).toBe(bit(A.ACD));
        }
      });

      for (const sense of [0, 2, 3]) {
        for (const completed of [false, true]) {
          for (const interrupts of [false, true]) {
            test(`comparator sense ${sense}, deep sleep ${mode}, ${completed ? "completed pulse" : "held level"}, I=${Number(interrupts)}`, () => {
              const avr = A.AVR({ timing });
              avr.cpu.flash[0] = 0xcfff;
              avr.comparator.setInput("ain1", 1);
              avr.cpu.writeData(A.ACSR, sense | bit(A.ACIE) | bit(A.ACIC) | bit(A.ACI));
              avr.cpu.writeData(A.TCCR1B, (sense === 2 ? 0 : bit(A.ICES1)) | 1);
              // Establish the capture front-end's initial sample while ACIC owns it.
              avr.comparator.setInput("ain0", sense === 2 ? 2 : 0);
              avr.cpu.writeData(A.ACSR, sense | bit(A.ACIE) | bit(A.ACIC) | bit(A.ACI));
              avr.cpu.writeData(A.TIFR1, bit(A.ICF1));
              avr.cpu.sreg.I = interrupts;
              sleep(avr, mode);
              avr.comparator.setInput("ain0", sense === 2 ? 0 : 2);
              if (completed) avr.comparator.setInput("ain0", sense === 2 ? 2 : 0);
              expect(flag(avr)).toBe(0);
              expect(avr.comparator.readOutput()).toBe(sense === 2);
              avr.runCycles(5);
              expect(avr.cpu.isSleeping).toBe(true);
              expect(avr.cpu.data[A.TIFR1]! & bit(A.ICF1)).toBe(0);
              const restored = A.AVR().restore(avr.snapshot());
              for (const chip of [avr, restored]) {
                chip.cpu.writeData(A.PCMSK0, 1);
                chip.cpu.writeData(A.PCICR, 1);
                chip.pin(8).setInput(true);
                chip.cpu.tick();
                expect(chip.cpu.isSleeping).toBe(false);
                expect(flag(chip)).toBe(completed ? 0 : bit(A.ACI));
                expect(chip.cpu.data[A.TIFR1]! & bit(A.ICF1)).toBe(completed ? 0 : bit(A.ICF1));
              }
            });
          }
        }
      }
    }
  });
}
