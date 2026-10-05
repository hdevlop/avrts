 import { describe, expect, test } from "bun:test";
import { AVR, type AVRSnapshot } from "../src";
import {
  ADC_VECTOR,
  ADCSRA,
  ADEN,
  ADIE,
  ADIF,
  ADSC,
  CS00,
  CS01,
  CS02,
  CS10,
  DDRB,
  EICRA,
  EIFR,
  EIMSK,
  INT0,
  INTF0,
  ISC00,
  ISC01,
  OCIE0A,
  OCF0A,
  OCR0A,
  PCICR,
  PCIE0,
  PCIF0,
  PCIFR,
  PCINT0_VECTOR,
  PCMSK0,
  PORTB,
  RXEN0,
  SPCR,
  SPDR,
  SPE,
  SPIE,
  SPIF,
  SPI_STC_VECTOR,
  SPSR,
  TCCR0B,
  TCCR1B,
  TCCR2B,
  TCNT0,
  TCNT1H,
  TCNT1L,
  TCNT2,
  TIMER0_COMPA_VECTOR,
  TIMSK0,
  TXC0,
  TXCIE0,
  TXEN0,
  UCSR0A,
  UCSR0B,
  UDR0,
  USART_TX_VECTOR,
  MSTR,
} from "../src/cpu";
import { DEFAULT_SPI_TRANSFER_CYCLES, DEFAULT_USART_FRAME_CYCLES, INTEL_HEX_EOF, record } from "./helpers";

const HEX = {
  eof: INTEL_HEX_EOF,
  ldiR16: (imm: number): string => record([0xe000 | (imm & 0xf0) << 4 | (imm & 0x0f) | 0 << 4 | (16 - 16)]),
  // Easier: just hardcode a few programs we'll actually use.
};

function servicePending(avr: ReturnType<typeof AVR>, vector: number): void {
  avr.cpu.flash[vector] = 0xcfff; // rjmp -1 in handler
  avr.cpu.sreg.I = true;
  avr.cpu.tick();
  expect(avr.cpu.pc).toBe(vector);
}

function compareDirectAndRestoredInterruptAck(
  setup: (avr: ReturnType<typeof AVR>) => void,
  vector: number,
  flagAddress: number,
  flagMask: number,
): void {
  const direct = AVR();
  setup(direct);
  expect(direct.cpu.readData(flagAddress) & flagMask).toBe(flagMask);
  servicePending(direct, vector);
  expect(direct.cpu.readData(flagAddress) & flagMask).toBe(0);

  const restored = AVR();
  setup(restored);
  const snap = restored.snapshot();
  restored.restore(snap);
  expect(restored.cpu.readData(flagAddress) & flagMask).toBe(flagMask);
  servicePending(restored, vector);
  expect(restored.cpu.readData(flagAddress) & flagMask).toBe(0);
}

