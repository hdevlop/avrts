import type { SimulatorRuntime } from "../runtime";

/**
 * Serial monitor: shows firmware-transmitted text on top, host-to-firmware RX on
 * the bottom. The host input is buffered (CR + LF) and sent through `serial.write`.
 */
export interface SerialMonitorOptions {
  label?: string;
}

export interface SerialMonitorHandle {
  element: HTMLElement;
  destroy(): void;
}

export function createSerialMonitor(
  runtime: SimulatorRuntime,
  options: SerialMonitorOptions = {},
): SerialMonitorHandle {
  const root = document.createElement("div");
  root.className = "serial-widget";

  const title = document.createElement("div");
  title.className = "serial-title";
  title.textContent = options.label ?? "Serial monitor";

  const log = document.createElement("pre");
  log.className = "serial-log";
  log.tabIndex = 0;
  log.setAttribute("aria-live", "polite");

  const form = document.createElement("form");
  form.className = "serial-form";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type and press Enter to send to firmware";
  input.autocomplete = "off";
  input.spellcheck = false;

  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Send";

  form.append(input, send);
  root.append(title, log, form);

  const refresh = (): void => {
    log.textContent = runtime.serialText();
    log.scrollTop = log.scrollHeight;
  };

  const offs = [
    runtime.onSerialText((text) => {
      log.textContent += text;
      log.scrollTop = log.scrollHeight;
    }),
    runtime.onRefresh(refresh),
  ];

  refresh();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value;
    if (!value) return;
    runtime.serialWrite(value + "\r\n");
    input.value = "";
    input.focus();
  });

  return {
    element: root,
    destroy() {
      for (const off of offs) off();
      root.remove();
    },
  };
}
