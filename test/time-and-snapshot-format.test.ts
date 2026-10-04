import { describe, expect, test } from "bun:test";
import { AVR, AVR_SNAPSHOT_VERSION, CLKPCE, CLKPR, IntelHexError, type AVRSnapshot } from "../src";
import { INTEL_HEX_EOF, record } from "./helpers";

const RJMP_SELF = 0xcfff;
const LOOP = `${record([RJMP_SELF])}\n${INTEL_HEX_EOF}`;

/** Switch the system clock prescaler to 2^clkps via the CLKPCE protocol. */
function setPrescaler(avr: ReturnType<typeof AVR>, clkps: number): void {
  avr.cpu.writeData(CLKPR, 1 << CLKPCE);
  avr.cpu.writeData(CLKPR, clkps);
}

describe("simulated time across clock changes", () => {
  test("changing CLKPR does not rescale time that already elapsed", () => {
    const avr = AVR(LOOP); // 16 MHz
    avr.runCycles(16_000);
    expect(avr.status().timeMs).toBeCloseTo(1, 9);

    setPrescaler(avr, 1); // 8 MHz
    expect(avr.status().timeMs).toBeCloseTo(1, 9);

    avr.runCycles(8_000);
    expect(avr.status().timeMs).toBeCloseTo(2, 9);
  });

  test("pin events and status share the same time base", () => {
    const avr = AVR(LOOP);
    avr.runCycles(16_000);
    setPrescaler(avr, 1);
    avr.runCycles(8_000);

    let eventTime = -1;
    avr.pins.onChange((event) => {
      eventTime = event.timeMs;
    });
    avr.pin(2).setInput(true);
    expect(eventTime).toBeCloseTo(avr.status().timeMs, 9);
  });

  test("reset restarts time; snapshots carry the time base", () => {
    const avr = AVR(LOOP);
    avr.runCycles(16_000);
    setPrescaler(avr, 1);
    avr.runCycles(8_000);
    const snap = avr.snapshot();

    const restored = AVR().restore(snap);
    expect(restored.status().timeMs).toBeCloseTo(2, 9);

    avr.reset();
    expect(avr.status().timeMs).toBe(0);
  });
});

describe("snapshot format", () => {
  test("snapshots are stamped with the current format version", () => {
    expect(AVR().snapshot().version).toBe(AVR_SNAPSHOT_VERSION);
  });

  test("unversioned (pre-0.1) snapshots still restore", () => {
    const legacy: AVRSnapshot = AVR(LOOP).runCycles(100).snapshot();
    delete legacy.version;
    delete legacy.runtime.timeBaseMs;
    delete legacy.runtime.timeBaseCycles;
    expect(AVR().restore(legacy).status().cycles).toBe(legacy.cpu.cycles);
  });

  test("snapshots from a newer format are rejected before touching state", () => {
    const avr = AVR(LOOP).runCycles(100);
    const future = { ...avr.snapshot(), version: AVR_SNAPSHOT_VERSION + 1 };
    const target = AVR(LOOP).runCycles(6);
    expect(() => target.restore(future)).toThrow(/snapshot version/);
    expect(target.status().cycles).toBe(6);
  });

  test("snapshots for another chip or of the wrong shape are rejected", () => {
    const snap = AVR().snapshot();
    const otherChip = { ...snap, runtime: { ...snap.runtime, chip: "atmega2560" } } as unknown as AVRSnapshot;
    expect(() => AVR().restore(otherChip)).toThrow(/unsupported chip/);
    expect(() => AVR().restore({} as AVRSnapshot)).toThrow(/avr\.snapshot\(\)/);
  });
});

describe("AVR(string) input", () => {
  test("a bare name that is neither HEX text nor a path explains the options", () => {
    expect(() => AVR("firmware")).toThrow(IntelHexError);
    expect(() => AVR("firmware")).toThrow(/AVR\(\{ path \}\)/);
  });
});