describe("Phase 10 — snapshot / restore (CPU)", () => {
  test("snapshot captures pc, cycles, and the data space", () => {
    // ldi r16, 0x2A ; rjmp -1
    const avr = AVR(record([0xe20a, 0xcfff]) + "\n" + HEX.eof);
    avr.runCycles(1); // LDI executed, r16 = 0x2A, pc -> rjmp

    const snap = avr.snapshot();
    expect(snap.cpu.pc).toBe(1);
    expect(snap.cpu.cycles).toBe(1);
    expect(snap.cpu.data[16]).toBe(0x2a);

    avr.runCycles(50);
    avr.restore(snap);
    expect(avr.cpu.pc).toBe(1);
    expect(avr.cpu.cycles).toBe(1);
    expect(avr.cpu.data[16]).toBe(0x2a);
  });

  test("running, advancing, restoring, then advancing again matches the first run", () => {
    // ldi r16, 0x2A ; ldi r17, 0x55 ; rjmp -1
    const avr = AVR(record([0xe20a, 0xe515, 0xcfff]) + "\n" + HEX.eof);
    avr.runCycles(2); // both LDIs execute

    const snap = avr.snapshot();
    avr.runCycles(100);

    avr.restore(snap);
    expect(avr.cpu.data[16]).toBe(0x2a);
    expect(avr.cpu.data[17]).toBe(0x55);

    // The same +100 cycles from the restored point should land at the same cycles.
    const before = avr.cpu.cycles;
    avr.runCycles(100);
    expect(avr.cpu.cycles).toBe(before + 100);
  });

  test("two runs from the same snapshot produce identical state", () => {
    // ldi r16, 0x2A ; ldi r17, 0x55 ; rjmp -1
    const program = record([0xe20a, 0xe515, 0xcfff]) + "\n" + HEX.eof;

    const trace = (): number[] => {
      const a = AVR(program);
      a.runCycles(2);
      const out: number[] = [];
      for (let i = 0; i < 100; i += 1) {
        a.step();
        out.push(a.cpu.data[16]!, a.cpu.data[17]!, a.cpu.pc);
      }
      return out;
    };

    const a = AVR(program);
    a.runCycles(2);
    const snap = a.snapshot();
    a.runCycles(100);
    const traceFirst = [...snapshotRegisters(a)];

    a.restore(snap);
    const traceSecond = [...snapshotRegisters(a)];

    expect(traceSecond).toEqual(traceFirst);

    // And stepping 100 more instructions from the restored snapshot should
    // reproduce a fresh trace identical to either of the above.
    const third: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      a.step();
      third.push(a.cpu.data[16]!, a.cpu.data[17]!, a.cpu.pc);
    }
    expect(third).toEqual(traceFirst);

    function snapshotRegisters(avr: ReturnType<typeof AVR>): number[] {
      const out: number[] = [];
      for (let i = 0; i < 100; i += 1) {
        avr.step();
        out.push(avr.cpu.data[16]!, avr.cpu.data[17]!, avr.cpu.pc);
      }
      return out;
    }
  });

  test("flash contents are part of the snapshot", () => {
    // NOP at flash[0]; rjmp -1
    const avr = AVR(record([0x0000, 0xcfff]) + "\n" + HEX.eof);
    expect(avr.cpu.flash[0]).toBe(0x0000);
    const snap = avr.snapshot();
    avr.cpu.flash[0] = 0xffff;
    avr.restore(snap);
    expect(avr.cpu.flash[0]).toBe(0x0000);
  });

  test("pending interrupts survive restore so they fire on the next tick", () => {
    const avr = AVR();
    avr.cpu.flash[0] = 0xcfff; // rjmp -1 main loop
    avr.cpu.flash[TIMER0_COMPA_VECTOR] = 0xcfff; // rjmp -1 in handler
    avr.cpu.sreg.I = true;
    avr.cpu.requestInterrupt(TIMER0_COMPA_VECTOR);

    const snap = avr.snapshot();
    avr.restore(snap);
    avr.cpu.tick();
    expect(avr.cpu.pc).toBe(TIMER0_COMPA_VECTOR);
  });

  test("restore does not tick cycle listeners or advance timer state", () => {
    const source = AVR();
    source.cpu.writeData(TCCR0B, 1 << CS00); // Timer0 /1
    source.runCycles(10);
    expect(source.cpu.readData(TCNT0)).toBe(10);
    const snap = source.snapshot();

    const target = AVR();
    let deliveredCycles = 0;
    target.cpu.onCycles((cycles) => {
      deliveredCycles += cycles;
    });

    target.restore(snap);

    expect(deliveredCycles).toBe(0);
    expect(target.cpu.cycles).toBe(10);
    expect(target.cpu.readData(TCNT0)).toBe(10);
  });

  test("restored Timer0 pending interrupts keep their flag acknowledge behavior", () => {
    compareDirectAndRestoredInterruptAck(
      (avr) => {
        avr.cpu.flash[0] = 0x0000; // nop
        avr.cpu.writeData(OCR0A, 1);
        avr.cpu.writeData(TIMSK0, 1 << OCIE0A);
        avr.cpu.writeData(TCCR0B, 1 << CS00);
        avr.runCycles(1);
      },
      TIMER0_COMPA_VECTOR,
      0x35,
      1 << OCF0A,
    );
  });

  test("restored ADC pending interrupts keep their flag acknowledge behavior", () => {
    compareDirectAndRestoredInterruptAck(
      (avr) => {
        avr.cpu.writeData(ADCSRA, (1 << ADEN) | (1 << ADIE) | (1 << ADSC));
        avr.runCycles(50);
      },
      ADC_VECTOR,
      ADCSRA,
      1 << ADIF,
    );
  });

  test("restored SPI pending interrupts keep their flag acknowledge behavior", () => {
    compareDirectAndRestoredInterruptAck(
      (avr) => {
        avr.cpu.writeData(DDRB, 1 << 2);
        avr.cpu.writeData(SPCR, (1 << SPE) | (1 << MSTR) | (1 << SPIE));
        avr.cpu.writeData(SPDR, 0x42);
        avr.runCycles(DEFAULT_SPI_TRANSFER_CYCLES);
      },
      SPI_STC_VECTOR,
      SPSR,
      1 << SPIF,
    );
  });

  test("restored USART TX pending interrupts keep their flag acknowledge behavior", () => {
    compareDirectAndRestoredInterruptAck(
      (avr) => {
        avr.cpu.writeData(UCSR0B, (1 << TXEN0) | (1 << TXCIE0));
        avr.cpu.writeData(UDR0, 0x41);
        avr.runCycles(DEFAULT_USART_FRAME_CYCLES);
      },
      USART_TX_VECTOR,
      UCSR0A,
      1 << TXC0,
    );
  });

  test("restored pin-change pending interrupts keep their flag acknowledge behavior", () => {
    compareDirectAndRestoredInterruptAck(
      (avr) => {
        avr.cpu.writeData(PCICR, 1 << PCIE0);
        avr.cpu.writeData(PCMSK0, 1 << 0);
        avr.pin(8).setInput(true); // PB0 / PCINT0
      },
      PCINT0_VECTOR,
      PCIFR,
      1 << PCIF0,
    );
  });

  test("restored external-interrupt pending interrupts keep their flag acknowledge behavior", () => {
    compareDirectAndRestoredInterruptAck(
      (avr) => {
        avr.cpu.writeData(EIMSK, 1 << INT0);
        avr.cpu.writeData(EICRA, (1 << ISC01) | (1 << ISC00)); // rising
        avr.pin(2).setInput(false);
        avr.pin(2).setInput(true);
      },
      0x0002,
      EIFR,
      1 << INTF0,
    );
  });
});

