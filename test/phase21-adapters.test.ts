import { describe, expect, test } from "bun:test";
import {
  AVR,
  digitalLed,
  disabledPwm,
  localComponentRuntime,
  logicAnalyzer,
  momentaryButton,
  mountComponents,
  potentiometer,
  pwmMeter,
  serialMonitor,
  toggleSwitch,
  type AnalogInputOptions,
  type ComponentRuntime,
  type PinObservation,
  type PwmSignal,
} from "../src";

/**
 * Phase 21C - component adapters. Each adapter is exercised headless against a
 * hand-written fake `ComponentRuntime`; `localComponentRuntime` is smoke-tested
 * against a real in-process `AVR(...)`.
 */

interface Fake {
  runtime: ComponentRuntime;
  inputs: Array<{ pin: number; high: boolean }>;
  analogs: AnalogInputOptions[];
  writes: string[];
  emitPin(pin: number, high: boolean, cycles?: number): void;
  emitPwm(pin: number, signal: PwmSignal): void;
  emitSerial(text: string): void;
}

function makeFake(): Fake {
  const pinHandlers = new Map<number, Set<(o: PinObservation) => void>>();
  const pwmHandlers = new Map<number, Set<(s: PwmSignal) => void>>();
  const serialHandlers = new Set<(t: string) => void>();
  const pinLevels = new Map<number, boolean>();
  const pwmSignals = new Map<number, PwmSignal>();
  const inputs: Array<{ pin: number; high: boolean }> = [];
  const analogs: AnalogInputOptions[] = [];
  const writes: string[] = [];
  let serial = "";

  const add = <T>(map: Map<number, Set<T>>, key: number, handler: T): (() => void) => {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  };

  return {
    runtime: {
      setInput: (pin, high) => {
        inputs.push({ pin, high });
        pinLevels.set(pin, high);
      },
      setAnalog: (options) => analogs.push(options),
      readPin: (pin) => pinLevels.get(pin) ?? false,
      onPinChange: (pin, handler) => add(pinHandlers, pin, handler),
      readPwm: (pin) => pwmSignals.get(pin) ?? disabledPwm(),
      onPwmChange: (pin, handler) => add(pwmHandlers, pin, handler),
      serialText: () => serial,
      onSerialText: (handler) => {
        serialHandlers.add(handler);
        return () => serialHandlers.delete(handler);
      },
      serialWrite: (text) => writes.push(text),
    },
    inputs,
    analogs,
    writes,
    emitPin(pin, high, cycles = 0) {
      pinLevels.set(pin, high);
      for (const h of pinHandlers.get(pin) ?? []) h({ high, cycles });
    },
    emitPwm(pin, signal) {
      pwmSignals.set(pin, signal);
      for (const h of pwmHandlers.get(pin) ?? []) h(signal);
    },
    emitSerial(text) {
      serial += text;
      for (const h of serialHandlers) h(text);
    },
  };
}

describe("digitalLed", () => {
  test("lights when the pin reaches the active level", () => {
    const fake = makeFake();
    const led = digitalLed({ id: "led1", pin: 13 });
    led.attach(fake.runtime);
    expect(led.state().on).toBe(false);
    fake.emitPin(13, true);
    expect(led.state().on).toBe(true);
    fake.emitPin(13, false);
    expect(led.state().on).toBe(false);
  });

  test("supports active-low and live rebinding", () => {
    const fake = makeFake();
    const led = digitalLed({ id: "led1", pin: 7, activeHigh: false });
    led.attach(fake.runtime);
    fake.emitPin(7, false);
    expect(led.state().on).toBe(true); // active-low: LOW = on

    fake.emitPin(8, false); // pin 8 starts LOW => on for active-low
    led.setPin(8);
    expect(led.state().pin).toBe(8);
    expect(led.state().on).toBe(true);
  });
});

