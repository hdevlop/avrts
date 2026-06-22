import { describe, expect, test } from "bun:test";
import {
  computeSquareWave,
  disabledPwm,
  pinActivity,
  scope,
  type AnalogInputOptions,
  type ComponentRuntime,
  type PinObservation,
  type PwmSignal,
} from "../src";

/** Phase 21D - instrument data models (headless). */

interface Fake {
  runtime: ComponentRuntime;
  emitPin(pin: number, high: boolean, cycles?: number): void;
}

function makeFake(): Fake {
  const pinHandlers = new Map<number, Set<(o: PinObservation) => void>>();
  const pinLevels = new Map<number, boolean>();
  return {
    runtime: {
      setInput: () => {},
      setAnalog: (_: AnalogInputOptions) => {},
      readPin: (pin) => pinLevels.get(pin) ?? false,
      onPinChange: (pin, handler) => {
        let set = pinHandlers.get(pin);
        if (!set) pinHandlers.set(pin, (set = new Set()));
        set.add(handler);
        return () => set!.delete(handler);
      },
      readPwm: (): PwmSignal => disabledPwm(),
      onPwmChange: () => () => {},
      serialText: () => "",
      onSerialText: () => () => {},
      serialWrite: () => {},
    },
    emitPin(pin, high, cycles = 0) {
      pinLevels.set(pin, high);
      for (const h of pinHandlers.get(pin) ?? []) h({ high, cycles });
    },
  };
}

describe("pinActivity", () => {
  test("tracks level, edge count and last edge cycle", () => {
    const fake = makeFake();
    const strip = pinActivity({ id: "pa1", pins: [2, 13] });
    strip.attach(fake.runtime);

    fake.emitPin(13, true, 100);
    fake.emitPin(13, false, 250);
    fake.emitPin(2, true, 300);

    const channels = strip.state().channels;
    const d13 = channels.find((c) => c.pin === 13)!;
    const d2 = channels.find((c) => c.pin === 2)!;
    expect(d13).toMatchObject({ high: false, edges: 2, lastEdgeCycles: 250 });
    expect(d2).toMatchObject({ high: true, edges: 1, lastEdgeCycles: 300 });
  });

  test("defaults to D0..D13 and resets counters", () => {
    const fake = makeFake();
    const strip = pinActivity({ id: "pa1" });
    strip.attach(fake.runtime);
    expect(strip.state().channels).toHaveLength(14);
    fake.emitPin(5, true, 10);
    expect(strip.state().channels.find((c) => c.pin === 5)!.edges).toBe(1);
    strip.resetCounters();
    expect(strip.state().channels.find((c) => c.pin === 5)!.edges).toBe(0);
  });
});

describe("computeSquareWave", () => {
  test("estimates frequency and duty from edges", () => {
    // Rising at 0/200/400, falling at 100/300 -> period 200 cycles, 50% duty.
    const edges = [
      { high: true, cycles: 0 },
      { high: false, cycles: 100 },
      { high: true, cycles: 200 },
      { high: false, cycles: 300 },
      { high: true, cycles: 400 },
    ];
    const result = computeSquareWave(edges, 16_000_000);
    expect(result.frequencyHz).toBeCloseTo(80_000, 5); // 16e6 / 200
    expect(result.dutyCycle).toBeCloseTo(0.5, 5);
  });

  test("returns null without enough rising edges", () => {
    expect(computeSquareWave([{ high: true, cycles: 0 }], 16_000_000)).toEqual({
      frequencyHz: null,
      dutyCycle: null,
    });
  });
});

describe("scope", () => {
  test("reports a frequency estimate after enough edges", () => {
    const fake = makeFake();
    const sc = scope({ id: "sc1", pin: 11, clockHz: 16_000_000 });
    sc.attach(fake.runtime);
    fake.emitPin(11, true, 0);
    fake.emitPin(11, false, 100);
    fake.emitPin(11, true, 200);
    const state = sc.state();
    expect(state.pin).toBe(11);
    expect(state.high).toBe(true);
    expect(state.frequencyHz).toBeCloseTo(80_000, 5);
  });

  test("clear() resets the captured edges", () => {
    const fake = makeFake();
    const sc = scope({ id: "sc1", pin: 11 });
    sc.attach(fake.runtime);
    fake.emitPin(11, true, 0);
    fake.emitPin(11, true, 200);
    expect(sc.state().sampleCount).toBe(2);
    sc.clear();
    expect(sc.state().sampleCount).toBe(0);
    expect(sc.state().frequencyHz).toBeNull();
  });
});