describe("Phase 10 — snapshot / restore (GPIO and pins)", () => {
  test("restored pin level matches pin().read()", () => {
    // Configure PB5 as output high: ldi r16, 0x20 ; out DDRB, r16 ; ldi r16, 0x20 ; out PORTB, r16 ; rjmp -1
    // LDI R16, 0x20 -> opcode 0xE200 (K=0x20 split as K_high=2, K_low=0, d=0 for R16).
    // OUT 0x04, R16 -> 0xB904. OUT 0x05, R16 -> 0xB905. RJMP -1 -> 0xCFFF.
    const program =
      record([0xe200, 0xb904, 0xe200, 0xb905, 0xcfff]) + "\n" + HEX.eof;
    const avr = AVR(program);
    avr.runCycles(4);
    expect(avr.pin(13).read()).toBe(true);

    const snap = avr.snapshot();
    avr.runCycles(100);
    avr.restore(snap);

    expect(avr.pin(13).read()).toBe(true);
    expect(avr.cpu.data[PORTB]).toBe(0x20);
    expect(avr.cpu.data[DDRB]).toBe(0x20);
  });

  test("restore to a visibly-different pin state fires onChange", () => {
    const avr = AVR();
    const events: Array<[boolean, number]> = [];
    avr.pin(2).onChange((high, event) => events.push([high, event.cycles]));

    avr.pin(2).setInput(false);
    avr.runCycles(5);
    events.length = 0;

    // Build a snapshot where pin 2 is high by directly writing PINx data.
    const snap = avr.snapshot();
    snap.gpio.pin.D |= 0x04; // PIND bit 2 = pin 2
    avr.restore(snap);

    expect(avr.pin(2).read()).toBe(true);
    expect(events).toEqual([[true, snap.cpu.cycles]]);
  });

  test("restoring the same snapshot does not double-fire pin listeners", () => {
    const avr = AVR();
    const events: boolean[] = [];
    avr.pin(13).onChange((high) => events.push(high));

    avr.pin(13).setInput(true);
    avr.runCycles(2);
    events.length = 0;

    const snap = avr.snapshot();
    avr.runCycles(50);
    expect(events.length).toBe(0);

    avr.restore(snap);
    expect(events.length).toBe(0);
  });

  test("restore does not duplicate pin listeners when invoked twice", () => {
    const avr = AVR();
    let count = 0;
    avr.pin(13).onChange(() => {
      count += 1;
    });

    avr.pin(13).setInput(true);
    avr.runCycles(1);
    const afterFirst = count;

    const snap = avr.snapshot();
    avr.runCycles(5);

    avr.restore(snap);
    avr.pin(13).setInput(false); // drive an edge so the listener fires again
    avr.runCycles(1);

    expect(count).toBe(afterFirst + 1);
  });
});

describe("Phase 10 — snapshot / restore (Serial)", () => {
  test("serial text round-trips through snapshot/restore", async () => {
    const hex = await Bun.file(
      new URL("../examples/arduino-serial-print/arduino-serial-print.ino.hex", import.meta.url),
    ).text();
    const avr = AVR(hex);
    avr.runCycles(50_000);
    const textBefore = avr.serial.getText();
    expect(textBefore.length).toBeGreaterThan(0);

    const snap = avr.snapshot();
    avr.runCycles(50_000);
    avr.restore(snap);

    expect(avr.serial.getText()).toBe(textBefore);
  });
});

