import { createStateStore } from "../component-bus";
import type { ComponentAdapter, ComponentRuntime } from "../component-bus";

/** Analog source: drives an ADC channel with a voltage (potentiometer/slider). */
export interface PotentiometerState {
  channel: number;
  volts: number;
}

export interface PotentiometerAdapter extends ComponentAdapter<PotentiometerState> {
  setVolts(volts: number): void;
}

export interface PotentiometerOptions {
  id: string;
  channel: number;
  volts?: number;
  /** ADC reference voltage to model against (defaults to the runtime default). */
  referenceVolts?: number;
}

export function potentiometer(options: PotentiometerOptions): PotentiometerAdapter {
  const store = createStateStore<PotentiometerState>({
    channel: options.channel,
    volts: options.volts ?? 0,
  });
  let runtime: ComponentRuntime | null = null;

  const apply = (volts: number): void => {
    store.set({ channel: store.get().channel, volts });
    runtime?.setAnalog({ channel: store.get().channel, volts, referenceVolts: options.referenceVolts });
  };

  return {
    id: options.id,
    type: "potentiometer",
    attach(rt) {
      runtime = rt;
      apply(store.get().volts);
    },
    detach() {
      runtime = null;
      store.clear();
    },
    setVolts: (volts) => apply(volts),
    state: store.get,
    subscribe: store.subscribe,
  };
}
