import type { AVR } from "./avr";
import type { AnalogInputOptions, AVRWorkerRuntime, PinFrame, PwmFrame } from "./browser-runtime";
import type { PwmSignal } from "./peripherals";

/**
 * Component runtime port (Phase 21C).
 *
 * Component adapters talk to the simulator through this narrow port instead of
 * touching `AVR`, the worker, or the CPU directly. Two implementations are
 * provided:
 *
 *   - `localComponentRuntime(avr)`  - drives the in-process `AVR(...)` facade.
 *   - `workerComponentRuntime(worker)` - consumes coalesced worker frames.
 *
 * Because the port is small and synchronous-to-subscribe, adapters are fully
 * testable headless with a hand-written fake runtime.
 */

/** A normalized pin edge observation (high level + simulated cycle count). */
export interface PinObservation {
  high: boolean;
  cycles: number;
}

export interface ComponentRuntime {
  setInput(pin: number, high: boolean): void;
  setAnalog(options: AnalogInputOptions): void;
  readPin(pin: number): boolean;
  onPinChange(pin: number, handler: (observation: PinObservation) => void): () => void;
  readPwm(pin: number): PwmSignal;
  onPwmChange(pin: number, handler: (signal: PwmSignal) => void): () => void;
  serialText(): string;
  onSerialText(handler: (text: string) => void): () => void;
  serialWrite(text: string): void;
}

/**
 * A reusable, DOM-free simulator component. Sinks consume runtime events; sources
 * emit runtime commands. `state()` is a render snapshot; `subscribe` notifies on
 * any state change.
 */
export interface ComponentAdapter<State> {
  readonly id: string;
  readonly type: string;
  attach(runtime: ComponentRuntime): void;
  detach(): void;
  state(): State;
  subscribe(listener: (state: State) => void): () => void;
}

/** Shared state-store helper for adapters: holds state + notifies subscribers. */
export function createStateStore<State>(initial: State) {
  let current = initial;
  const listeners = new Set<(state: State) => void>();
  return {
    get: (): State => current,
    set(next: State): void {
      current = next;
      for (const listener of [...listeners]) listener(current);
    },
    subscribe(listener: (state: State) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear(): void {
      listeners.clear();
    },
  };
}

export function disabledPwm(): PwmSignal {
  return { channel: "A", enabled: false, inverted: false, duty: 0, value: 0, mode: "off" };
}

// --- local runtime (in-process AVR facade) ---------------------------------

export function localComponentRuntime(avr: AVR): ComponentRuntime {
  return {
    setInput: (pin, high) => avr.pin(pin).setInput(high),
    setAnalog: (options) => {
      if ("volts" in options) {
        avr.analog(options.channel).setVoltage(options.volts, options.referenceVolts);
      } else {
        avr.analog(options.channel).setValue(options.value);
      }
    },
    readPin: (pin) => avr.pin(pin).read(),
    onPinChange: (pin, handler) =>
      avr.pin(pin).onChange((high, event) => handler({ high, cycles: event.cycles })),
    readPwm: (pin) => avr.pwm(pin).read(),
    onPwmChange: (pin, handler) => avr.pwm(pin).onChange(handler),
    serialText: () => avr.serial.getText(),
    onSerialText: (handler) => avr.serial.onText(handler),
    serialWrite: (text) => avr.serial.write(text),
  };
}

// --- worker runtime (consumes coalesced frames) ----------------------------

/**
 * Wrap an `AVRWorkerRuntime` as a `ComponentRuntime`. Frame events are coalesced
 * by the worker; this keeps the latest pin/PWM state and fans out to per-pin
 * subscribers. `readPin`/`readPwm` reflect the most recent frame.
 */
export function workerComponentRuntime(worker: AVRWorkerRuntime): ComponentRuntime {
  const pinState = new Map<number, boolean>();
  const pinCycles = new Map<number, number>();
  const pwmState = new Map<number, PwmSignal>();
  const pinListeners = new Map<number, Set<(o: PinObservation) => void>>();
  const pwmListeners = new Map<number, Set<(s: PwmSignal) => void>>();
  const serialListeners = new Set<(text: string) => void>();
  let text = "";

  const fanoutPin = (frame: PinFrame): void => {
    pinState.set(frame.pin, frame.high);
    pinCycles.set(frame.pin, frame.cycles);
    const set = pinListeners.get(frame.pin);
    if (set) for (const handler of [...set]) handler({ high: frame.high, cycles: frame.cycles });
  };

  const fanoutPwm = (frame: PwmFrame): void => {
    const { pin, ...signal } = frame;
    pwmState.set(pin, signal);
    const set = pwmListeners.get(pin);
    if (set) for (const handler of [...set]) handler(signal);
  };

  worker.on("frame", (event) => {
    for (const pin of event.pins) fanoutPin(pin);
    for (const pwm of event.pwm) fanoutPwm(pwm);
  });
  worker.on("serial", (event) => {
    text += event.text;
    for (const handler of [...serialListeners]) handler(event.text);
  });

  const subscribe = <T>(map: Map<number, Set<T>>, key: number, handler: T): (() => void) => {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  };

  return {
    setInput: (pin, high) => worker.setInput(pin, high),
    setAnalog: (options) => worker.setAnalog(options),
    readPin: (pin) => pinState.get(pin) ?? false,
    onPinChange: (pin, handler) => subscribe(pinListeners, pin, handler),
    readPwm: (pin) => pwmState.get(pin) ?? disabledPwm(),
    onPwmChange: (pin, handler) => subscribe(pwmListeners, pin, handler),
    serialText: () => text,
    onSerialText: (handler) => {
      serialListeners.add(handler);
      return () => serialListeners.delete(handler);
    },
    serialWrite: (text) => worker.serialWrite(text),
  };
}

// --- convenience: attach a set of adapters to a runtime --------------------

export interface MountedComponents {
  detach(): void;
}

export function mountComponents(
  runtime: ComponentRuntime,
  components: ReadonlyArray<ComponentAdapter<unknown>>,
): MountedComponents {
  for (const component of components) component.attach(runtime);
  return {
    detach() {
      for (const component of components) component.detach();
    },
  };
}
