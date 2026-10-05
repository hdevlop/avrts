import { describe, expect, test } from "bun:test";
import { AVR, INT0_VECTOR, INT1_VECTOR } from "../src";
import {
  DDRD,
  EICRA,
  EIFR,
  EIMSK,
  INT0,
  INT1,
  INTF0,
  INTF1,
  ISC00,
  ISC01,
  ISC10,
  ISC11,
} from "../src/cpu";

/**
 * Phase 14 — External Interrupts (INT0 / INT1)
 *
 * The flag is set in evaluateEdges() BEFORE the CPU services the interrupt;
 * once dispatched, the ack callback clears it (matching real AVR hardware, which
 * auto-clears INTFn when the interrupt is taken). Tests therefore check the
 * flag right after setInput() rather than after a subsequent tick().
 */

describe("Phase 14 — external interrupts (register-level)", () => {
  test("rising edge on INT0 sets INTF0 and dispatches to INT0_VECTOR", () => {
    const avr = AVR();
    avr.cpu.writeData(EIMSK, 1 << INT0);
    avr.cpu.writeData(EICRA, (1 << ISC01) | (1 << ISC00)); // rising
    avr.cpu.writeData(DDRD, 0); // PD2 input
    avr.cpu.sreg.I = true;
    avr.cpu.flash[INT0_VECTOR] = 0xcfff; // RJMP -1 in the ISR

    avr.pin(2).setInput(false);
    avr.runCycles(1);
    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(0);

    avr.pin(2).setInput(true); // rising edge -> flag set
    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(1 << INTF0);

    avr.cpu.tick(); // executes one instruction + services the interrupt
    expect(avr.cpu.pc).toBe(INT0_VECTOR);
    // After the interrupt is taken, the ack callback clears INTF0.
    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(0);
  });

  test("falling edge on INT0 fires the interrupt", () => {
    const avr = AVR();
    avr.cpu.writeData(EIMSK, 1 << INT0);
    avr.cpu.writeData(EICRA, (1 << ISC01) | (0 << ISC00)); // falling (mode 0b10)
    avr.cpu.sreg.I = true;
    avr.cpu.flash[INT0_VECTOR] = 0xcfff;

    avr.pin(2).setInput(true);
    avr.runCycles(1);

    avr.pin(2).setInput(false); // falling edge
    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(1 << INTF0);

    avr.cpu.tick();
    expect(avr.cpu.pc).toBe(INT0_VECTOR);
  });

  test("any-change mode fires on rising edges", () => {
    const avr = AVR();
    avr.cpu.writeData(EIMSK, 1 << INT0);
    avr.cpu.writeData(EICRA, (0 << ISC01) | (1 << ISC00)); // any change (0b01)
    avr.cpu.sreg.I = true;
    avr.cpu.flash[INT0_VECTOR] = 0xcfff;

    avr.pin(2).setInput(false);
    avr.runCycles(1);

    avr.pin(2).setInput(true);
    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(1 << INTF0);
  });

  test("level mode keeps requesting INT0 while PD2 is LOW", () => {
    const avr = AVR();
    avr.cpu.writeData(EIMSK, 1 << INT0);
    avr.cpu.writeData(EICRA, 0); // low level (mode 0b00)
    avr.cpu.sreg.I = true;
    avr.cpu.flash[INT0_VECTOR] = 0xcfff;

    avr.pin(2).setInput(false); // pin LOW
    avr.runCycles(2);
    expect(avr.cpu.pc).toBe(INT0_VECTOR);
    // In level mode INTF0 is never set.
    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(0);
  });

  test("rising edge on INT1 sets INTF1 and dispatches to INT1_VECTOR", () => {
    const avr = AVR();
    avr.cpu.writeData(EIMSK, 1 << INT1);
    avr.cpu.writeData(EICRA, (1 << ISC11) | (1 << ISC10));
    avr.cpu.sreg.I = true;
    avr.cpu.flash[INT1_VECTOR] = 0xcfff;

    avr.pin(3).setInput(false);
    avr.runCycles(1);

    avr.pin(3).setInput(true);
    expect(avr.cpu.readData(EIFR) & (1 << INTF1)).toBe(1 << INTF1);

    avr.cpu.tick();
    expect(avr.cpu.pc).toBe(INT1_VECTOR);
  });

  test("edge interrupt without EIMSK enable does not fire", () => {
    const avr = AVR();
    avr.cpu.flash[0] = 0xcfff; // RJMP -1 self-loop at main (PC stays at 0)
    avr.cpu.flash[INT0_VECTOR] = 0xcfff;
    avr.cpu.writeData(EICRA, (1 << ISC01) | (1 << ISC00)); // rising
    // EIMSK left at 0 — INT0 not enabled.
    avr.cpu.sreg.I = true;

    avr.pin(2).setInput(false);
    avr.runCycles(5);
    expect(avr.cpu.pc).toBe(0);

    avr.pin(2).setInput(true);
    // The edge latches a flag even while its interrupt is masked.
    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(1 << INTF0);

    avr.runCycles(5);
    // Still in the main self-loop; no interrupt was taken.
    expect(avr.cpu.pc).toBe(0);
  });

  test("edge interrupt without I flag sets the flag but does not dispatch", () => {
    const avr = AVR();
    avr.cpu.flash[0] = 0xcfff; // RJMP -1 self-loop at main
    avr.cpu.flash[INT0_VECTOR] = 0xcfff;
    avr.cpu.writeData(EIMSK, 1 << INT0);
    avr.cpu.writeData(EICRA, (1 << ISC01) | (1 << ISC00));
    // I flag left at 0 (interrupts globally disabled).

    avr.pin(2).setInput(false);
    avr.runCycles(5);
    expect(avr.cpu.pc).toBe(0);

    avr.pin(2).setInput(true);
    // Flag IS set; the CPU just isn't taking the interrupt.
    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(1 << INTF0);

    avr.runCycles(5);
    expect(avr.cpu.pc).toBe(0);
  });

  test("writing 1 to EIFR clears the matching flag (write-1-to-clear)", () => {
    const avr = AVR();
    avr.cpu.writeData(EIMSK, 1 << INT0);
    avr.cpu.writeData(EICRA, (1 << ISC01) | (1 << ISC00));
    avr.cpu.sreg.I = false; // do not dispatch — keep the flag set
    avr.cpu.flash[INT0_VECTOR] = 0xcfff;

    avr.pin(2).setInput(false);
    avr.runCycles(1);
    avr.pin(2).setInput(true);
    avr.runCycles(1); // INTF0 set, I is false so it stays set

    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(1 << INTF0);

    avr.cpu.writeData(EIFR, 1 << INTF0); // clear INTF0
    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(0);

    // Setting a clear bit with no flag does nothing.
    avr.cpu.writeData(EIFR, 1 << INTF1);
    expect(avr.cpu.readData(EIFR)).toBe(0);
  });
});

