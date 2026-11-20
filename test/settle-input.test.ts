import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import {
  DDRD,
  EICRA,
  EIFR,
  EIMSK,
  INT0,
  INTF0,
  ISC00,
  ISC01,
  PCICR,
  PCIE2,
  PCIF2,
  PCIFR,
  PCMSK2,
  PORTD,
} from "../src/cpu";

/**
 * A host that samples its circuit lazily learns some input levels late. `settleInput`
 * hands the chip such a level as one it has held all along: no edge, no flag. The next
 * change is an edge as usual.
 */
function int0Rising(synchronized: boolean) {
  const avr = AVR();
  if (synchronized) avr.gpio.useInterruptSynchronization();
  avr.cpu.writeData(DDRD, 0);
  avr.cpu.writeData(EICRA, (1 << ISC01) | (1 << ISC00));
  avr.cpu.writeData(EIMSK, 1 << INT0);
  return avr;
}
const intf0 = (avr: ReturnType<typeof AVR>) => avr.cpu.readData(EIFR) & (1 << INTF0);

describe("settleInput", () => {
  for (const synchronized of [false, true]) {
    test(`a settled high on INT0 is no rising edge (synchronizer ${synchronized ? "on" : "off"})`, () => {
      const avr = int0Rising(synchronized);
      avr.pin(2).settleInput(true);
      avr.runCycles(8);
      expect(avr.pin(2).read()).toBe(true);
      expect(intf0(avr)).toBe(0);
      // The next real edge still counts.
      avr.pin(2).setInput(false);
      avr.runCycles(8);
      avr.pin(2).setInput(true);
      avr.runCycles(8);
      expect(intf0(avr)).toBe(1 << INTF0);
    });
  }

  test("a sample still in the synchronizer takes the settled level", () => {
    const avr = int0Rising(true);
    // A touch on port D starts a synchronizer sample of the old (low) level...
    avr.cpu.writeData(PORTD, 0x01);
    // ...which must not make the settled high look like an edge afterwards.
    avr.pin(2).settleInput(true);
    avr.runCycles(8);
    expect(intf0(avr)).toBe(0);
  });

  test("a settled pin-change input raises no PCIF; its next change does", () => {
    const avr = AVR();
    avr.cpu.writeData(DDRD, 0);
    avr.cpu.writeData(PCMSK2, 1 << 4);
    avr.cpu.writeData(PCICR, 1 << PCIE2);
    avr.pin(4).settleInput(true);
    expect(avr.cpu.readData(PCIFR) & (1 << PCIF2)).toBe(0);
    avr.pin(4).setInput(false);
    expect(avr.cpu.readData(PCIFR) & (1 << PCIF2)).toBe(1 << PCIF2);
  });

  test("settling the input of an output pin leaves its driven level as the baseline", () => {
    const avr = AVR();
    avr.cpu.writeData(DDRD, 1 << 4);
    avr.cpu.writeData(PORTD, 1 << 4);
    avr.cpu.writeData(PCMSK2, 1 << 4);
    avr.cpu.writeData(PCICR, 1 << PCIE2);
    avr.pin(4).settleInput(false);
    // Turning the pin into an input now shows the low input: a real change.
    avr.cpu.writeData(DDRD, 0);
    avr.cpu.writeData(PORTD, 0);
    expect(avr.cpu.readData(PCIFR) & (1 << PCIF2)).toBe(1 << PCIF2);
  });
});
