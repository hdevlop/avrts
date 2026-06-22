import { createStateStore, disabledPwm } from "../component-bus";
import type { ComponentAdapter, ComponentRuntime } from "../component-bus";
import type { PwmSignal } from "../peripherals";

/** PWM meter: reflects a PWM-capable pin's duty/value/mode. */
export interface PwmMeterState extends PwmSignal {
  pin: number;
}

export interface PwmMeterAdapter extends ComponentAdapter<PwmMeterState> {
  setPin(pin: number): void;
}

export interface PwmMeterOptions {
  id: string;
  pin: number;
}

export function pwmMeter(options: PwmMeterOptions): PwmMeterAdapter {
  const store = createStateStore<PwmMeterState>({ pin: options.pin, ...disabledPwm() });
  let runtime: ComponentRuntime | null = null;
  let off: (() => void) | null = null;

  const apply = (signal: PwmSignal): void => {
    store.set({ ...signal, pin: store.get().pin });
  };

  const bind = (pin: number): void => {
    off?.();
    store.set({ ...store.get(), pin });
    if (!runtime) return;
    apply(runtime.readPwm(pin));
    off = runtime.onPwmChange(pin, apply);
  };

  return {
    id: options.id,
    type: "pwm-meter",
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
