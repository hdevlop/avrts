import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import {
  EEARH,
  EEARL,
  EECR,
  EEDR,
  EEMPE,
  EEPE,
  EERE,
  MSTR,
  PCICR,
  PCIE0,
  PCMSK0,
  SE,
  SMCR,
  SPCR,
  SPDR,
  SPE,
  SPIF,
  SPSR,
  TWCR,
  TWDR,
  TWEA,
  TWEN,
  TWINT,
  TWSR,
  TWSTA,
  TWSTO,
  WDIE,
  WDT_VECTOR,
  WDTCSR,
} from "../src/cpu";

describe("EEPROM", () => {
  test("register write sequence stores a byte (host-readable)", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    cpu.writeData(EEARL, 0x10);
    cpu.writeData(EEARH, 0x00);
    cpu.writeData(EEDR, 0x5a);
    // The real avr-libc sequence: `out EECR,(1<<EEMPE)` then `out EECR,(1<<EEPE)`.
    // EEPE is written alone — EEMPE only needs to be armed, not repeated.
    cpu.writeData(EECR, 1 << EEMPE); // master write enable
    cpu.writeData(EECR, 1 << EEPE); // start write
    expect(avr.eeprom.read(0x10)).toBe(0x5a);
  });

  test("EEPE without an EEMPE arming window does not write", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    avr.eeprom.write(0x11, 0x99);
    cpu.writeData(EEARL, 0x11);
    cpu.writeData(EEARH, 0x00);
    cpu.writeData(EEDR, 0x00);
    cpu.writeData(EECR, 1 << EEPE); // EEPE alone, EEMPE never armed -> ignored
    expect(avr.eeprom.read(0x11)).toBe(0x99);
  });

  test("register read loads EEDR from the cell", () => {
    const avr = AVR();
    avr.eeprom.write(0x20, 0xc3);
    avr.cpu.writeData(EEARL, 0x20);
    avr.cpu.writeData(EEARH, 0x00);
    avr.cpu.writeData(EECR, 1 << EERE);
    expect(avr.cpu.readData(EEDR)).toBe(0xc3);
  });

  test("load/dump round-trips a 1KB image", () => {
    const avr = AVR();
    avr.eeprom.load([1, 2, 3]);
    const image = avr.eeprom.dump();
    expect(image.length).toBe(1024);
    expect(image[0]).toBe(1);
    expect(image[2]).toBe(3);
  });
});

describe("SPI", () => {
  test("master transfer emits MOSI and clocks in the responder byte", () => {
    const avr = AVR();
    const sent: number[] = [];
    avr.spi.onByte((b) => sent.push(b));
    avr.spi.respondWith((b) => b ^ 0xff);
    avr.cpu.writeData(SPCR, (1 << SPE) | (1 << MSTR));
    avr.cpu.writeData(SPDR, 0x3c);
    expect(sent).toEqual([0x3c]);
    expect(avr.cpu.readData(SPDR)).toBe(0xc3);
    expect((avr.cpu.readData(SPSR) >> SPIF) & 1).toBe(1);
  });
});

describe("TWI / I2C master", () => {
  test("write: START -> SLA+W -> data -> STOP", () => {
    const avr = AVR();
    const received: number[] = [];
    avr.twi.connect(0x50, {
      write: (b) => {
        received.push(b);
        return true;
      },
    });
    const cpu = avr.cpu;
    const ctrl = (extra = 0) => cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN) | extra);

    ctrl(1 << TWSTA);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x08); // START
    cpu.writeData(TWDR, (0x50 << 1) | 0); // SLA+W
    ctrl();
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x18); // SLA+W ACK
    cpu.writeData(TWDR, 0xab);
    ctrl();
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x28); // DATA ACK
    cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN) | (1 << TWSTO)); // STOP
    expect(received).toEqual([0xab]);
  });

  test("read: pulls bytes with ACK then NACK", () => {
    const avr = AVR();
    const data = [0x11, 0x22];
    let index = 0;
    avr.twi.connect(0x50, { read: () => data[index++] ?? 0xff });
    const cpu = avr.cpu;

    cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN) | (1 << TWSTA)); // START
    cpu.writeData(TWDR, (0x50 << 1) | 1); // SLA+R
    cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN));
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x40); // SLA+R ACK
    cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN) | (1 << TWEA)); // read + ACK
    expect(cpu.readData(TWDR)).toBe(0x11);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x50);
    cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN)); // read + NACK
    expect(cpu.readData(TWDR)).toBe(0x22);
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x58);
  });

  test("addressing an unconnected slave reports NACK", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN) | (1 << TWSTA));
    cpu.writeData(TWDR, (0x40 << 1) | 0);
    cpu.writeData(TWCR, (1 << TWINT) | (1 << TWEN));
    expect(cpu.readData(TWSR) & 0xf8).toBe(0x20); // SLA+W NACK
  });
});

