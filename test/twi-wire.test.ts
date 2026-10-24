import { describe, expect, test } from "bun:test";
import * as A from "../src";
const bit = (n: number) => 1 << n;
const enable = bit(A.TWEN);
const next = enable | bit(A.TWINT);
const status = (avr: ReturnType<typeof A.AVR>) => avr.cpu.readData(A.TWSR) & 0xf8;
const ready = (avr: ReturnType<typeof A.AVR>) => (avr.cpu.readData(A.TWCR) & bit(A.TWINT)) !== 0;

for (const timing of ["fast", "cycle-exact"] as const) {
  describe(`${timing}: TWI GPIO bus`, () => {
    const make = () => {
      const avr = A.AVR({ timing });
      avr.cpu.flash.fill(0);
      avr.pin(18).setInput(true); avr.pin(19).setInput(true);
      avr.cpu.writeData(A.TWCR, enable);
      avr.twi.useWire();
      return avr;
    };
    test("master sends address/data, samples ACK and generates repeated START/STOP", () => {
      const avr = make();
      avr.cpu.writeData(A.TWCR, next | bit(A.TWSTA));
      avr.runCycles(16);
      expect(status(avr)).toBe(0x08);
      expect(ready(avr)).toBe(true);
      const received: number[] = [];
      let index = 0; let value = 0;
      avr.pin(19).onChange((high) => {
        if (high && index < 8) value = (value << 1) | Number(avr.pin(18).read());
        if (!high) {
          index++;
          if (index === 8) avr.pin(18).setInput(false);
          if (index === 9) { received.push(value); index = 0; value = 0; avr.pin(18).setInput(true); }
        }
      });
      for (const [outgoing, code] of [[0x42, 0x18], [0xa6, 0x28]]) {
        avr.cpu.writeData(A.TWDR, outgoing!);
        avr.cpu.writeData(A.TWCR, next);
        avr.runCycles(145);
        expect(status(avr)).toBe(code!);
        expect(ready(avr)).toBe(true);
        expect(avr.pin(19).read()).toBe(false); // Firmware stretches between bytes.
      }
      expect(received).toEqual([0x42, 0xa6]);
      avr.cpu.writeData(A.TWCR, next | bit(A.TWSTA));
      avr.runCycles(16);
      expect(status(avr)).toBe(0x10);
      avr.cpu.writeData(A.TWCR, next | bit(A.TWSTO));
      avr.runCycles(24);
      expect(avr.cpu.readData(A.TWCR) & (bit(A.TWSTO) | bit(A.TWINT))).toBe(0);
      expect(status(avr)).toBe(0xf8);
      expect(avr.pin(18).read()).toBe(true);
      expect(avr.pin(19).read()).toBe(true);
    });

    test("external clock stretching preserves pending bit across snapshot", () => {
      const avr = make();
      avr.cpu.writeData(A.TWCR, next | bit(A.TWSTA)); avr.runCycles(16);
      avr.cpu.writeData(A.TWDR, 0x42); avr.cpu.writeData(A.TWCR, next);
      avr.runCycles(8); avr.pin(19).setInput(false); avr.runCycles(100);
      expect(ready(avr)).toBe(false);
      const restored = A.AVR().restore(avr.snapshot());
      for (const chip of [avr, restored]) {
        chip.pin(19).setInput(true);
        chip.runCycles(144);
        expect(status(chip)).toBe(0x20); // Released SDA supplies address NACK.
        expect(ready(chip)).toBe(true);
      }
    });

    test("a sampled dominant SDA bit causes arbitration loss and releases the bus", () => {
      const avr = make();
      avr.cpu.writeData(A.TWCR, next | bit(A.TWSTA)); avr.runCycles(16);
      avr.cpu.writeData(A.TWDR, 0x80); avr.cpu.writeData(A.TWCR, next);
      avr.pin(18).setInput(false); avr.runCycles(16);
      expect(status(avr)).toBe(0x38);
      expect(ready(avr)).toBe(true);
      expect(avr.pin(19).read()).toBe(true);
    });

    test("slave decodes address/data on external SCL and holds SCL while TWINT is set", () => {
      const avr = make();
      avr.cpu.writeData(A.TWAR, 0x42);
      avr.cpu.writeData(A.TWCR, enable | bit(A.TWEA));
      const send = (value: number) => {
        for (let i = 7; i >= 0; i--) {
          avr.pin(19).setInput(false); avr.pin(18).setInput((value & bit(i)) !== 0);
          avr.pin(19).setInput(true); avr.runCycles(2); avr.pin(19).setInput(false);
        }
        avr.pin(18).setInput(true); avr.pin(19).setInput(true);
        const ack = !avr.pin(18).read();
        avr.pin(19).setInput(false);
        return ack;
      };
      avr.pin(18).setInput(false); // START while SCL is high.
      expect(send(0x42)).toBe(true);
      expect(status(avr)).toBe(0x60);
      expect(avr.pin(19).read()).toBe(false);
      avr.cpu.writeData(A.TWCR, next | bit(A.TWEA));
      expect(avr.pin(19).read()).toBe(false);
      expect(send(0xa6)).toBe(true);
      expect(status(avr)).toBe(0x80);
      expect(avr.cpu.readData(A.TWDR)).toBe(0xa6);
      avr.pin(19).setInput(false);
      avr.cpu.writeData(A.TWCR, next | bit(A.TWEA));
      avr.pin(18).setInput(false); avr.pin(19).setInput(true); avr.pin(18).setInput(true);
      expect(status(avr)).toBe(0xa0);
    });

    test("master reads data bits and transmits NACK on the ninth clock", () => {
      const avr = make();
      avr.cpu.writeData(A.TWCR, next | bit(A.TWSTA)); avr.runCycles(16);
      avr.cpu.writeData(A.TWDR, 0x43); avr.cpu.writeData(A.TWCR, next);
      avr.runCycles(128); // The address's eight data clocks have completed.
      avr.pin(18).setInput(false); avr.runCycles(16);
      expect(status(avr)).toBe(0x40);
      let index = 0;
      avr.pin(18).setInput(false); // First incoming bit of 0x5a.
      avr.pin(19).onChange((high) => {
        if (!high) {
          index++;
          avr.pin(18).setInput(index >= 8 || ((0x5a >> (7 - index)) & 1) !== 0);
        }
      });
      avr.cpu.writeData(A.TWCR, next);
      avr.runCycles(144);
      expect(status(avr)).toBe(0x58);
      expect(avr.cpu.readData(A.TWDR)).toBe(0x5a);
      expect(ready(avr)).toBe(true);
    });

    test("slave transmitter serializes TWDR and samples the master's NACK", () => {
      const avr = make();
      avr.cpu.writeData(A.TWAR, 0x42); avr.cpu.writeData(A.TWCR, enable | bit(A.TWEA));
      avr.pin(18).setInput(false);
      for (let i = 7; i >= 0; i--) {
        avr.pin(19).setInput(false); avr.pin(18).setInput((0x43 & bit(i)) !== 0);
        avr.pin(19).setInput(true); avr.pin(19).setInput(false);
      }
      avr.pin(18).setInput(true); avr.pin(19).setInput(true); avr.pin(19).setInput(false);
      expect(status(avr)).toBe(0xa8);
      avr.cpu.writeData(A.TWDR, 0xa6); avr.cpu.writeData(A.TWCR, next | bit(A.TWEA));
      let incoming = 0;
      for (let i = 0; i < 8; i++) {
        avr.pin(19).setInput(true); incoming = (incoming << 1) | Number(avr.pin(18).read());
        avr.pin(19).setInput(false);
      }
      avr.pin(19).setInput(true); avr.pin(19).setInput(false);
      expect(incoming).toBe(0xa6);
      expect(status(avr)).toBe(0xc0);
    });

    test("reset disables pin ownership and discards a partially transmitted master byte", () => {
      const avr = make();
      avr.cpu.writeData(A.TWCR, next | bit(A.TWSTA)); avr.runCycles(16);
      avr.cpu.writeData(A.TWDR, 0x42); avr.cpu.writeData(A.TWCR, next); avr.runCycles(25);
      avr.reset(); avr.runCycles(200);
      expect(ready(avr)).toBe(false);
      expect(avr.snapshot().gpio.drainMask!.C).toBe(0);
      expect(avr.snapshot().twi.wire?.operation).toBe(null);
    });

    test("shared wired-AND bus supports two AVR endpoints with byte-boundary stretching", () => {
      const master = A.AVR({ timing }); const slave = A.AVR({ timing });
      master.cpu.flash.fill(0);
      slave.cpu.flash.fill(0);
      const bus = A.createTwiBus();
      bus.connect(master); bus.connect(slave);
      master.cpu.writeData(A.TWCR, enable);
      slave.cpu.writeData(A.TWAR, 0x42); slave.cpu.writeData(A.TWCR, enable | bit(A.TWEA));
      const run = (cycles: number) => { for (let i = 0; i < cycles; i++) { master.runCycles(1); slave.runCycles(1); } };
      master.cpu.writeData(A.TWCR, next | bit(A.TWSTA)); run(16);
      master.cpu.writeData(A.TWDR, 0x42); master.cpu.writeData(A.TWCR, next); run(144);
      expect(status(master)).toBe(0x18);
      expect(status(slave)).toBe(0x60);
      master.cpu.writeData(A.TWDR, 0xa6); master.cpu.writeData(A.TWCR, next); run(100);
      expect(ready(master)).toBe(false);
      slave.cpu.writeData(A.TWCR, next | bit(A.TWEA)); run(144);
      expect(status(master)).toBe(0x28);
      expect(status(slave)).toBe(0x80);
      expect(slave.cpu.readData(A.TWDR)).toBe(0xa6);
    });

    test("two masters on one bus resolve arbitration from the first differing data bit", () => {
      const winner = A.AVR({ timing }); const loser = A.AVR({ timing });
      winner.cpu.flash.fill(0);
      loser.cpu.flash.fill(0);
      const bus = A.createTwiBus(); bus.connect(winner); bus.connect(loser);
      const run = (cycles: number) => { for (let i = 0; i < cycles; i++) { winner.runCycles(1); loser.runCycles(1); } };
      for (const chip of [winner, loser]) chip.cpu.writeData(A.TWCR, next | bit(A.TWSTA));
      run(20);
      winner.cpu.writeData(A.TWDR, 0x42); loser.cpu.writeData(A.TWDR, 0x46);
      for (const chip of [winner, loser]) chip.cpu.writeData(A.TWCR, next);
      run(200);
      expect(status(loser)).toBe(0x38);
      expect(status(winner)).toBe(0x20);
      expect(ready(winner)).toBe(true);
    });

    test("losing master can be addressed as a slave by the winning transaction", () => {
      const winner = A.AVR({ timing }); const loser = A.AVR({ timing });
      winner.cpu.flash.fill(0);
      loser.cpu.flash.fill(0);
      const bus = A.createTwiBus(); bus.connect(winner); bus.connect(loser);
      loser.cpu.writeData(A.TWAR, 0x42);
      const run = (cycles: number) => { for (let i = 0; i < cycles; i++) { winner.runCycles(1); loser.runCycles(1); } };
      for (const chip of [winner, loser]) chip.cpu.writeData(A.TWCR, next | bit(A.TWEA) | bit(A.TWSTA));
      run(20);
      winner.cpu.writeData(A.TWDR, 0x42); loser.cpu.writeData(A.TWDR, 0x46);
      for (const chip of [winner, loser]) chip.cpu.writeData(A.TWCR, next | bit(A.TWEA));
      run(200);
      expect(status(loser)).toBe(0x68);
      expect(status(winner)).toBe(0x18);
    });
  });
}
