import { expect, test } from "bun:test";
import * as A from "../src";

for (const timing of ["fast", "cycle-exact"] as const) {
  for (const path of ["handler", "generated", "profiled"] as const) {
    test(`${timing}/${path}: SBI and CBI address only one bit in GPIO and W1C registers`, () => {
      const avr = A.AVR({ timing });
      const cpu = avr.cpu;
      const execute = (set: boolean, address: number, bit: number) => {
        cpu.flash[0] = (set ? 0x9a00 : 0x9800) | ((address - 0x20) << 3) | bit;
        cpu.invalidateDecodeCache();
        cpu.pc = 0;
        const before = cpu.cycles;
        if (path === "handler") cpu.tick();
        else if (path === "generated") cpu.run(2);
        else cpu.profileRun(2, () => {});
        expect(cpu.cycles - before).toBe(2);
        expect(cpu.pc).toBe(1);
      };

      for (const [pin, ddr, port] of [[A.PINB, A.DDRB, A.PORTB], [A.PINC, A.DDRC, A.PORTC], [A.PIND, A.DDRD, A.PORTD]]) {
        cpu.writeData(ddr!, 0x3f);
        cpu.writeData(port!, 1);
        execute(true, pin!, 5);
        expect(cpu.data[port!]).toBe(0x21);
        execute(false, pin!, 5);
        expect(cpu.data[port!]).toBe(0x21);
        execute(false, port!, 5);
        expect(cpu.data[port!]).toBe(1);
        execute(true, port!, 5);
        expect(cpu.data[port!]).toBe(0x21);
        cpu.writeData(pin!, 0x21); // Ordinary full-byte writes still toggle both bits.
        expect(cpu.data[port!]).toBe(0);
      }

      cpu.writeData(A.EICRA, 0x0f); // Edge flags, rather than level-sensitive INT pins.
      for (const [address, pending] of [[A.TIFR0, 7], [A.TIFR1, 0x27], [A.TIFR2, 7], [A.EIFR, 3], [A.PCIFR, 7]]) {
        cpu.data[address!] = pending!;
        execute(true, address!, 0);
        expect(cpu.data[address!]).toBe(pending! & ~1);
        execute(false, address!, 1);
        expect(cpu.data[address!]).toBe(pending! & ~1);
        cpu.writeData(address!, pending!);
        expect(cpu.data[address!]).toBe(0);
      }

      execute(true, A.EECR, A.EEMPE);
      expect(cpu.data[A.EECR]! & (1 << A.EEMPE)).toBe(1 << A.EEMPE);
      execute(true, A.EECR, A.EERIE); // Touching another bit must not reopen the write window.
      expect(cpu.data[A.EECR]! & (1 << A.EEMPE)).toBe(0);
      expect(avr.snapshot().eeprom.masterWriteCycle).toBe(-1);
    });
  }
}