describe("Phase 10 — snapshot / restore (Timers)", () => {
  for (const [name, control, counter, select] of [
    ["Timer0", TCCR0B, TCNT0, 3],
    ["Timer2", TCCR2B, TCNT2, 4],
  ] as const) {
    test(`${name} snapshot synchronizes counters before capturing CPU data`, () => {
      const avr = AVR();
      avr.cpu.writeData(control, select); // /64; snapshot between scheduled events.
      avr.runCycles(100);
      const snapshot = avr.snapshot(); // No prior TCNT read to synchronize it.
      expect(snapshot.cpu.data[counter]).toBe(1);
      expect(avr.snapshot()).toEqual(snapshot);

      const restored = AVR().restore(snapshot);
      expect(restored.cpu.readData(counter)).toBe(1);
      avr.runCycles(64);
      restored.runCycles(64);
      expect(restored.cpu.readData(counter)).toBe(avr.cpu.readData(counter));
      expect(restored.cpu.readData(counter)).toBe(2);
    });
  }

  test("Timer0 continues from a restored prescaler remainder", () => {
    const avr = AVR();
    // Configure Timer0 with prescaler /8 so 1 timer tick = 8 CPU cycles.
    avr.cpu.writeData(TCCR0B, (1 << CS01)); // TCCR0B = 0b010 -> /8

    // Advance 4 CPU cycles — remainder = 4, no tick yet.
    avr.runCycles(4);
    expect(avr.cpu.readData(TCNT0)).toBe(0);

    const snap = avr.snapshot();
    avr.runCycles(6);
    expect(avr.cpu.readData(TCNT0)).toBe(1);

    // Restore and verify the same +6 advances TCNT0 to 1.
    avr.restore(snap);
    avr.runCycles(6);
    expect(avr.cpu.readData(TCNT0)).toBe(1);
  });

  test("Timer1 count survives snapshot/restore", () => {
    const avr = AVR();
    avr.cpu.writeData(TCCR1B, (1 << CS10)); // /1 prescaler
    avr.runCycles(0x1234);

    const snap = avr.snapshot();
    const beforeCount =
      avr.cpu.readData(TCNT1L) | (avr.cpu.readData(TCNT1H) << 8);

    avr.runCycles(0x100);
    avr.restore(snap);

    const afterCount =
      avr.cpu.readData(TCNT1L) | (avr.cpu.readData(TCNT1H) << 8);
    expect(afterCount).toBe(beforeCount);
  });

  test("Timer0 overflow event timing is identical after restore", async () => {
    const hex = await Bun.file(
      new URL("../examples/timer0-overflow-blink/timer0-overflow-blink.hex", import.meta.url),
    ).text();

    // Run the same sketch from the same starting cycle, once directly and once
    // via snapshot/restore. Edge timings should be identical.

    const runFromCycle = (startCycle: number, thenMore: number): number[] => {
      const a = AVR(hex);
      a.runCycles(startCycle);
      const snap = a.snapshot();
      const out: number[] = [];
      a.pin(13).onChange((_high, event) => out.push(event.cycles));
      a.restore(snap); // restore as a no-op — establishes the listener state
      a.runCycles(thenMore);
      return out;
    };

    const runViaSnap = (startCycle: number, thenMore: number): number[] => {
      const a = AVR(hex);
      a.runCycles(startCycle);
      const snap = a.snapshot();
      // Discard the first AVR — we want the second one to start from a clean state.
      const b = AVR(hex);
      b.runCycles(startCycle);
      b.restore(snap);
      const out: number[] = [];
      b.pin(13).onChange((_high, event) => out.push(event.cycles));
      b.runCycles(thenMore);
      return out;
    };

    const reference = runFromCycle(256 * 4, 256 * 8);
    const fromSnap = runViaSnap(256 * 4, 256 * 8);

    expect(fromSnap.length).toBe(reference.length);
    for (let i = 0; i < reference.length; i += 1) {
      expect(fromSnap[i]).toBe(reference[i]);
    }
  });
});

