import { describe, expect, test } from "bun:test";
import * as A from "../src";

const bit = (n: number) => 1 << n;
type Avr = ReturnType<typeof A.AVR>;
const pending = (avr: Avr) => avr.snapshot().cpu.pendingInterrupts;
const restored = (avr: Avr, restore: boolean) => restore ? A.AVR().restore(avr.snapshot()) : avr;

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: peripheral state transitions`, () => {
    for (const restore of [false, true]) {
      const path = restore ? "restored" : "direct";
      for (const source of ["RX", "UDRE", "TX"] as const) {
        test(`${path}: USART ${source} request follows its enable and live flag with I clear`, () => {
          const avr = A.AVR({ timing });
          const mask = source === "RX" ? A.RXCIE0 : source === "UDRE" ? A.UDRIE0 : A.TXCIE0;
          const vector = source === "RX" ? A.USART_RX_VECTOR : source === "UDRE" ? A.USART_UDRE_VECTOR : A.USART_TX_VECTOR;
          const control = bit(A.RXEN0) | bit(A.TXEN0);
          avr.cpu.writeData(A.UCSR0B, control | bit(mask));
          if (source === "RX") { avr.serial.write("R"); avr.runCycles(176); }
          if (source === "TX") { avr.cpu.writeData(A.UDR0, 0x54); avr.runCycles(176); }
          expect(pending(avr)).toContain(vector);
          const target = restored(avr, restore);
          target.cpu.writeData(A.UCSR0B, control);
          expect(pending(target)).not.toContain(vector);
          target.cpu.writeData(A.UCSR0B, control | bit(mask));
          expect(pending(target)).toContain(vector);
          if (source === "RX") target.cpu.readData(A.UDR0);
          if (source === "UDRE") { target.cpu.writeData(A.UDR0, 1); target.cpu.writeData(A.UDR0, 2); }
          if (source === "TX") target.cpu.writeData(A.UCSR0A, bit(A.TXC0));
          expect(pending(target)).not.toContain(vector);
        });
      }

      for (const source of ["EEPROM", "SPM"] as const) {
        test(`${path}: ${source} ready request persists until its enable is cleared`, () => {
          const avr = A.AVR({ timing });
          const addr = source === "EEPROM" ? A.EECR : A.SPMCSR;
          const mask = source === "EEPROM" ? A.EERIE : A.SPMIE;
          const vector = source === "EEPROM" ? A.EE_READY_VECTOR : A.SPM_READY_VECTOR;
          avr.cpu.writeData(addr, bit(mask));
          expect(pending(avr)).toContain(vector);
          const target = restored(avr, restore);
          target.cpu.flash[vector] = 0x9518; // RETI
          target.cpu.sreg.I = true;
          target.step();
          expect(target.cpu.pc).toBe(vector);
          expect(pending(target)).toContain(vector);
          target.step(); // RETI; the next instruction must execute before another ISR.
          target.step();
          expect(target.cpu.pc).toBe(vector);
          target.cpu.writeData(addr, 0);
          expect(pending(target)).not.toContain(vector);
        });
      }

      for (const source of ["RX", "UDRE"] as const) {
        test(`${path}: USART ${source} remains a level request with PRR clock gating`, () => {
          const avr = A.AVR({ timing });
          const mask = source === "RX" ? A.RXCIE0 : A.UDRIE0;
          const vector = source === "RX" ? A.USART_RX_VECTOR : A.USART_UDRE_VECTOR;
          avr.cpu.writeData(A.UCSR0B, bit(A.RXEN0) | bit(mask));
          if (source === "RX") { avr.serial.write("A"); avr.runCycles(176); }
          avr.cpu.writeData(A.PRR, bit(A.PRUSART0));
          const target = restored(avr, restore);
          target.cpu.flash[vector] = 0x9518;
          target.cpu.sreg.I = true;
          target.step();
          expect(target.cpu.pc).toBe(vector);
          expect(pending(target)).toContain(vector);
          target.step();
          target.step();
          expect(target.cpu.pc).toBe(vector);
          target.cpu.writeData(A.UCSR0B, 0);
          expect(pending(target)).not.toContain(vector);
        });
      }

      for (const source of ["SPI", "USART", "ADC"] as const) {
        test(`${path}: power-down freezes ${source}, wake resumes it, and PRR stays independent`, () => {
          const avr = A.AVR({ timing });
          const flagAddr = source === "SPI" ? A.SPSR : source === "USART" ? A.UCSR0A : A.ADCSRA;
          const flagBit = source === "SPI" ? A.SPIF : source === "USART" ? A.TXC0 : A.ADIF;
          const prBit = source === "SPI" ? A.PRSPI : source === "USART" ? A.PRUSART0 : A.PRADC;
          const duration = source === "SPI" ? 32 : source === "USART" ? 176 : 50;
          if (source === "SPI") {
            avr.cpu.writeData(A.DDRB, bit(2));
            avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR));
            avr.cpu.writeData(A.SPDR, 0x11);
          } else if (source === "USART") {
            avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0));
            avr.cpu.writeData(A.UDR0, 0x11);
          } else {
            avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
          }
          avr.runCycles(5);
          avr.cpu.writeData(A.PCMSK2, bit(0));
          avr.cpu.writeData(A.PCICR, bit(2));
          avr.cpu.writeData(A.SMCR, bit(A.SE) | (2 << A.SM0));
          avr.cpu.sleep();
          const target = restored(avr, restore);
          target.runCycles(200);
          expect(target.cpu.readData(flagAddr) & bit(flagBit)).toBe(0);
          target.cpu.writeData(A.PRR, bit(prBit));
          target.pin(0).setInput(true);
          target.step(); // Wake with I clear, preserving the flag and PRR.
          expect(target.cpu.isSleeping).toBe(false);
          target.runCycles(200);
          expect(target.cpu.readData(flagAddr) & bit(flagBit)).toBe(0);
          target.cpu.writeData(A.PRR, 0);
          target.runCycles(duration - 6);
          expect(target.cpu.readData(flagAddr) & bit(flagBit)).toBe(0);
          target.runCycles(1);
          expect(target.cpu.readData(flagAddr) & bit(flagBit)).toBe(bit(flagBit));
        });
      }

      test(`${path}: SPI disable aborts the in-flight transfer`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.writeData(A.DDRB, bit(2));
        avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | bit(A.SPIE));
        avr.cpu.writeData(A.SPDR, 0x55);
        avr.runCycles(5);
        const target = restored(avr, restore);
        const emitted: number[] = [];
        target.spi.onByte((byte) => emitted.push(byte));
        target.cpu.writeData(A.SPCR, 0);
        target.runCycles(40);
        expect(emitted).toEqual([]);
        expect(target.cpu.readData(A.SPSR) & bit(A.SPIF)).toBe(0);
        expect(pending(target)).not.toContain(A.SPI_STC_VECTOR);
        target.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR));
        target.cpu.writeData(A.SPDR, 0x42);
        target.runCycles(32);
        expect(emitted).toEqual([0x42]);
      });

      test(`${path}: SPI transmit preload preserves the separate receive buffer`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.writeData(A.SPCR, bit(A.SPE));
        avr.cpu.writeData(A.SPDR, 0x12);
        expect(avr.spi.master().transfer(0xab)).toBe(0x12);
        avr.runCycles(32);
        const target = restored(avr, restore);
        target.cpu.writeData(A.SPDR, 0x34);
        expect(target.cpu.readData(A.SPDR)).toBe(0xab);
        expect(target.spi.master().transfer(0xcd)).toBe(0x34);
        target.runCycles(32);
        expect(target.cpu.readData(A.SPDR)).toBe(0xcd);
      });

      test(`${path}: EEPROM master-write enable expires and invalid writes stay idle`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.writeData(A.EEDR, 0xaa);
        avr.cpu.writeData(A.EECR, bit(A.EEMPE));
        avr.runCycles(2);
        const target = restored(avr, restore);
        target.runCycles(2);
        expect(target.cpu.readData(A.EECR) & bit(A.EEMPE)).toBe(0);
        target.cpu.writeData(A.EECR, bit(A.EEPE));
        expect(target.eeprom.read(0)).toBe(0);
        expect(target.cpu.readData(A.EECR) & bit(A.EEPE)).toBe(0);
        target.cpu.writeData(A.EECR, bit(A.EEMPE));
        target.cpu.writeData(A.EECR, bit(A.EEPE));
        expect(target.eeprom.read(0)).toBe(0xaa);
      });

      test(`${path}: watchdog WDIF writes preserve elapsed timeout`, () => {
        const avr = A.AVR({ timing, clockHz: 1000 });
        avr.cpu.writeData(A.WDTCSR, bit(A.WDIE));
        avr.runCycles(8);
        const target = restored(avr, restore);
        target.cpu.writeData(A.WDTCSR, bit(A.WDIE) | bit(A.WDIF));
        target.runCycles(8);
        expect(target.cpu.readData(A.WDTCSR) & bit(A.WDIF)).toBe(bit(A.WDIF));
      });

      test(`${path}: watchdog protected configuration window survives restore`, () => {
        const avr = A.AVR({ timing, clockHz: 1000 });
        avr.cpu.writeData(A.WDTCSR, bit(A.WDIE) | bit(A.WDE) | bit(A.WDCE));
        avr.runCycles(2);
        const target = restored(avr, restore);
        target.cpu.writeData(A.WDTCSR, bit(A.WDIE) | bit(A.WDP0));
        expect(target.cpu.readData(A.WDTCSR) & (bit(A.WDE) | bit(A.WDP0))).toBe(bit(A.WDP0));
        target.runCycles(31);
        expect(target.cpu.readData(A.WDTCSR) & bit(A.WDIF)).toBe(0);
        target.runCycles(1);
        expect(target.cpu.readData(A.WDTCSR) & bit(A.WDIF)).toBe(bit(A.WDIF));
      });
    }

    test("USART TXC remains set when a new byte is written until explicitly acknowledged", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0) | bit(A.TXCIE0));
      avr.cpu.writeData(A.UDR0, 0x11);
      avr.runCycles(176);
      avr.cpu.writeData(A.UDR0, 0x22);
      expect(avr.cpu.readData(A.UCSR0A) & bit(A.TXC0)).toBe(bit(A.TXC0));
      expect(pending(avr)).toContain(A.USART_TX_VECTOR);
    });

    test("GPIO input injection and snapshot preserve other pins' externally driven values", () => {
      const avr = A.AVR({ timing });
      avr.pin(8).setInput(false);
      avr.cpu.writeData(A.PORTB, bit(0));
      avr.cpu.writeData(A.DDRB, bit(0));
      avr.pin(9).setInput(true);
      const target = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, target]) {
        chip.cpu.writeData(A.DDRB, 0);
        expect(chip.pin(8).read()).toBe(false);
        expect(chip.pin(9).read()).toBe(true);
      }
    });

    test("restoring GPIO updates listeners without creating PCINT or capture flags", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.PCMSK0, bit(0));
      avr.cpu.writeData(A.PCICR, bit(0));
      avr.cpu.writeData(A.TCCR1B, bit(A.ICES1));
      avr.pin(8).setInput(true);
      avr.cpu.writeData(A.PCIFR, bit(0));
      avr.cpu.writeData(A.TIFR1, bit(A.ICF1));
      const target = A.AVR({ timing });
      const edges: boolean[] = [];
      target.pin(8).onChange((high) => edges.push(high));
      target.restore(avr.snapshot());
      expect(edges).toEqual([true]);
      expect(target.cpu.readData(A.PCIFR)).toBe(0);
      expect(target.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(0);
      expect(pending(target)).not.toContain(A.PCINT0_VECTOR);
      target.pin(8).setInput(false);
      target.pin(8).setInput(true);
      expect(edges).toEqual([true, false, true]);
      expect(target.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(bit(A.ICF1));
      expect(pending(target)).toContain(A.PCINT0_VECTOR);
    });

    test("SPI slave deselection aborts a partial byte and writes while shifting collide", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.SPCR, bit(A.SPE));
      avr.cpu.writeData(A.SPDR, 0x11);
      avr.spi.master().transfer(0x22);
      avr.runCycles(2);
      avr.cpu.writeData(A.SPDR, 0x33);
      expect(avr.cpu.readData(A.SPSR) & bit(A.WCOL)).toBe(bit(A.WCOL));
      avr.pin(10).setInput(true);
      avr.runCycles(32);
      expect(avr.cpu.readData(A.SPSR) & bit(A.SPIF)).toBe(0);
      avr.pin(10).setInput(false);
      expect(avr.spi.master().transfer(0x44)).toBe(0x11);
      avr.runCycles(32);
      expect(avr.cpu.readData(A.SPDR)).toBe(0x44);
    });

    test("SPI detects an already-low input SS on enable and a switch from output SS to input", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | bit(A.SPIE));
      expect(avr.cpu.readData(A.SPCR) & bit(A.MSTR)).toBe(0);
      expect(avr.cpu.readData(A.SPSR) & bit(A.SPIF)).toBe(bit(A.SPIF));
      expect(pending(avr)).toContain(A.SPI_STC_VECTOR);
      avr.cpu.readData(A.SPSR);
      avr.cpu.readData(A.SPDR);
      avr.cpu.writeData(A.DDRB, bit(2));
      avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | bit(A.SPIE));
      avr.cpu.writeData(A.SPDR, 0x12);
      avr.runCycles(2);
      avr.cpu.writeData(A.DDRB, 0); // Same low effective level, but now SS is an input.
      expect(avr.cpu.readData(A.SPCR) & bit(A.MSTR)).toBe(0);
      avr.cpu.readData(A.SPSR);
      avr.cpu.readData(A.SPDR);
      avr.runCycles(32);
      expect(avr.cpu.readData(A.SPSR) & bit(A.SPIF)).toBe(0);
    });

    test("SPI slave SS remains an external input even when DDB2 is set", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.DDRB, bit(2));
      avr.cpu.writeData(A.PORTB, bit(2));
      avr.cpu.writeData(A.SPCR, bit(A.SPE));
      avr.cpu.writeData(A.SPDR, 0x12);
      expect(avr.spi.master().transfer(0xab)).toBe(0x12);
      avr.pin(10).setInput(true);
      avr.runCycles(32);
      expect(avr.cpu.readData(A.SPSR) & bit(A.SPIF)).toBe(0);
      expect(() => avr.spi.master().transfer(0xcd)).toThrow("SS/PB2 low");
    });

    test("TWI status is read-only and rejected TWDR writes set a hardware-owned collision flag", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.TWSR, 0x03);
      expect(avr.cpu.readData(A.TWSR)).toBe(0xfb);
      avr.cpu.writeData(A.TWCR, bit(A.TWEN) | bit(A.TWSTA) | bit(A.TWINT));
      avr.cpu.writeData(A.TWDR, 0xaa);
      expect(avr.cpu.readData(A.TWDR)).toBe(0);
      expect(avr.cpu.readData(A.TWCR) & bit(A.TWWC)).toBe(bit(A.TWWC));
      avr.cpu.writeData(A.TWCR, bit(A.TWEN));
      expect(avr.cpu.readData(A.TWCR) & bit(A.TWWC)).toBe(bit(A.TWWC));
      avr.runCycles(1);
      avr.cpu.writeData(A.TWDR, 0x55);
      expect(avr.cpu.readData(A.TWDR)).toBe(0x55);
      expect(avr.cpu.readData(A.TWCR) & bit(A.TWWC)).toBe(0);
      avr.cpu.writeData(A.TWCR, bit(A.TWEN) | bit(A.TWWC));
      expect(avr.cpu.readData(A.TWCR) & bit(A.TWWC)).toBe(0);
    });

    test("EEPROM erase-only and write-only modes preserve their bit programming semantics", () => {
      const avr = A.AVR({ timing });
      avr.eeprom.write(0, 0xf0);
      avr.cpu.writeData(A.EEDR, 0x5a);
      const write = (mode: number) => {
        avr.cpu.writeData(A.EECR, (mode << 4) | bit(A.EEMPE));
        avr.cpu.writeData(A.EECR, (mode << 4) | bit(A.EEPE));
      };
      write(2);
      expect(avr.eeprom.read(0)).toBe(0x50);
      write(1);
      expect(avr.eeprom.read(0)).toBe(0xff);
      write(0);
      expect(avr.eeprom.read(0)).toBe(0x5a);
    });

    test("EEPROM ready requests are suppressed during an SPM command", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.EECR, bit(A.EERIE));
      expect(pending(avr)).toContain(A.EE_READY_VECTOR);
      avr.cpu.writeData(A.SPMCSR, bit(A.SELFPRGEN));
      expect(pending(avr)).not.toContain(A.EE_READY_VECTOR);
      avr.runCycles(4);
      expect(pending(avr)).toContain(A.EE_READY_VECTOR);
    });

    test("watchdog rejects protected changes without WDCE and closes its window after four cycles", () => {
      const avr = A.AVR({ timing, clockHz: 1000 });
      avr.cpu.writeData(A.WDTCSR, bit(A.WDE) | bit(A.WDP0));
      expect(avr.cpu.readData(A.WDTCSR) & bit(A.WDP0)).toBe(0);
      avr.cpu.writeData(A.WDTCSR, 0);
      expect(avr.cpu.readData(A.WDTCSR) & bit(A.WDE)).toBe(bit(A.WDE));
      avr.cpu.writeData(A.WDTCSR, bit(A.WDE) | bit(A.WDCE));
      avr.runCycles(4);
      expect(avr.cpu.readData(A.WDTCSR) & bit(A.WDCE)).toBe(0);
      avr.cpu.writeData(A.WDTCSR, 0);
      expect(avr.cpu.readData(A.WDTCSR) & bit(A.WDE)).toBe(bit(A.WDE));
    });

    test("changing CLKPR preserves the watchdog's remaining wall-clock time", () => {
      const avr = A.AVR({ timing, clockHz: 1000 });
      avr.cpu.writeData(A.WDTCSR, bit(A.WDIE));
      avr.runCycles(8);
      avr.cpu.writeData(A.CLKPR, bit(A.CLKPCE));
      avr.cpu.writeData(A.CLKPR, 1);
      avr.runCycles(4);
      expect(avr.cpu.readData(A.WDTCSR) & bit(A.WDIF)).toBe(bit(A.WDIF));
    });

    test("Timer1 noise canceler rejects pulses shorter than four stable clock cycles", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.TCCR1B, bit(A.ICES1) | bit(A.ICNC1) | 1);
      avr.pin(8).setInput(true);
      avr.runCycles(2);
      avr.pin(8).setInput(false);
      avr.runCycles(4);
      expect(avr.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(0);
      avr.pin(8).setInput(true);
      avr.runCycles(4);
      expect(avr.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(bit(A.ICF1));
      expect(avr.cpu.readData(A.ICR1L)).toBe(10);
    });

    test("Timer1 capture is disabled while ICR1 defines TOP", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
      avr.cpu.writeData(A.ICR1L, 0x80);
      avr.cpu.writeData(A.TCCR1B, bit(A.ICES1) | bit(A.WGM13) | bit(A.WGM12) | 1); // WGM 12
      avr.pin(8).setInput(true);
      expect(avr.cpu.readData(A.ICR1L)).toBe(0x80);
      expect(avr.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(0);
    });

    test("Timer1 filter rejects a short opposite-level glitch without manufacturing another capture", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.TCCR1B, bit(A.ICES1) | bit(A.ICNC1) | 1);
      avr.pin(8).setInput(true);
      avr.runCycles(4);
      avr.cpu.writeData(A.TIFR1, bit(A.ICF1));
      avr.pin(8).setInput(false);
      avr.runCycles(2);
      avr.pin(8).setInput(true);
      avr.runCycles(4);
      expect(avr.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(0);
      avr.pin(8).setInput(false);
      avr.runCycles(4);
      const target = A.AVR().restore(avr.snapshot());
      target.pin(8).setInput(true);
      target.runCycles(4);
      expect(target.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(bit(A.ICF1));
    });

    test("Timer1 input filtering retains its remaining clocks across PRR and restore", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.TCCR1B, bit(A.ICES1) | bit(A.ICNC1) | 1);
      avr.pin(8).setInput(true);
      avr.runCycles(2);
      avr.cpu.writeData(A.PRR, bit(A.PRTIM1));
      const target = A.AVR().restore(avr.snapshot());
      target.runCycles(20);
      expect(target.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(0);
      target.cpu.writeData(A.PRR, 0);
      target.runCycles(1);
      expect(target.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(0);
      target.runCycles(1);
      expect(target.cpu.readData(A.TIFR1) & bit(A.ICF1)).toBe(bit(A.ICF1));
      expect(target.cpu.readData(A.ICR1L)).toBe(4);
    });

    test("ADC noise-reduction sleep keeps asynchronous Timer2 clocked", () => {
      const avr = A.AVR({ timing, clockHz: 32768 });
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.cpu.writeData(A.TCCR2B, 1);
      avr.runCycles(2);
      const before = avr.cpu.readData(A.TCNT2);
      avr.cpu.writeData(A.SMCR, bit(A.SE) | (1 << A.SM0));
      avr.cpu.sleep();
      avr.runCycles(10);
      expect(avr.cpu.readData(A.TCNT2)).toBe((before + 10) & 0xff);
    });

    test("Timer2 async time and update-busy windows follow CLKPR and retain fractional phase on restore", () => {
      const avr = A.AVR({ timing, clockHz: 65536 });
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.cpu.writeData(A.TCCR2B, 1);
      avr.runCycles(1); // Half a TOSC period, with TCR2BUB still set.
      expect(avr.cpu.readData(A.TCNT2)).toBe(0);
      const target = A.AVR().restore(avr.snapshot());
      expect(target.cpu.readData(A.ASSR) & bit(A.TCR2BUB)).toBe(bit(A.TCR2BUB));
      target.cpu.writeData(A.CLKPR, bit(A.CLKPCE));
      target.cpu.writeData(A.CLKPR, 1);
      target.runCycles(1);
      expect(target.cpu.readData(A.TCNT2)).toBe(1);
      expect(target.cpu.readData(A.ASSR) & bit(A.TCR2BUB)).toBe(0);
      target.runCycles(4);
      expect(target.cpu.readData(A.TCNT2)).toBe(5);
    });

    test("external ADC triggering uses its synchronized sample-and-hold and completion deadlines", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADSC));
      avr.runCycles(50);
      avr.cpu.writeData(A.ADCSRB, 2); // INT0
      avr.cpu.writeData(A.EICRA, 3);
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE) | bit(A.ADIF));
      avr.analog(0).setValue(100);
      avr.pin(2).setInput(true);
      avr.runCycles(6);
      avr.analog(0).setValue(200);
      avr.runCycles(1); // Three sync cycles + two ADC clocks at /2.
      const target = A.AVR().restore(avr.snapshot());
      target.analog(0).setValue(900);
      target.runCycles(22);
      expect(target.cpu.readData(A.ADCSRA) & bit(A.ADIF)).toBe(0);
      target.runCycles(1); // 13.5 ADC clocks + three sync cycles = 30 CPU clocks.
      expect(target.cpu.readData(A.ADCL) | (target.cpu.readData(A.ADCH) << 8)).toBe(200);
      expect(target.cpu.readData(A.ADCSRA) & bit(A.ADIF)).toBe(bit(A.ADIF));
    });

    test("Timer1 PWM duty stays within its range when OCR exceeds a dynamic TOP", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12));
      avr.cpu.writeData(A.ICR1L, 100);
      avr.cpu.writeData(A.OCR1BL, 150);
      avr.cpu.writeData(A.TCCR1B, bit(A.WGM13) | bit(A.WGM12) | 1);
      avr.cpu.writeData(A.TCCR1A, bit(A.WGM11) | bit(A.COM1B1));
      expect(avr.pwm(10).read().duty).toBe(1);
      avr.cpu.writeData(A.TCCR1A, bit(A.WGM11) | bit(A.COM1B1) | bit(A.COM1B0));
      expect(avr.pwm(10).read().duty).toBe(0);
    });

    test("ADC sees a Timer0 trigger even when the timer ISR acknowledges it in the same instruction", () => {
      const avr = A.AVR({ timing });
      avr.analog(0).setValue(321);
      avr.cpu.writeData(A.ADCSRB, 3); // Timer0 COMPA
      avr.cpu.writeData(A.ADCSRA, bit(A.ADEN) | bit(A.ADATE));
      avr.cpu.writeData(A.OCR0A, 1);
      avr.cpu.writeData(A.TIMSK0, bit(A.OCIE0A));
      avr.cpu.writeData(A.TCCR0B, 1);
      avr.cpu.sreg.I = true;
      avr.step();
      expect(avr.cpu.pc).toBe(1);
      avr.step();
      expect(avr.cpu.pc).toBe(A.TIMER0_COMPA_VECTOR);
      expect(avr.cpu.readData(A.TIFR0) & bit(A.OCF0A)).toBe(0);
      expect(avr.cpu.readData(A.ADCSRA) & bit(A.ADSC)).toBe(bit(A.ADSC));
      avr.cpu.sreg.I = false;
      avr.cpu.writeData(A.TCCR0B, 0);
      avr.runCycles(60);
      expect(avr.cpu.readData(A.ADCL) | (avr.cpu.readData(A.ADCH) << 8)).toBe(321);
    });

    test("an enabled pin interrupt wakes sleeping code with global I clear without entering its ISR", () => {
      const avr = A.AVR({ timing });
      avr.cpu.writeData(A.PCMSK0, bit(0));
      avr.cpu.writeData(A.PCICR, bit(0));
      avr.cpu.writeData(A.SMCR, bit(A.SE) | (2 << A.SM0));
      avr.cpu.sleep();
      avr.pin(8).setInput(true);
      avr.step();
      expect(avr.cpu.isSleeping).toBe(false);
      expect(avr.cpu.pc).toBe(0);
      expect(avr.cpu.sreg.I).toBe(false);
      expect(pending(avr)).toContain(A.PCINT0_VECTOR);
      avr.cpu.sreg.I = true;
      avr.step();
      expect(avr.cpu.pc).toBe(A.PCINT0_VECTOR);
    });
  });
}
