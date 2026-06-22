import { createStateStore } from "../component-bus";
import type { ComponentAdapter, ComponentRuntime } from "../component-bus";

/** Digital LED sink: lit when its pin is at the active level. */
export interface LedState {
  pin: number;
  on: boolean;
}

export interface LedAdapter extends ComponentAdapter<LedState> {
  setPin(pin: number): void;
}

export interface LedOptions {
  id: string;
  pin: number;
  /** When true (default) the LED lights on a HIGH pin; false for active-low. */
  activeHigh?: boolean;
}

export function digitalLed(options: LedOptions): LedAdapter {
  const activeHigh = options.activeHigh ?? true;
  const store = createStateStore<LedState>({ pin: options.pin, on: false });
  let runtime: ComponentRuntime | null = null;
  let off: (() => void) | null = null;

  const apply = (high: boolean): void => {
    store.set({ pin: store.get().pin, on: high === activeHigh });
  };

  const bind = (pin: number): void => {
    off?.();
    store.set({ pin, on: store.get().on });
    if (!runtime) return;
    apply(runtime.readPin(pin));
    off = runtime.onPinChange(pin, (observation) => apply(observation.high));
  };

  return {
    id: options.id,
    type: "led",
    attach(rt) {
      runtime = rt;
      bind(store.get().pin);
    },
    detach() {
      off?.();
      off = null;
      runtime = null;
      store.clear();
    },
    setPin: (pin) => bind(pin),
    state: store.get,
    subscribe: store.subscribe,
  };
}
