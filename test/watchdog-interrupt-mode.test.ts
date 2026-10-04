import { describe, expect, test } from "bun:test";
import { AVR, WDTCSR, WDT_VECTOR, WDIE, WDIF, WDE, MCUSR, WDRF } from "../src";

function watchdog(control = 1 << WDIE) {
  const avr = AVR({ clockHz: 1000 });
  avr.cpu.flash[0] = 0xcfff; // RJMP self
  avr.cpu.flash[WDT_VECTOR] = 0x9518; // RETI
  avr.cpu.writeData(WDTCSR, control);
  return avr;
}

describe("watchdog interrupt mode", () => {
  test("interrupt-only mode fires repeatedly without rearming WDIE", () => {
    const avr = watchdog();
    avr.cpu.sreg.I = true;
    let interrupts = 0;
    avr.cpu.onTrace((state) => { if (state.pc === WDT_VECTOR) interrupts++; });
    avr.runFor(60); // Include the RETI following the third 16 ms timeout.
    expect(interrupts).toBe(3);
    expect(avr.cpu.readData(WDTCSR) & (1 << WDIE)).toBe(1 << WDIE);
    expect(avr.cpu.readData(WDTCSR) & (1 << WDIF)).toBe(0);
  });

  for (const combined of [false, true]) {
    test(`${combined ? "combined" : "interrupt-only"}: timeout latches WDIF until restored interrupt is acknowledged`, () => {
      const avr = watchdog((1 << WDIE) | (combined ? 1 << WDE : 0));
      avr.runFor(16); // Global interrupts disabled.
      expect(avr.cpu.readData(WDTCSR) & ((1 << WDIF) | (1 << WDIE))).toBe((1 << WDIF) | (1 << WDIE));
      const restored = AVR().restore(avr.snapshot());
      restored.cpu.sreg.I = true;
      restored.step();
      expect(restored.cpu.pc).toBe(WDT_VECTOR);
      expect(restored.cpu.readData(WDTCSR) & (1 << WDIF)).toBe(0);
      expect(restored.cpu.readData(WDTCSR) & (1 << WDIE)).toBe(combined ? 0 : 1 << WDIE);
    });
  }

  test("writing one to WDIF clears the flag and withdraws the pending interrupt", () => {
    const avr = watchdog();
    avr.runFor(16);
    avr.cpu.writeData(WDTCSR, 1 << WDIE); // A zero preserves WDIF.
    expect(avr.cpu.readData(WDTCSR) & (1 << WDIF)).toBe(1 << WDIF);
    avr.cpu.writeData(WDTCSR, (1 << WDIE) | (1 << WDIF));
    avr.cpu.sreg.I = true;
    avr.step();
    expect(avr.cpu.pc).toBe(0);
    expect(avr.cpu.readData(WDTCSR) & (1 << WDIF)).toBe(0);
  });

  test("combined mode resets at the next timeout after its interrupt", () => {
    const avr = watchdog((1 << WDIE) | (1 << WDE));
    avr.cpu.sreg.I = true;
    avr.runFor(16);
    expect(avr.cpu.readData(WDTCSR) & (1 << WDIE)).toBe(0);
    avr.runFor(16);
    expect(avr.cpu.readData(MCUSR) & (1 << WDRF)).toBe(1 << WDRF);
  });

  test("combined mode resets when its first interrupt remains unserviced", () => {
    const avr = watchdog((1 << WDIE) | (1 << WDE));
    avr.runFor(32);
    expect(avr.cpu.readData(MCUSR) & (1 << WDRF)).toBe(1 << WDRF);
    expect(avr.snapshot().cpu.pendingInterrupts).toEqual([]);
  });
});
