import { describe, expect, test } from "bun:test";
import * as A from "../src";

const bit = (n: number) => 1 << n;

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: USART GPIO frames`, () => {
    for (const size of [5, 6, 7, 8, 9]) for (const parity of [0, 2, 3]) {
      test(`${size} data bits, parity ${parity}: asynchronous loopback`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.flash.fill(0);
        const code = size === 9 ? 7 : size - 5;
        avr.cpu.writeData(A.UCSR0C, ((code & 3) << 1) | (parity << 4));
        avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0) | bit(A.RXEN0) | (size === 9 ? bit(A.UCSZ02) | bit(A.TXB80) : 0));
        avr.serial.useWire();
        avr.pin(0).setInput(true);
        avr.pin(1).onChange((high) => avr.pin(0).setInput(high));
        const bytes: number[] = [];
        avr.serial.onByte((b) => bytes.push(b));
        avr.cpu.writeData(A.UDR0, 0xa6);
        const cycles = (1 + size + (parity ? 1 : 0) + 1) * 16;
        avr.runCycles(cycles);
        expect(bytes).toEqual([0xa6]);
        expect(avr.cpu.readData(A.UCSR0A) & (bit(A.RXC0) | bit(A.FE0) | bit(A.UPE0))) .toBe(bit(A.RXC0));
        expect(avr.cpu.readData(A.UCSR0B) & bit(A.RXB80)).toBe(size === 9 ? bit(A.RXB80) : 0);
        expect(avr.cpu.readData(A.UDR0)).toBe(0xa6 & ((1 << Math.min(size, 8)) - 1));
      });
    }

    test("derives parity/framing errors from sampled RXD and rejects a false start", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.UCSR0B, bit(A.RXEN0));
      avr.cpu.writeData(A.UCSR0C, 6 | (2 << 4));
      avr.serial.useWire();
      avr.pin(0).setInput(true);
      avr.pin(0).setInput(false);
      avr.runCycles(3);
      avr.pin(0).setInput(true);
      avr.runCycles(16);
      expect(avr.cpu.readData(A.UCSR0A) & bit(A.RXC0)).toBe(0);
      const bits = [false, true, false, false, false, false, false, false, false, false, false];
      for (const high of bits) { avr.pin(0).setInput(high); avr.runCycles(16); }
      expect(avr.cpu.readData(A.UCSR0A) & (bit(A.RXC0) | bit(A.FE0) | bit(A.UPE0)))
        .toBe(bit(A.RXC0) | bit(A.FE0) | bit(A.UPE0));
      expect(avr.cpu.readData(A.UDR0)).toBe(1);
    });

    for (const mspim of [false, true]) for (const polarity of [0, 1]) for (const phase of (mspim ? [0, 1] : [0])) {
      test(`${mspim ? "MSPIM" : "synchronous"} XCK loopback, polarity ${polarity}, phase ${phase}`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.flash.fill(0);
        avr.cpu.writeData(A.DDRD, bit(4));
        avr.cpu.writeData(A.UCSR0C, ((mspim ? 3 : 1) << 6) | (mspim ? phase << 1 : 6) | polarity);
        avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0) | bit(A.RXEN0));
        avr.serial.useWire();
        avr.pin(0).setInput(true);
        avr.pin(1).onChange((high) => avr.pin(0).setInput(high));
        avr.cpu.writeData(A.UDR0, 0xa6);
        avr.pin(0).setInput(avr.pin(1).read());
        avr.runCycles(mspim ? 16 : 20);
        expect(avr.cpu.readData(A.UCSR0A) & bit(A.RXC0)).toBe(bit(A.RXC0));
        expect(avr.cpu.readData(A.UDR0)).toBe(0xa6);
        expect(avr.cpu.data[A.UCSR0A]! & bit(A.TXC0)).toBe(bit(A.TXC0));
      });
    }

    test("partial RX/TX survive PRR and snapshot", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0) | bit(A.RXEN0));
      avr.serial.useWire();
      avr.pin(0).setInput(true);
      avr.pin(1).onChange((high) => avr.pin(0).setInput(high));
      avr.cpu.writeData(A.UDR0, 0x69);
      avr.runCycles(37);
      avr.cpu.writeData(A.PRR, bit(A.PRUSART0));
      avr.runCycles(50);
      const restored = A.AVR().restore(avr.snapshot());
      restored.pin(1).onChange((high) => restored.pin(0).setInput(high));
      for (const chip of [avr, restored]) {
        chip.cpu.writeData(A.PRR, 0);
        chip.runCycles(123);
        expect(chip.cpu.readData(A.UDR0)).toBe(0x69);
        expect(chip.cpu.readData(A.UCSR0A) & bit(A.TXC0)).toBe(bit(A.TXC0));
      }
    });

    for (const polarity of [0, 1]) for (const master of [false, true]) {
    test(`synchronous ${master ? "master" : "slave"} changes on leading XCK and samples on trailing, polarity ${polarity}`, () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      const idle = polarity !== 0;
      avr.pin(4).setInput(idle);
      if (master) avr.cpu.writeData(A.DDRD, bit(4));
      avr.cpu.writeData(A.UCSR0C, (1 << 6) | 6 | polarity);
      avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0) | bit(A.RXEN0));
      avr.serial.useWire();
      avr.pin(0).setInput(true);
      avr.cpu.writeData(A.UDR0, 0x69);
      expect(avr.pin(1).read()).toBe(true); // Start waits for the first change edge.
      const incoming = [false, ...Array.from({ length: 8 }, (_, i) => (0xa6 & bit(i)) !== 0), true];
      const outgoing: boolean[] = [];
      for (const high of incoming) {
        avr.pin(0).setInput(!high); // Wrong edge deliberately carries the opposite bit.
        if (!master) avr.pin(4).setInput(!idle);
        avr.runCycles(1);
        expect(avr.pin(4).read()).toBe(!idle);
        outgoing.push(avr.pin(1).read());
        expect(avr.cpu.readData(A.UCSR0A) & bit(A.RXC0)).toBe(0);
        avr.pin(0).setInput(high);
        if (!master) avr.pin(4).setInput(idle);
        avr.runCycles(1);
        expect(avr.pin(4).read()).toBe(idle);
        expect(avr.pin(1).read()).toBe(outgoing.at(-1)!);
      }
      expect(outgoing).toEqual([false, ...Array.from({ length: 8 }, (_, i) => (0x69 & bit(i)) !== 0), true]);
      expect(avr.cpu.readData(A.UDR0)).toBe(0xa6);
      expect(avr.cpu.readData(A.UCSR0A) & bit(A.TXC0)).toBe(bit(A.TXC0));
    });
    }

    test("synchronous buffered frames keep TX stable through trailing edges and snapshot", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.UCSR0C, (1 << 6) | 6);
      avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0));
      avr.serial.useWire();
      avr.cpu.writeData(A.UDR0, 0x69);
      avr.cpu.writeData(A.UDR0, 0xa6);
      const expected = [0x69, 0xa6].flatMap((value) =>
        [false, ...Array.from({ length: 8 }, (_, i) => (value & bit(i)) !== 0), true]);
      for (let i = 0; i < expected.length; i++) {
        avr.pin(4).setInput(true);
        expect(avr.pin(1).read()).toBe(expected[i]!);
        avr.pin(4).setInput(false);
        expect(avr.pin(1).read()).toBe(expected[i]!);
        if (i === 3 || i === 9) {
          avr.restore(avr.snapshot());
          expect(avr.pin(1).read()).toBe(expected[i]!);
          avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0)); // Refresh must retain the driven bit.
          expect(avr.pin(1).read()).toBe(expected[i]!);
        }
      }
      expect(avr.cpu.readData(A.UCSR0A) & bit(A.TXC0)).toBe(bit(A.TXC0));
    });

    test("restore retains a low TXD level and double-speed two-stop-bit buffering", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.UCSR0A, bit(A.U2X0));
      avr.cpu.writeData(A.UCSR0C, 6 | bit(A.USBS0));
      avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0) | bit(A.RXEN0));
      avr.serial.useWire(); avr.pin(0).setInput(true);
      avr.pin(1).onChange((high) => avr.pin(0).setInput(high));
      avr.cpu.writeData(A.UDR0, 0); avr.cpu.writeData(A.UDR0, 0x69);
      avr.runCycles(20);
      const restored = A.AVR().restore(avr.snapshot());
      expect(restored.pin(1).read()).toBe(false);
      restored.pin(1).onChange((high) => restored.pin(0).setInput(high));
      for (const chip of [avr, restored]) {
        chip.runCycles(156);
        expect(chip.cpu.readData(A.UCSR0A) & bit(A.TXC0)).toBe(bit(A.TXC0));
        expect(chip.cpu.readData(A.UDR0)).toBe(0);
        expect(chip.cpu.readData(A.UDR0)).toBe(0x69);
      }
    });

    test("a TX frame written while PRR is set starts on the pin only after resume", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.UCSR0B, bit(A.TXEN0)); avr.serial.useWire();
      avr.cpu.writeData(A.PRR, bit(A.PRUSART0)); avr.cpu.writeData(A.UDR0, 0);
      avr.runCycles(30);
      expect(avr.pin(1).read()).toBe(true);
      avr.cpu.writeData(A.PRR, 0);
      expect(avr.pin(1).read()).toBe(false);
      avr.runCycles(160);
      expect(avr.cpu.readData(A.UCSR0A) & bit(A.TXC0)).toBe(bit(A.TXC0));
    });
  });
  describe(`${timing}: SPI GPIO transfers`, () => {
    for (const mode of [0, 1, 2, 3]) for (const lsb of [false, true]) {
      test(`master mode ${mode}, ${lsb ? "LSB" : "MSB"} loopback`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.flash.fill(0);
        avr.cpu.writeData(A.DDRB, bit(2) | bit(3) | bit(5));
        avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR) | (mode << 2) | (lsb ? bit(A.DORD) : 0));
        avr.spi.useWire();
        const edges: boolean[] = [];
        avr.pin(13).onChange((high) => edges.push(high));
        avr.pin(11).onChange((high) => avr.pin(12).setInput(high));
        avr.cpu.writeData(A.SPDR, 0xa6);
        avr.pin(12).setInput(avr.pin(11).read());
        avr.runCycles(31);
        expect(avr.cpu.data[A.SPSR]! & bit(A.SPIF)).toBe(0);
        avr.runCycles(1);
        expect(edges).toHaveLength(16);
        expect(avr.cpu.readData(A.SPDR)).toBe(0xa6);
        expect(avr.pin(13).read()).toBe(mode >= 2);
        expect(avr.cpu.readData(A.SPSR) & bit(A.SPIF)).toBe(bit(A.SPIF));
        avr.cpu.readData(A.SPDR);
        expect(avr.cpu.readData(A.SPSR) & bit(A.SPIF)).toBe(0);
      });

      test(`slave mode ${mode}, ${lsb ? "LSB" : "MSB"} full duplex`, () => {
        const avr = A.AVR({ timing });
        avr.cpu.flash.fill(0);
        avr.pin(10).setInput(true);
        avr.cpu.writeData(A.DDRB, bit(4));
        avr.pin(13).setInput(mode >= 2);
        avr.cpu.writeData(A.SPCR, bit(A.SPE) | (mode << 2) | (lsb ? bit(A.DORD) : 0));
        avr.spi.useWire();
        avr.cpu.writeData(A.SPDR, 0x93);
        avr.pin(10).setInput(false);
        let received = 0;
        for (let i = 0; i < 8; i++) {
          const pos = lsb ? i : 7 - i;
          avr.pin(11).setInput(((0xa6 >> pos) & 1) !== 0);
          if ((mode & 1) === 0 && avr.pin(12).read()) received |= bit(pos);
          avr.pin(13).setInput(mode < 2);
          if ((mode & 1) !== 0 && avr.pin(12).read()) received |= bit(pos);
          avr.runCycles(2);
          avr.pin(13).setInput(mode >= 2);
          avr.runCycles(2);
        }
        expect(received).toBe(0x93);
        expect(avr.cpu.readData(A.SPDR)).toBe(0xa6);
        expect(avr.cpu.readData(A.SPSR) & bit(A.SPIF)).toBe(bit(A.SPIF));
      });
    }

    test("power gating and snapshot retain the next half-clock and accumulated bits", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.DDRB, bit(2) | bit(3) | bit(5));
      avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR));
      avr.spi.useWire();
      avr.pin(12).setInput(true);
      avr.cpu.writeData(A.SPDR, 0x56);
      avr.runCycles(9);
      avr.cpu.writeData(A.PRR, bit(A.PRSPI));
      avr.runCycles(50);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.cpu.writeData(A.PRR, 0);
        chip.runCycles(22);
        expect(chip.cpu.data[A.SPSR]! & bit(A.SPIF)).toBe(0);
        chip.runCycles(1);
        expect(chip.cpu.readData(A.SPDR)).toBe(0xff);
        expect(chip.cpu.data[A.SPSR]! & bit(A.SPIF)).toBe(bit(A.SPIF));
      }
    });

    test("SS aborts a partial slave byte and releases MISO", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.SPCR, bit(A.SPE));
      avr.cpu.writeData(A.DDRB, bit(4));
      avr.spi.useWire();
      avr.cpu.writeData(A.SPDR, 0xff);
      avr.pin(13).setInput(true);
      avr.cpu.writeData(A.SPDR, 0);
      expect(avr.cpu.readData(A.SPSR) & bit(A.WCOL)).toBe(bit(A.WCOL));
      avr.pin(10).setInput(true);
      expect(avr.pin(12).read()).toBe(false);
      expect(avr.snapshot().spi.busy).toBe(false);
    });

    test("slave MISO respects DDRB and is tri-stated even when PORTB is high", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.pin(12).setInput(true);
      avr.cpu.writeData(A.SPCR, bit(A.SPE)); avr.spi.useWire();
      avr.cpu.writeData(A.SPDR, 0);
      expect(avr.pin(12).read()).toBe(true);
      avr.cpu.writeData(A.DDRB, bit(4));
      expect(avr.pin(12).read()).toBe(false);
      avr.cpu.writeData(A.PORTB, bit(4)); avr.pin(12).setInput(false); avr.pin(10).setInput(true);
      expect(avr.pin(12).read()).toBe(false);
    });

    test("Timer2 cannot replace SPI MOSI; releasing SPI restores the timer output", () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.cpu.writeData(A.DDRB, bit(2) | bit(3) | bit(5));
      avr.cpu.writeData(A.OCR2A, 1); avr.cpu.writeData(A.TCCR2A, bit(A.COM2A0)); avr.cpu.writeData(A.TCCR2B, 1);
      avr.cpu.writeData(A.SPCR, bit(A.SPE) | bit(A.MSTR)); avr.spi.useWire();
      avr.cpu.writeData(A.SPDR, 0); avr.runCycles(32);
      expect(avr.pin(11).read()).toBe(false);
      avr.spi.useWire(false);
      expect(avr.pin(11).read()).toBe(true);
    });
  });

  test(`${timing}: DIDR suppresses PIN register reads while retaining analog input`, () => {
    const avr = A.AVR({ timing });
    avr.cpu.flash.fill(0);
    avr.pin(14).setInput(true);
    avr.pin(6).setInput(true);
    expect(avr.cpu.readData(A.PINC) & 1).toBe(1);
    expect(avr.cpu.readData(A.PIND) & bit(6)).toBe(bit(6));
    avr.cpu.writeData(A.DIDR0, 1);
    avr.cpu.writeData(A.DIDR1, 1);
    expect(avr.cpu.readData(A.PINC) & 1).toBe(0);
    expect(avr.cpu.readData(A.PIND) & bit(6)).toBe(0);
    expect(avr.pin(14).read()).toBe(true);
  });
}
