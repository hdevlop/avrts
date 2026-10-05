import { describe, expect, test } from "bun:test";
import * as A from "../src";

const bit = (n: number) => 1 << n;
const registers = [
  { name: "TCNT2", addr: A.TCNT2, busy: A.TCN2UB, value: 42 },
  { name: "OCR2A", addr: A.OCR2A, busy: A.OCR2AUB, value: 9 },
  { name: "OCR2B", addr: A.OCR2B, busy: A.OCR2BUB, value: 7 },
  { name: "TCCR2A", addr: A.TCCR2A, busy: A.TCR2AUB, value: 35 },
  { name: "TCCR2B", addr: A.TCCR2B, busy: A.TCR2BUB, value: 1 },
] as const;

for (const timing of ["fast", "cycle-exact"] as const) {
  const setup = (running = false, clockHz = 327_680) => {
    const avr = A.AVR({ timing, clockHz }); // Ten CPU clocks per TOSC period.
    if (running) avr.cpu.writeData(A.TCCR2B, 1);
    avr.cpu.writeData(A.ASSR, bit(A.AS2));
    return avr;
  };

  describe(`${timing}: Timer2 asynchronous register transfers`, () => {
    for (const r of registers) {
      test(`${r.name} reads its temporary value but applies only after two TOSC edges`, () => {
        const avr = setup();
        avr.cpu.writeData(r.addr, r.value);
        expect(avr.cpu.readData(r.addr)).toBe(r.addr === A.TCNT2 ? 0 : r.value);
        expect(avr.cpu.data[r.addr]).toBe(0);
        expect(avr.cpu.readData(A.ASSR) & bit(r.busy)).toBe(bit(r.busy));
        avr.runCycles(19);
        expect(avr.cpu.data[r.addr]).toBe(0);
        expect(avr.cpu.readData(A.ASSR) & bit(r.busy)).toBe(bit(r.busy));
        avr.runCycles(1);
        expect(avr.cpu.data[r.addr]).toBe(r.value);
        expect(avr.cpu.readData(A.ASSR) & bit(r.busy)).toBe(0);
      });

      test(`${r.name} keeps its first busy write and original deadline through restore`, () => {
        const avr = setup();
        avr.cpu.writeData(r.addr, r.value);
        avr.runCycles(11);
        avr.cpu.writeData(r.addr, 0);
        const restored = A.AVR().restore(avr.snapshot());
        expect(restored.cpu.readData(r.addr)).toBe(r.addr === A.TCNT2 ? 0 : r.value);
        restored.runCycles(8);
        expect(restored.cpu.data[r.addr]).toBe(0);
        restored.runCycles(1);
        expect(restored.cpu.data[r.addr]).toBe(r.value);
        expect(restored.cpu.readData(A.ASSR) & bit(r.busy)).toBe(0);
        restored.cpu.writeData(r.addr, 0);
        restored.runCycles(19);
        expect(restored.cpu.readData(A.ASSR) & bit(r.busy)).toBe(bit(r.busy));
        restored.runCycles(1);
        expect(restored.cpu.data[r.addr]).toBe(0);
      });
    }

    test("staggered register writes retain separate values and busy deadlines", () => {
      const avr = setup();
      avr.cpu.writeData(A.TCNT2, 42); // Edges 10, 20.
      avr.runCycles(11);
      avr.cpu.writeData(A.OCR2A, 9); // Edges 20, 30.
      const restored = A.AVR().restore(avr.snapshot());
      restored.runCycles(9);
      expect(restored.cpu.readData(A.TCNT2)).toBe(42);
      expect(restored.cpu.data[A.OCR2A]).toBe(0);
      expect(restored.cpu.readData(A.OCR2A)).toBe(9);
      expect(restored.cpu.readData(A.ASSR) & 0x1f).toBe(bit(A.OCR2AUB));
      restored.runCycles(9);
      expect(restored.cpu.readData(A.ASSR) & bit(A.OCR2AUB)).toBe(bit(A.OCR2AUB));
      restored.runCycles(1);
      expect(restored.cpu.data[A.OCR2A]).toBe(9);
      expect(restored.cpu.readData(A.ASSR) & 0x1f).toBe(0);
    });

    test("ASSR writes cannot clear busy flags or set reserved/hardware-owned bits", () => {
      const avr = setup();
      avr.cpu.writeData(A.OCR2A, 7);
      avr.runCycles(11);
      avr.cpu.writeData(A.ASSR, 0xff);
      expect(avr.cpu.readData(A.ASSR)).toBe(bit(A.EXCLK) | bit(A.AS2) | bit(A.OCR2AUB));
      avr.runCycles(9);
      expect(avr.cpu.data[A.OCR2A]).toBe(7);
      expect(avr.cpu.readData(A.ASSR)).toBe(bit(A.EXCLK) | bit(A.AS2));
    });

    for (const asynchronous of [false, true]) {
      test(`${asynchronous ? "asynchronous" : "synchronous"} control reads mask reserved and FOC bits`, () => {
        const avr = A.AVR({ timing, clockHz: 327_680 });
        if (asynchronous) avr.cpu.writeData(A.ASSR, bit(A.AS2));
        avr.cpu.writeData(A.TCCR2A, 0xff);
        avr.cpu.writeData(A.TCCR2B, 0xff);
        expect(avr.cpu.readData(A.TCCR2A)).toBe(0xf3);
        expect(avr.cpu.readData(A.TCCR2B)).toBe(0x0f);
        if (asynchronous) {
          expect(avr.cpu.data[A.TCCR2A]).toBe(0);
          expect(avr.cpu.data[A.TCCR2B]).toBe(0);
          avr.runCycles(20);
        }
        expect(avr.cpu.data[A.TCCR2A]).toBe(0xf3);
        expect(avr.cpu.data[A.TCCR2B]).toBe(0x0f);
      });
    }

    test("an asynchronous FOC strobe acts once at transfer and always reads zero", () => {
      const avr = A.AVR({ timing, clockHz: 327_680 });
      avr.cpu.writeData(A.DDRB, bit(3));
      avr.cpu.writeData(A.TCCR2A, bit(A.COM2A0));
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.cpu.writeData(A.TCCR2B, 0x80); // FOC2A.
      expect(avr.cpu.readData(A.TCCR2B)).toBe(0);
      avr.runCycles(10);
      const restored = A.AVR().restore(avr.snapshot());
      restored.runCycles(9);
      expect(restored.pin(11).read()).toBe(false);
      restored.runCycles(1);
      expect(restored.pin(11).read()).toBe(true);
      expect(restored.cpu.readData(A.TCCR2B)).toBe(0);
      expect(restored.cpu.readData(A.TIFR2) & 6).toBe(0);
      restored.runCycles(30);
      expect(restored.pin(11).read()).toBe(true);
    });

    for (const reversed of [false, true]) {
      test(`same-edge mode and OCR transfers are coherent in ${reversed ? "reverse" : "forward"} write order`, () => {
        const avr = A.AVR({ timing, clockHz: 327_680 });
        avr.cpu.writeData(A.OCR2A, 8);
        avr.cpu.writeData(A.OCR2B, 2);
        avr.cpu.writeData(A.TCCR2B, 1);
        avr.cpu.writeData(A.ASSR, bit(A.AS2));
        const writes = [[A.OCR2A, 6], [A.OCR2B, 4], [A.TCCR2A, 3 | (2 << 4)], [A.TCCR2B, 9]] as const;
        for (const [addr, value] of reversed ? [...writes].reverse() : writes) avr.cpu.writeData(addr, value);
        avr.runCycles(20);
        expect(avr.cpu.readData(A.TCNT2)).toBe(2);
        expect(avr.cpu.readData(A.ASSR) & 0x1f).toBe(0);
        expect(avr.pwm(3).read().enabled).toBe(true);
        expect(avr.pwm(3).read().value).toBe(2);
        avr.runCycles(70);
        expect(avr.cpu.readData(A.TCNT2)).toBe(0);
        expect(avr.pwm(3).read().value).toBe(4);
        expect(avr.pwm(3).read().duty).toBe(4 / 6);
      });
    }

    test("TCNT2 reads and counts the destination until its pending value is transferred", () => {
      const avr = setup(true);
      avr.cpu.writeData(A.TCNT2, 100);
      avr.runCycles(10);
      expect(avr.cpu.readData(A.TCNT2)).toBe(1);
      expect(avr.cpu.readData(A.TIFR2) & 6).toBe(0); // Compare disabled during TCNT write.
      avr.runCycles(10);
      expect(avr.cpu.readData(A.TCNT2)).toBe(100);
      avr.runCycles(10);
      expect(avr.cpu.readData(A.TCNT2)).toBe(101);
    });

    test("control reads expose the temporary stop while counting uses the old CS bits", () => {
      const avr = setup(true);
      avr.cpu.writeData(A.TCCR2B, 0);
      expect(avr.cpu.readData(A.TCCR2B)).toBe(0);
      expect(avr.cpu.data[A.TCCR2B]).toBe(1);
      avr.runCycles(10);
      expect(avr.cpu.readData(A.TCNT2)).toBe(1);
      avr.runCycles(10);
      expect(avr.cpu.readData(A.TCNT2)).toBe(2);
      avr.runCycles(100);
      expect(avr.cpu.readData(A.TCNT2)).toBe(2);
    });

    test("an OCR2A transfer suppresses A matches while channel B remains active", () => {
      const avr = A.AVR({ timing, clockHz: 327_680 });
      avr.cpu.writeData(A.DDRD, bit(3));
      avr.cpu.writeData(A.OCR2A, 1);
      avr.cpu.writeData(A.OCR2B, 1);
      avr.cpu.writeData(A.TCCR2A, bit(A.COM2B0));
      avr.cpu.writeData(A.TCCR2B, 1);
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.cpu.writeData(A.OCR2A, 5);
      avr.runCycles(10);
      expect(avr.pin(3).read()).toBe(true);
      avr.runCycles(10);
      expect(avr.cpu.readData(A.TIFR2) & 6).toBe(bit(A.OCF2B));
      avr.runCycles(40);
      expect(avr.cpu.readData(A.TIFR2) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
    });

    test("CTC does not clear through a disabled A compare during an OCR2A transfer", () => {
      const avr = A.AVR({ timing, clockHz: 327_680 });
      avr.cpu.writeData(A.OCR2A, 3);
      avr.cpu.writeData(A.TCCR2A, bit(A.WGM21));
      avr.cpu.writeData(A.TCCR2B, 1);
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.runCycles(20);
      avr.cpu.writeData(A.OCR2A, 8);
      avr.runCycles(20);
      expect(avr.cpu.readData(A.TCNT2)).toBe(4);
      expect(avr.cpu.readData(A.TIFR2) & bit(A.OCF2A)).toBe(0);
      avr.runCycles(50);
      expect(avr.cpu.readData(A.TCNT2)).toBe(0);
      expect(avr.cpu.readData(A.TIFR2) & bit(A.OCF2A)).toBe(bit(A.OCF2A));
    });

    test("asynchronous OCR transfer and fast-PWM BOTTOM buffering are separate stages", () => {
      const avr = A.AVR({ timing, clockHz: 327_680 });
      avr.cpu.writeData(A.OCR2A, 8);
      avr.cpu.writeData(A.OCR2B, 2);
      avr.cpu.writeData(A.TCCR2A, 3 | (2 << 4));
      avr.cpu.writeData(A.TCCR2B, bit(A.WGM22) | 1);
      avr.cpu.writeData(A.ASSR, bit(A.AS2));
      avr.runCycles(10);
      avr.cpu.writeData(A.OCR2B, 6);
      avr.runCycles(15);
      const restored = A.AVR().restore(avr.snapshot());
      expect(restored.cpu.readData(A.OCR2B)).toBe(6);
      expect(restored.cpu.data[A.OCR2B]).toBe(2);
      expect(restored.pwm(3).read().value).toBe(2);
      restored.runCycles(5);
      expect(restored.cpu.readData(A.ASSR) & bit(A.OCR2BUB)).toBe(0);
      expect(restored.cpu.data[A.OCR2B]).toBe(6);
      expect(restored.pwm(3).read().value).toBe(2);
      restored.runCycles(60);
      expect(restored.pwm(3).read().value).toBe(6);
    });

    test("a pending COM write cannot change the PWM facade or pin before latching", () => {
      const avr = setup();
      avr.cpu.writeData(A.DDRD, bit(3));
      avr.cpu.writeData(A.TCCR2A, 3 | (2 << 4));
      expect(avr.cpu.readData(A.TCCR2A)).toBe(35);
      expect(avr.pwm(3).read().enabled).toBe(false);
      expect(avr.pin(3).read()).toBe(false);
      const changes: boolean[] = [];
      avr.pwm(3).onChange(signal => changes.push(signal.enabled));
      avr.runCycles(19);
      expect(changes).toEqual([]);
      avr.runCycles(1);
      expect(avr.pwm(3).read().enabled).toBe(true);
      expect(avr.pin(3).read()).toBe(true);
      expect(changes).toEqual([true]);
    });

    test("fractional TOSC edges and writes while stopped retain their source phase", () => {
      const avr = setup(false, 16_000_000);
      avr.runCycles(950);
      avr.cpu.writeData(A.TCCR2B, 1); // Next rising edges: ceil(976.5625), ceil(1464.84375).
      avr.runCycles(514);
      expect(avr.cpu.readData(A.ASSR) & bit(A.TCR2BUB)).toBe(bit(A.TCR2BUB));
      avr.runCycles(1);
      expect(avr.cpu.readData(A.ASSR) & bit(A.TCR2BUB)).toBe(0);
      expect(avr.cpu.readData(A.TCNT2)).toBe(0);
      avr.runCycles(488); // Edge 4 at ceil(1953.125): not yet.
      expect(avr.cpu.readData(A.TCNT2)).toBe(0);
      avr.runCycles(1);
      expect(avr.cpu.readData(A.TCNT2)).toBe(1);
    });

    test("CLKPR rescales pending transfers and TOSC phase across restore", () => {
      const avr = setup();
      avr.cpu.writeData(A.TCCR2B, 1);
      avr.runCycles(3);
      const restored = A.AVR().restore(avr.snapshot());
      restored.cpu.writeData(A.CLKPR, bit(A.CLKPCE));
      restored.cpu.writeData(A.CLKPR, 1);
      restored.runCycles(8); // Second edge at 11.5, visible at cycle 12.
      expect(restored.cpu.readData(A.ASSR) & bit(A.TCR2BUB)).toBe(bit(A.TCR2BUB));
      restored.runCycles(1);
      expect(restored.cpu.readData(A.ASSR) & bit(A.TCR2BUB)).toBe(0);
      expect(restored.cpu.readData(A.TCNT2)).toBe(0);
      restored.runCycles(5);
      expect(restored.cpu.readData(A.TCNT2)).toBe(1);
    });

    for (const mode of [1, 3, 7]) {
      test(`sleep mode ${mode} continues TOSC register transfers and later counting`, () => {
        const avr = setup();
        avr.cpu.writeData(A.TCCR2B, 1);
        avr.cpu.writeData(A.SMCR, bit(A.SE) | (mode << 1));
        avr.cpu.sleep();
        const restored = A.AVR().restore(avr.snapshot());
        restored.runCycles(19);
        expect(restored.cpu.readData(A.ASSR) & bit(A.TCR2BUB)).toBe(bit(A.TCR2BUB));
        restored.runCycles(1);
        expect(restored.cpu.readData(A.ASSR) & bit(A.TCR2BUB)).toBe(0);
        restored.runCycles(10);
        expect(restored.cpu.readData(A.TCNT2)).toBe(1);
        expect(restored.cpu.isSleeping).toBe(true);
      });
    }

    for (const mode of [2, 6]) {
      test(`sleep mode ${mode} freezes pending transfer phase through restore and wake`, () => {
        const avr = setup();
        avr.cpu.writeData(A.OCR2A, 7);
        avr.runCycles(3);
        avr.cpu.writeData(A.SMCR, bit(A.SE) | (mode << 1));
        avr.cpu.sreg.I = true;
        avr.cpu.sleep();
        avr.runCycles(1000);
        const restored = A.AVR().restore(avr.snapshot());
        restored.runCycles(1000);
        expect(restored.cpu.readData(A.ASSR) & bit(A.OCR2AUB)).toBe(bit(A.OCR2AUB));
        expect(restored.cpu.data[A.OCR2A]).toBe(0);
        restored.cpu.requestInterrupt(A.INT0_VECTOR);
        restored.step();
        expect(restored.cpu.isSleeping).toBe(false);
        // The sleep controller resumes this source after CPU interrupt entry.
        restored.runCycles(16);
        expect(restored.cpu.readData(A.ASSR) & bit(A.OCR2AUB)).toBe(bit(A.OCR2AUB));
        restored.runCycles(1);
        expect(restored.cpu.data[A.OCR2A]).toBe(7);
        expect(restored.cpu.readData(A.ASSR) & bit(A.OCR2AUB)).toBe(0);
      });
    }

    for (const gate of ["PRR", "GTCCR"] as const) {
      test(`${gate} holds the counter while TOSC register transfers continue`, () => {
        const avr = setup(true);
        if (gate === "PRR") avr.cpu.writeData(A.PRR, bit(A.PRTIM2));
        else avr.cpu.writeData(A.GTCCR, bit(A.TSM) | bit(A.PSRASY));
        avr.cpu.writeData(A.TCNT2, 42);
        avr.runCycles(20);
        expect(avr.cpu.readData(A.TCNT2)).toBe(42);
        expect(avr.cpu.readData(A.ASSR) & bit(A.TCN2UB)).toBe(0);
        avr.cpu.writeData(gate === "PRR" ? A.PRR : A.GTCCR, 0);
        avr.runCycles(10);
        expect(avr.cpu.readData(A.TCNT2)).toBe(43);
      });
    }

    test("switching to synchronous mode discards pending transfers and busy bits", () => {
      const avr = setup();
      avr.cpu.writeData(A.OCR2A, 7);
      avr.runCycles(3);
      avr.cpu.writeData(A.ASSR, 0xff & ~bit(A.AS2));
      expect(avr.cpu.readData(A.ASSR)).toBe(bit(A.EXCLK));
      expect(avr.cpu.readData(A.OCR2A)).toBe(0);
      avr.cpu.writeData(A.OCR2A, 9);
      avr.runCycles(30);
      expect(avr.cpu.readData(A.OCR2A)).toBe(9);
      expect(avr.cpu.readData(A.ASSR) & 0x1f).toBe(0);
    });

    test("reset cancels pending values and their scheduled transfers", () => {
      const avr = setup();
      avr.cpu.writeData(A.OCR2A, 7);
      avr.reset();
      avr.runCycles(30);
      expect(avr.cpu.readData(A.OCR2A)).toBe(0);
      expect(avr.cpu.readData(A.ASSR)).toBe(0);
    });

    test("legacy snapshots retain their already-applied destination and busy window", () => {
      const avr = setup(true);
      const snap = avr.snapshot();
      delete snap.timer2.asyncWrites;
      delete snap.timer2.toscPhase;
      snap.cpu.data[A.TCNT2] = 42;
      snap.cpu.data[A.OCR2A] = 9;
      snap.cpu.data[A.ASSR] = snap.cpu.data[A.ASSR]! | bit(A.TCN2UB) | bit(A.OCR2AUB);
      snap.timer2.activeOcrA = 9;
      snap.timer2.asyncBusyMask = bit(A.TCN2UB) | bit(A.OCR2AUB);
      snap.timer2.asyncBusyRemaining = 7;
      const restored = A.AVR().restore(snap);
      restored.runCycles(6);
      const second = A.AVR().restore(restored.snapshot());
      second.runCycles(1);
      expect(second.cpu.readData(A.ASSR) & 0x1f).toBe(0);
      expect(second.cpu.readData(A.TCNT2)).toBe(42);
      second.runCycles(3);
      expect(second.cpu.readData(A.TCNT2)).toBe(43);
    });
  });
}
