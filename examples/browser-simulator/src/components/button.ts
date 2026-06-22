import type { SimulatorRuntime } from "../runtime";

/**
 * Push-button widget that drives a digital pin. Pointer down sets the input high;
 * pointer up (or pointer leave) sets it low. The keyboard `Space` and `Enter`
 * keys also press the button when it has focus.
 */
export interface ButtonOptions {
  pin: number;
  label?: string;
}

export interface ButtonHandle {
  element: HTMLElement;
  /** Connector dot for the wiring model. */
  port: HTMLElement;
  /** Rebind to a different pin (used by the wiring model). */
  setPin(pin: number): boolean;
  destroy(): void;
}

export function createButton(runtime: SimulatorRuntime, options: ButtonOptions): ButtonHandle {
  const root = document.createElement("div");
  root.className = "button-widget";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "button-press";
  btn.setAttribute("aria-pressed", "false");

  const label = document.createElement("span");
  label.className = "button-label";

  const state = document.createElement("span");
  state.className = "button-state";

  btn.append(label, state);

  const port = document.createElement("div");
  port.className = "io-port";

  root.append(btn, port);

  let pin = options.pin;

  const setVisualState = (pressed: boolean): void => {
    root.dataset.state = pressed ? "pressed" : "released";
    btn.setAttribute("aria-pressed", String(pressed));
    state.textContent = pressed ? "HIGH" : "LOW";
  };

  const press = (): void => {
    setVisualState(true);
    runtime.setInput(pin, true);
  };

  const release = (): void => {
    setVisualState(false);
    runtime.setInput(pin, false);
  };

  const setPin = (next: number): boolean => {
    release();
    pin = next;
    root.dataset.pin = String(pin);
    label.textContent = `${options.label ?? "Button"} D${pin}`;
    return true;
  };
  setPin(pin);

  btn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    btn.setPointerCapture(event.pointerId);
    press();
  });
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("pointerleave", release);
  btn.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      press();
    }
  });
  btn.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      release();
    }
  });

  return {
    element: root,
    port,
    setPin,
    destroy() {
      root.remove();
    },
  };
}
