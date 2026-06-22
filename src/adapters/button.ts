import { createStateStore } from "../component-bus";
import type { ComponentAdapter, ComponentRuntime } from "../component-bus";

/**
 * Digital source widgets that drive a pin's input level.
 *   - `momentaryButton`: high while pressed (press/release).
 *   - `toggleSwitch`: latches on/off.
 */
export interface ButtonState {
  pin: number;
  pressed: boolean;
}

export interface ButtonAdapter extends ComponentAdapter<ButtonState> {
  press(): void;
  release(): void;
  setPin(pin: number): void;
}

export interface ButtonOptions {
  id: string;
  pin: number;
  /** When true (default) pressing drives the pin HIGH; false drives it LOW. */
  activeHigh?: boolean;
}

export function momentaryButton(options: ButtonOptions): ButtonAdapter {
  const activeHigh = options.activeHigh ?? true;
  const store = createStateStore<ButtonState>({ pin: options.pin, pressed: false });
  let runtime: ComponentRuntime | null = null;

  const drive = (pressed: boolean): void => {
    const pin = store.get().pin;
    store.set({ pin, pressed });
    runtime?.setInput(pin, pressed ? activeHigh : !activeHigh);
  };

  return {
    id: options.id,
    type: "button",
    attach(rt) {
      runtime = rt;
      drive(false); // establish the released level
    },
    detach() {
      runtime = null;
      store.clear();
    },
    press: () => drive(true),
    release: () => drive(false),
    setPin(pin) {
      store.set({ pin, pressed: store.get().pressed });
      drive(store.get().pressed);
    },
    state: store.get,
    subscribe: store.subscribe,
  };
}

export interface SwitchState {
  pin: number;
  on: boolean;
}

export interface SwitchAdapter extends ComponentAdapter<SwitchState> {
  set(on: boolean): void;
  toggle(): void;
  setPin(pin: number): void;
}

export interface SwitchOptions extends ButtonOptions {
  on?: boolean;
}

export function toggleSwitch(options: SwitchOptions): SwitchAdapter {
  const activeHigh = options.activeHigh ?? true;
  const store = createStateStore<SwitchState>({ pin: options.pin, on: options.on ?? false });
  let runtime: ComponentRuntime | null = null;

  const apply = (on: boolean): void => {
    const pin = store.get().pin;
    store.set({ pin, on });
    runtime?.setInput(pin, on ? activeHigh : !activeHigh);
  };

  return {
    id: options.id,
    type: "button",
    attach(rt) {
      runtime = rt;
      apply(store.get().on);
    },
    detach() {
      runtime = null;
      store.clear();
    },
    set: (on) => apply(on),
    toggle: () => apply(!store.get().on),
    setPin(pin) {
      store.set({ pin, on: store.get().on });
      apply(store.get().on);
    },
    state: store.get,
    subscribe: store.subscribe,
  };
}
