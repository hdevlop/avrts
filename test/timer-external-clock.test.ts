import { expect, test } from "bun:test";
import { AVR } from "../src";
import * as R from "../src/cpu";

const bit = (n: number) => 1 << n;
for (const timing of ["fast", "cycle-exact"] as const) {
  for (const timer of [0, 1] as const) {
    const pin = timer + 4;
    const control = timer === 0 ? R.TCCR0B : R.TCCR1B;
    const low = timer === 0 ? R.TCNT0 : R.TCNT1L;
    const high = timer === 0 ? undefined : R.TCNT1H;
    const flags = timer === 0 ? R.TIFR0 : R.TIFR1;
    const count = (avr: ReturnType<typeof AVR>) => avr.cpu.readData(low) | (high === undefined ? 0 : avr.cpu.readData(high) << 8);
    for (const select of [6, 7]) {
      test(`${timing}: Timer${timer} selects only the external ${select === 7 ? "rising" : "falling"} edges`, () => {
        const avr = AVR({ timing });
        avr.cpu.flash.fill(0);
        avr.cpu.writeData(control, select);
        avr.pin(pin).setInput(true);
        avr.runCycles(2);
        expect(count(avr)).toBe(0);
        avr.runCycles(1);
        expect(count(avr)).toBe(select === 7 ? 1 : 0);
        avr.pin(pin).setInput(false);
        avr.runCycles(3);
        expect(count(avr)).toBe(1);
        avr.runCycles(500);
        expect(count(avr)).toBe(1); // No internal clock in external mode.
      });
    }
    test(`${timing}: Timer${timer} rejects an unsampled pulse and resumes a pending synchronized edge exactly once`, () => {
      const avr = AVR({ timing });
      avr.cpu.flash.fill(0); avr.cpu.writeData(control, 7);
      avr.pin(pin).setInput(true); avr.pin(pin).setInput(false); avr.runCycles(4);
      expect(count(avr)).toBe(0);
      avr.pin(pin).setInput(true); avr.runCycles(1);
      const resumed = AVR({ timing }).restore(avr.snapshot());
      for (const runtime of [avr, resumed]) {
        runtime.runCycles(1); expect(count(runtime)).toBe(0);
        runtime.runCycles(1); expect(count(runtime)).toBe(1);
        runtime.runCycles(100); expect(count(runtime)).toBe(1);
      }
    });
    test(`${timing}: Timer${timer} external rollover and compare flags use the timer counter path`, () => {
      const avr = AVR({ timing });
      avr.cpu.flash.fill(0);
      if (high !== undefined) avr.cpu.writeData(high, 255);
      avr.cpu.writeData(low, 255);
      avr.cpu.writeData(control, 7);
      avr.pin(pin).setInput(true); avr.runCycles(3);
      expect(count(avr)).toBe(0);
      expect(avr.cpu.readData(flags) & 1).toBe(1);
      avr.pin(pin).setInput(false); avr.runCycles(3);
      avr.pin(pin).setInput(true); avr.runCycles(3);
      expect(avr.cpu.readData(flags) & 2).toBe(2); // Compare OCR A = 0 on next tick.
    });
    test(`${timing}: Timer${timer} PRR, sleep and clock mux switches discard disabled-domain edges`, () => {
      const avr = AVR({ timing });
      avr.cpu.flash.fill(0); avr.cpu.writeData(control, 7);
      const powerBit = timer === 0 ? R.PRTIM0 : R.PRTIM1;
      avr.cpu.writeData(R.PRR, bit(powerBit));
      avr.pin(pin).setInput(true); avr.runCycles(4);
      expect(count(avr)).toBe(0);
      avr.cpu.writeData(R.PRR, 0); avr.runCycles(4);
      expect(count(avr)).toBe(0); // Held level does not create an enable edge.
      avr.pin(pin).setInput(false); avr.runCycles(3);
      avr.cpu.writeData(R.SMCR, bit(R.SE) | (2 << 1)); avr.cpu.sleep();
      avr.pin(pin).setInput(true); avr.runCycles(4); expect(count(avr)).toBe(0);
      avr.cpu.wakeForPeripheral(); avr.runCycles(4); expect(count(avr)).toBe(0);
      avr.cpu.writeData(control, 1); avr.runCycles(5); expect(count(avr)).toBe(5);
      avr.cpu.writeData(control, 7); avr.runCycles(10); expect(count(avr)).toBe(5);
    });
    test(`${timing}: Timer${timer} firmware output changes can supply external clocks and divider changes preserve the pipeline`, () => {
      const avr = AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(R.DDRD, bit(pin));
      avr.cpu.writeData(control, 7);
      avr.cpu.writeData(R.PORTD, bit(pin));
      avr.runCycles(1); avr.useClock(8_000_000);
      avr.runCycles(2); expect(count(avr)).toBe(1);
      avr.resetExternal(); avr.runCycles(5); expect(count(avr)).toBe(0);
    });
  }
}