describe("pin-change interrupts", () => {
  test("toggling an enabled pin requests the PCINT0 vector", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    cpu.writeData(PCMSK0, 0x01); // watch PB0 (pin 8)
    cpu.writeData(PCICR, 1 << PCIE0);
    cpu.sreg.I = true;

    avr.pin(8).setInput(true); // PB0 low -> high
    cpu.tick(); // executes NOP then services the queued interrupt
    expect(cpu.pc).toBe(0x0006); // PCINT0 vector
  });

  test("a masked-off pin does not interrupt", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    cpu.writeData(PCMSK0, 0x02); // watch PB1 only
    cpu.writeData(PCICR, 1 << PCIE0);
    cpu.sreg.I = true;
    avr.pin(8).setInput(true); // PB0 changes, but it's masked off
    cpu.tick();
    expect(cpu.pc).toBe(0x0001); // just the NOP; no interrupt taken
  });
});

describe("sleep", () => {
  test("SLEEP idles (no pc advance) until an enabled interrupt wakes it", () => {
    const avr = AVR();
    const cpu = avr.cpu;
    cpu.writeData(SMCR, 1 << SE);
    cpu.sreg.I = true;
    cpu.sleep();
    expect(cpu.isSleeping).toBe(true);

    const pcBefore = cpu.pc;
    cpu.tick(); // idle, nothing pending
    expect(cpu.pc).toBe(pcBefore);
    expect(cpu.isSleeping).toBe(true);

    cpu.requestInterrupt(0x0020);
    cpu.tick(); // services + wakes
    expect(cpu.isSleeping).toBe(false);
    expect(cpu.pc).toBe(0x0020);
  });

  test("SLEEP without SMCR.SE is a no-op", () => {
    const avr = AVR();
    avr.cpu.sleep();
    expect(avr.cpu.isSleeping).toBe(false);
  });
});

describe("watchdog", () => {
  test("WDIE timeout fires the WDT interrupt and self-clears WDIE", () => {
    const avr = AVR().useClock(16_000_000);
    const cpu = avr.cpu;
    cpu.flash[0] = 0xcfff; // rjmp -1 (main loop, keeps pc bounded)
    cpu.flash[0x000c] = 0xcfff; // rjmp -1 at the WDT vector (handler loop)
    cpu.sreg.I = true;
    cpu.writeData(WDTCSR, 1 << WDIE); // WDP=0 -> 16 ms -> 256000 cycles
    avr.runCycles(300_000);
    expect((cpu.readData(WDTCSR) >> WDIE) & 1).toBe(0);
  });

  test("WDR keeps the watchdog from timing out", () => {
    const avr = AVR().useClock(16_000_000);
    const cpu = avr.cpu;
    cpu.flash[0] = 0xcfff; // rjmp -1 (main loop)
    cpu.sreg.I = true;
    cpu.writeData(WDTCSR, 1 << WDIE);
    for (let i = 0; i < 4; i += 1) {
      avr.runCycles(200_000); // below the 256000 timeout...
      cpu.kickWatchdog(); // ...kept alive by WDR each window
    }
    expect((cpu.readData(WDTCSR) >> WDIE) & 1).toBe(1); // never fired
  });

  test("restored watchdog configuration still counts toward timeout", () => {
    const source = AVR().useClock(16_000_000);
    const cpu = source.cpu;
    cpu.flash[0] = 0xcfff; // rjmp -1 (main loop)
    cpu.flash[WDT_VECTOR] = 0xcfff; // rjmp -1 at the WDT vector
    cpu.sreg.I = true;
    cpu.writeData(WDTCSR, 1 << WDIE);

    const restored = AVR();
    restored.restore(source.snapshot());
    restored.runCycles(300_000);

    expect((restored.cpu.readData(WDTCSR) >> WDIE) & 1).toBe(0);
    expect(restored.cpu.pc).toBe(WDT_VECTOR);
  });
});
