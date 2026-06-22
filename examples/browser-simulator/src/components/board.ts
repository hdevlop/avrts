import { PWM_PINS } from "./pwm-display";
import type { SimulatorRuntime } from "../runtime";

/**
 * Board pin-header strip. Renders one labelled connector per digital pin
 * (D0-D13). Each pin cell also mirrors the effective virtual pin state so
 * users can see firmware output and injected input activity directly.
 */
export interface BoardPort {
  pin: number;
  el: HTMLElement;
}

export interface BoardHandle {
  element: HTMLElement;
  ports: BoardPort[];
  destroy(): void;
}

const DIGITAL_PINS = Array.from({ length: 14 }, (_, pin) => pin); // D0..D13

export function createBoard(runtime: SimulatorRuntime): BoardHandle {
  const root = document.createElement("div");
  root.className = "board-widget";

  const title = document.createElement("div");
  title.className = "board-title";
  title.textContent = "ATmega328P digital pins";
  root.append(title);

  const grid = document.createElement("div");
  grid.className = "board-grid";
  root.append(grid);

  const ports: BoardPort[] = [];
  const refreshers: Array<() => void> = [];
  const offs: Array<() => void> = [];

  for (const pin of DIGITAL_PINS) {
    const cell = document.createElement("div");
    cell.className = "board-pin";
    cell.dataset.pin = String(pin);
    if (PWM_PINS.includes(pin)) cell.classList.add("pwm-capable");

    const dot = document.createElement("div");
    dot.className = "pin-port";
    dot.title = `D${pin}`;

    const label = document.createElement("span");
    label.className = "pin-label";
    label.textContent = `D${pin}${PWM_PINS.includes(pin) ? "~" : ""}`;

    const state = document.createElement("span");
    state.className = "pin-state";

    const refresh = (): void => {
      const high = runtime.readPin(pin);
      cell.dataset.state = high ? "high" : "low";
      state.textContent = high ? "HIGH" : "LOW";
    };

    offs.push(runtime.onPinChange(pin, refresh));
    refreshers.push(refresh);

    cell.append(dot, label, state);
    grid.append(cell);
    ports.push({ pin, el: dot });
  }

  const refreshAll = (): void => {
    for (const refresh of refreshers) refresh();
  };
  offs.push(
    runtime.onRefresh(refreshAll),
  );
  refreshAll();

  return {
    element: root,
    ports,
    destroy() {
      for (const off of offs) off();
      root.remove();
    },
  };
}
