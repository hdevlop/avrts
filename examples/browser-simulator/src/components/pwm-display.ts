import type { SimulatorRuntime } from "../runtime";

/**
 * PWM display: shows the current duty cycle (0..100%) as a bar plus the
 * underlying PwmSignal details (mode, value, inverted flag).
 */
export interface PwmDisplayOptions {
  pin: number;
  label?: string;
}

export interface PwmDisplayHandle {
  element: HTMLElement;
  /** Connector dot for the wiring model. */
  port: HTMLElement;
  /** Rebind to a different PWM pin (used by the wiring model). */
  setPin(pin: number): boolean;
  destroy(): void;
}

/** Arduino pins that have a PWM (timer compare) output. */
export const PWM_PINS = [3, 5, 6, 9, 10, 11];

export function createPwmDisplay(
  runtime: SimulatorRuntime,
  options: PwmDisplayOptions,
): PwmDisplayHandle {
  const root = document.createElement("div");
  root.className = "pwm-widget";

  const title = document.createElement("div");
  title.className = "pwm-title";

  const bar = document.createElement("div");
  bar.className = "pwm-bar";

  const fill = document.createElement("div");
  fill.className = "pwm-fill";
  bar.append(fill);

  const percent = document.createElement("div");
  percent.className = "pwm-percent";

  const detail = document.createElement("div");
  detail.className = "pwm-detail";

  const port = document.createElement("div");
  port.className = "io-port";

  root.append(title, bar, percent, detail, port);

  let pin = options.pin;
  let pwmOff: (() => void) | null = null;

  const apply = (): void => {
    const signal = runtime.readPwm(pin);
    const duty = Math.round(signal.duty * 1000) / 10;
    fill.style.width = `${duty}%`;
    root.dataset.state = signal.enabled ? "active" : "off";
    percent.textContent = signal.enabled ? `${duty.toFixed(1)}%` : "off";
    detail.textContent = signal.enabled
      ? `${signal.mode}${signal.inverted ? " inverted" : ""} value ${signal.value}`
      : "PWM disabled";
  };

  const setPin = (next: number): boolean => {
    if (!PWM_PINS.includes(next)) {
      root.dataset.rejected = "true";
      window.setTimeout(() => delete root.dataset.rejected, 450);
      return false;
    }

    pin = next;
    root.dataset.pin = String(pin);
    title.textContent = `${options.label ?? "PWM"} D${pin}`;
    pwmOff?.();
    pwmOff = runtime.onPwmChange(pin, () => apply());
    apply();
    return true;
  };
  setPin(pin);

  const offs = [
    runtime.onRefresh(apply),
  ];

  return {
    element: root,
    port,
    setPin,
    destroy() {
      pwmOff?.();
      for (const off of offs) off();
      root.remove();
    },
  };
}
