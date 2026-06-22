import type { SimulatorRuntime } from "../runtime";

/** LED widget bound to a digital pin. Subscribes to onChange for live updates. */
export interface LedOptions {
  pin: number;
  label?: string;
}

export interface LedHandle {
  element: HTMLElement;
  /** Connector dot for the wiring model. */
  port: HTMLElement;
  /** Rebind to a different pin (used by the wiring model). */
  setPin(pin: number): boolean;
  destroy(): void;
}

export function createLed(runtime: SimulatorRuntime, options: LedOptions): LedHandle {
  const root = document.createElement("div");
  root.className = "led-widget";

  const dot = document.createElement("div");
  dot.className = "led-dot";

  const caption = document.createElement("div");
  caption.className = "led-caption";

  const state = document.createElement("div");
  state.className = "led-state";

  const port = document.createElement("div");
  port.className = "io-port";

  root.append(dot, caption, state, port);

  let pin = options.pin;
  let pinOff: (() => void) | null = null;

  const apply = (high: boolean): void => {
    dot.classList.toggle("on", high);
    root.dataset.state = high ? "on" : "off";
    state.textContent = high ? "ON" : "OFF";
  };

  const refresh = (): void => apply(runtime.readPin(pin));

  const setPin = (next: number): boolean => {
    pin = next;
    root.dataset.pin = String(pin);
    caption.textContent = `${options.label ?? "LED"} D${pin}`;
    pinOff?.();
    pinOff = runtime.onPinChange(pin, (high) => apply(high));
    refresh();
    return true;
  };

  setPin(pin);
  const offs = [
    runtime.onRefresh(refresh),
  ];

  return {
    element: root,
    port,
    setPin,
    destroy() {
      pinOff?.();
      for (const off of offs) off();
      root.remove();
    },
  };
}
