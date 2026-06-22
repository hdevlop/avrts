import { createStateStore } from "../component-bus";
import type { ComponentAdapter, ComponentRuntime } from "../component-bus";

/** Serial monitor: mirrors firmware TX text and can send host RX text. */
export interface SerialMonitorState {
  text: string;
}

export interface SerialMonitorAdapter extends ComponentAdapter<SerialMonitorState> {
  send(text: string): void;
  clearDisplay(): void;
}

export interface SerialMonitorOptions {
  id: string;
}

export function serialMonitor(options: SerialMonitorOptions): SerialMonitorAdapter {
  const store = createStateStore<SerialMonitorState>({ text: "" });
  let runtime: ComponentRuntime | null = null;
  let off: (() => void) | null = null;

  return {
    id: options.id,
    type: "serial",
    attach(rt) {
      runtime = rt;
      store.set({ text: rt.serialText() });
      off = rt.onSerialText((chunk) => store.set({ text: store.get().text + chunk }));
    },
    detach() {
      off?.();
      off = null;
      runtime = null;
      store.clear();
    },
    send: (text) => runtime?.serialWrite(text),
    clearDisplay: () => store.set({ text: "" }),
    state: store.get,
    subscribe: store.subscribe,
  };
}