describe("Phase 10 — snapshot / restore (EEPROM and ADC)", () => {
  test("EEPROM survives a normal reset()", () => {
    const avr = AVR();
    avr.eeprom.write(0x10, 0x55);
    avr.reset();
    expect(avr.eeprom.read(0x10)).toBe(0x55);
  });

  test("snapshot/restore reverts EEPROM to the snapshotted image", () => {
    const avr = AVR();
    avr.eeprom.write(0x10, 0x55);
    const snap = avr.snapshot();
    avr.eeprom.write(0x10, 0xaa);
    expect(avr.eeprom.read(0x10)).toBe(0xaa);
    avr.restore(snap);
    expect(avr.eeprom.read(0x10)).toBe(0x55);
  });

  test("ADC channel values round-trip", () => {
    const avr = AVR();
    avr.analog(3).setValue(0x200);
    avr.analog(5).setValue(0x3ff);
    const snap = avr.snapshot();

    avr.analog(3).setValue(0x000);
    avr.restore(snap);
    expect(avr.analog(3).read()).toBe(0x200);
    expect(avr.analog(5).read()).toBe(0x3ff);
  });
});

describe("Phase 10 — snapshot / restore (Runtime state)", () => {
  test("runtime fields: clock, chip, speed, serialText, programSource", () => {
    const avr = AVR({ hex: HEX.eof, clockHz: 8_000_000 });
    avr.setSpeed(7);

    const snap = avr.snapshot();
    expect(snap.runtime.clockHz).toBe(8_000_000);
    expect(snap.runtime.chip).toBe("atmega328p");
    expect(snap.runtime.speed).toBe(7);
    expect(snap.runtime.programSource).toBe(HEX.eof);
    expect(snap.runtime.serialText).toBe("");

    avr.useClock(1_000_000);
    avr.setSpeed(1);
    avr.restore(snap);

    expect(avr.status().clockHz).toBe(8_000_000);
    expect(avr.status().speed).toBe(7);
  });

  test("restore emits one UI refresh event without replaying serial text", () => {
    const avr = AVR();
    const events: Array<{ type: string; serial: string; cycles: number }> = [];
    const textEvents: string[] = [];

    avr.serial.write("a");
    avr.runCycles(7);
    const snap = avr.snapshot();
    avr.serial.write("b");

    avr.serial.onText((text) => textEvents.push(text));
    avr.on("restore", (event) => {
      events.push({
        type: event.type,
        serial: avr.serial.getText(),
        cycles: event.status.cycles,
      });
    });

    avr.restore(snap);

    expect(avr.serial.getText()).toBe("");
    expect(events).toEqual([{ type: "restore", serial: "", cycles: 7 }]);
    expect(textEvents).toEqual([]);
  });

  test("running/paused flags re-arm the loop after restore", () => {
    const avr = AVR();
    avr.start();
    expect(avr.status().running).toBe(true);

    const snap = avr.snapshot();
    avr.stop();
    expect(avr.status().running).toBe(false);

    avr.restore(snap);
    expect(avr.status().running).toBe(true);
    avr.stop();
  });

  test("restore cancels an active loop if the snapshot said not running", () => {
    const avr = AVR();
    avr.start();
    const snapRunning = avr.snapshot();
    avr.stop();
    const snapStopped = avr.snapshot();

    avr.restore(snapRunning);
    expect(avr.status().running).toBe(true);
    avr.stop();

    avr.start();
    avr.restore(snapStopped);
    expect(avr.status().running).toBe(false);
  });
});

describe("Phase 10 — snapshot shape is plain data", () => {
  test("snapshot is fully serializable (no functions, no class instances)", () => {
    const avr = AVR();
    avr.cpu.writeData(OCR0A, 0x80);
    avr.cpu.writeData(PORTB, 0x20);
    avr.analog(0).setValue(0x123);
    avr.eeprom.write(0x00, 0xab);
    avr.serial.write("hi");

    const snap = avr.snapshot();
    const { version, ...sections } = snap;
    expect(typeof version).toBe("number");
    for (const [key, value] of Object.entries(sections)) {
      expect(typeof value).toBe("object");
      expect(value).not.toBeNull();
      for (const inner of Object.values(value as object)) {
        if (typeof inner === "function") {
          throw new Error(`Snapshot field ${key} contains a function`);
        }
      }
    }
    expect(snap.cpu.data).toBeInstanceOf(Uint8Array);
    expect(snap.cpu.flash).toBeInstanceOf(Uint16Array);
    expect(snap.usart0.rxBytes).toBeInstanceOf(Uint8Array);
    expect(snap.adc.channels).toBeInstanceOf(Uint16Array);
    expect(snap.eeprom.cells).toBeInstanceOf(Uint8Array);

    // Mutating the snapshot must not affect the live CPU.
    const originalPortB = avr.cpu.data[PORTB];
    snap.cpu.data[PORTB] = 0xff;
    expect(avr.cpu.data[PORTB]).toBe(originalPortB);
  });
});