describe("momentaryButton / toggleSwitch", () => {
  test("button drives the pin on press/release and reports state", () => {
    const fake = makeFake();
    const button = momentaryButton({ id: "b1", pin: 2 });
    button.attach(fake.runtime);
    expect(fake.inputs).toEqual([{ pin: 2, high: false }]); // released level on attach

    button.press();
    expect(button.state().pressed).toBe(true);
    expect(fake.inputs.at(-1)).toEqual({ pin: 2, high: true });
    button.release();
    expect(fake.inputs.at(-1)).toEqual({ pin: 2, high: false });
  });

  test("active-low button drives LOW on press", () => {
    const fake = makeFake();
    const button = momentaryButton({ id: "b1", pin: 2, activeHigh: false });
    button.attach(fake.runtime);
    button.press();
    expect(fake.inputs.at(-1)).toEqual({ pin: 2, high: false });
  });

  test("toggle switch latches", () => {
    const fake = makeFake();
    const sw = toggleSwitch({ id: "s1", pin: 4 });
    sw.attach(fake.runtime);
    sw.toggle();
    expect(sw.state().on).toBe(true);
    expect(fake.inputs.at(-1)).toEqual({ pin: 4, high: true });
    sw.toggle();
    expect(sw.state().on).toBe(false);
  });
});

describe("potentiometer", () => {
  test("emits setAnalog on attach and setVolts", () => {
    const fake = makeFake();
    const pot = potentiometer({ id: "p1", channel: 0, volts: 2.5 });
    pot.attach(fake.runtime);
    expect(fake.analogs.at(-1)).toMatchObject({ channel: 0, volts: 2.5 });
    pot.setVolts(1.1);
    expect(pot.state().volts).toBe(1.1);
    expect(fake.analogs.at(-1)).toMatchObject({ channel: 0, volts: 1.1 });
  });
});

describe("serialMonitor", () => {
  test("mirrors TX text and sends RX text", () => {
    const fake = makeFake();
    const serial = serialMonitor({ id: "ser1" });
    serial.attach(fake.runtime);
    fake.emitSerial("hi ");
    fake.emitSerial("there");
    expect(serial.state().text).toBe("hi there");
    serial.send("ping\n");
    expect(fake.writes).toEqual(["ping\n"]);
    serial.clearDisplay();
    expect(serial.state().text).toBe("");
  });
});

describe("pwmMeter", () => {
  test("reflects PWM frames", () => {
    const fake = makeFake();
    const meter = pwmMeter({ id: "m1", pin: 9 });
    meter.attach(fake.runtime);
    expect(meter.state().enabled).toBe(false);
    fake.emitPwm(9, { channel: "A", enabled: true, inverted: false, duty: 0.5, value: 128, mode: "fast-pwm" });
    expect(meter.state()).toMatchObject({ pin: 9, enabled: true, duty: 0.5, value: 128 });
  });
});

describe("logicAnalyzer", () => {
  test("records edges and exports VCD", () => {
    const fake = makeFake();
    const la = logicAnalyzer({ id: "la1", pins: [2, 9] });
    la.attach(fake.runtime);
    fake.emitPin(2, true, 10);
    fake.emitPin(9, true, 20);
    fake.emitPin(2, false, 30);
    expect(la.state().sampleCount).toBe(3);

    const vcd = la.toVCD();
    expect(vcd).toContain("$var wire 1 ! D2 $end");
    expect(vcd).toContain("$var wire 1 \" D9 $end");
    expect(vcd).toContain("#10");
    expect(vcd).toContain("1!");
    expect(vcd).toContain("0!");
  });

  test("ring buffer is bounded and reports full", () => {
    const fake = makeFake();
    const la = logicAnalyzer({ id: "la1", pins: [2], capacity: 3 });
    la.attach(fake.runtime);
    for (let i = 0; i < 5; i += 1) fake.emitPin(2, i % 2 === 0, i);
    expect(la.samples()).toHaveLength(3);
    expect(la.state().full).toBe(true);
  });
});

describe("localComponentRuntime", () => {
  test("setInput is observable through readPin and onPinChange", () => {
    const avr = AVR();
    const runtime = localComponentRuntime(avr);
    let observed: boolean | null = null;
    runtime.onPinChange(2, (o) => (observed = o.high));
    runtime.setInput(2, true);
    expect(runtime.readPin(2)).toBe(true);
    expect(observed).toBe(true);
  });
});

describe("mountComponents", () => {
  test("attaches and detaches a set of adapters", () => {
    const fake = makeFake();
    const led = digitalLed({ id: "led1", pin: 13 });
    const button = momentaryButton({ id: "b1", pin: 2 });
    const mounted = mountComponents(fake.runtime, [led, button]);
    fake.emitPin(13, true);
    expect(led.state().on).toBe(true);
    mounted.detach();
    // After detach the LED no longer tracks the pin.
    fake.emitPin(13, false);
    expect(led.state().on).toBe(true);
  });
});