describe("Phase 14 — real firmware fixture (attachInterrupt)", () => {
  test("rising edge on pin 2 toggles pin 13 via INT0 ISR", async () => {
    const hex = await Bun.file(
      new URL("../examples/attachInterrupt-blink/attachInterrupt-blink.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);
    const edges: boolean[] = [];
    avr.pin(13).onChange((high) => edges.push(high));

    avr.runCycles(200); // let main() run (configure + sei)
    expect(avr.cpu.readData(EIMSK) & (1 << INT0)).toBe(1 << INT0);
    expect(avr.cpu.readData(EICRA) & 0x03).toBe(0b11); // rising
    expect(edges).toEqual([]); // LED starts off

    avr.pin(2).setInput(true); // first rising edge → ISR fires, LED on
    avr.runCycles(50);
    expect(avr.pin(13).read()).toBe(true);

    avr.pin(2).setInput(false);
    avr.runCycles(10);
    avr.pin(2).setInput(true); // second rising edge → LED off
    avr.runCycles(50);
    expect(avr.pin(13).read()).toBe(false);

    avr.pin(2).setInput(false);
    avr.runCycles(10);
    avr.pin(2).setInput(true); // third → LED on
    avr.runCycles(50);
    expect(avr.pin(13).read()).toBe(true);
  });

  test("falling edge on pin 3 sets INTF1 and dispatches to INT1_VECTOR", async () => {
    // The committed firmware only has an ISR at INT0. This test re-uses the
    // same firmware but verifies that a falling edge on PD3 reaches INT1_VECTOR
    // when we manually reconfigure EICRA + EIMSK after main() has run.
    const hex = await Bun.file(
      new URL("../examples/attachInterrupt-blink/attachInterrupt-blink.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);

    avr.runCycles(200); // let main() configure, then sei().

    avr.cpu.writeData(EICRA, (1 << ISC11) | (0 << ISC10)); // INT1 falling
    avr.cpu.writeData(EIMSK, 1 << INT1); // enable INT1, disable INT0

    avr.pin(3).setInput(true);
    avr.runCycles(5);

    avr.pin(3).setInput(false); // falling edge on PD3
    expect(avr.cpu.readData(EIFR) & (1 << INTF1)).toBe(1 << INTF1);

    avr.cpu.tick();
    expect(avr.cpu.pc).toBe(INT1_VECTOR);
  });

  test("real INT1 firmware toggles pin 13 from falling edges on pin 3", async () => {
    const hex = await Bun.file(
      new URL("../examples/attachInterrupt-int1-blink/attachInterrupt-int1-blink.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);

    avr.runCycles(200); // let main() configure INT1 and enable interrupts.
    expect(avr.cpu.readData(EIMSK) & (1 << INT1)).toBe(1 << INT1);
    expect((avr.cpu.readData(EICRA) >> ISC10) & 0x03).toBe(0b10); // falling
    expect(avr.pin(13).read()).toBe(false);

    avr.pin(3).setInput(true);
    avr.runCycles(10);
    avr.pin(3).setInput(false);
    avr.runCycles(50);
    expect(avr.pin(13).read()).toBe(true);

    avr.pin(3).setInput(true);
    avr.runCycles(10);
    avr.pin(3).setInput(false);
    avr.runCycles(50);
    expect(avr.pin(13).read()).toBe(false);
  });
});

describe("Phase 14 — snapshot / restore for external interrupts", () => {
  test("snapshot restores the per-pin previous-level tracking", () => {
    const avr = AVR();
    avr.cpu.writeData(EIMSK, 1 << INT0);
    avr.cpu.writeData(EICRA, (1 << ISC01) | (1 << ISC00)); // rising
    avr.cpu.sreg.I = true;
    avr.cpu.flash[INT0_VECTOR] = 0xcfff;

    avr.pin(2).setInput(false);
    avr.runCycles(1);
    const snap = avr.snapshot();

    avr.runCycles(50);
    avr.restore(snap);

    // Rising edge again should still fire from the restored state.
    avr.pin(2).setInput(true);
    expect(avr.cpu.readData(EIFR) & (1 << INTF0)).toBe(1 << INTF0);
  });

  test("snapshot restores active low-level interrupt evaluation", () => {
    const source = AVR();
    source.cpu.flash[0] = 0xcfff; // RJMP -1 self-loop at main
    source.cpu.flash[INT0_VECTOR] = 0xcfff;
    source.cpu.writeData(EIMSK, 1 << INT0);
    source.cpu.writeData(EICRA, 0); // low level
    source.cpu.sreg.I = true;
    source.pin(2).setInput(false);

    const restored = AVR();
    restored.restore(source.snapshot());
    restored.runCycles(2);

    expect(restored.cpu.pc).toBe(INT0_VECTOR);
  });
});
