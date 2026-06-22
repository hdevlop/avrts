import { createStateStore } from "../component-bus";
import type { ComponentAdapter, ComponentRuntime } from "../component-bus";

/**
 * Logic analyzer (lite): records pin edges on a chosen set of pins into a
 * bounded ring buffer (oldest samples drop when full) and can export VCD.
 */
export interface LogicSample {
  pin: number;
  high: boolean;
  cycles: number;
}

export interface LogicAnalyzerState {
  pins: number[];
  sampleCount: number;
  full: boolean;
}

export interface LogicAnalyzerAdapter extends ComponentAdapter<LogicAnalyzerState> {
  samples(): readonly LogicSample[];
  clear(): void;
  toVCD(): string;
}

export interface LogicAnalyzerOptions {
  id: string;
  pins: number[];
  /** Max retained samples; oldest are dropped past this (default 4096). */
  capacity?: number;
}

export function logicAnalyzer(options: LogicAnalyzerOptions): LogicAnalyzerAdapter {
  const pins = [...options.pins];
  const capacity = Math.max(1, options.capacity ?? 4096);
  const store = createStateStore<LogicAnalyzerState>({ pins, sampleCount: 0, full: false });
  const buffer: LogicSample[] = [];
  const offs: Array<() => void> = [];
  let dropped = false;

  const record = (sample: LogicSample): void => {
    buffer.push(sample);
    if (buffer.length > capacity) {
      buffer.shift();
      dropped = true;
    }
    store.set({ pins, sampleCount: buffer.length, full: dropped });
  };

  return {
    id: options.id,
    type: "logic-analyzer",
    attach(runtime: ComponentRuntime) {
      for (const pin of pins) {
        offs.push(
          runtime.onPinChange(pin, (observation) =>
            record({ pin, high: observation.high, cycles: observation.cycles }),
          ),
        );
      }
    },
    detach() {
      for (const off of offs) off();
      offs.length = 0;
      store.clear();
    },
    samples: () => buffer,
    clear() {
      buffer.length = 0;
      dropped = false;
      store.set({ pins, sampleCount: 0, full: false });
    },
    toVCD: () => toVCD(pins, buffer),
    state: store.get,
    subscribe: store.subscribe,
  };
}

/** Render a minimal VCD. Cycles are used as the time axis (timescale is nominal). */
function toVCD(pins: number[], samples: readonly LogicSample[]): string {
  const symbolOf = new Map<number, string>();
  pins.forEach((pin, index) => symbolOf.set(pin, String.fromCharCode(33 + index)));

  const lines: string[] = [
    "$timescale 1 ns $end",
    "$scope module avrts $end",
    ...pins.map((pin) => `$var wire 1 ${symbolOf.get(pin)} D${pin} $end`),
    "$upscope $end",
    "$enddefinitions $end",
  ];

  let lastCycle = -1;
  for (const sample of samples) {
    if (sample.cycles !== lastCycle) {
      lines.push(`#${sample.cycles}`);
      lastCycle = sample.cycles;
    }
    lines.push(`${sample.high ? 1 : 0}${symbolOf.get(sample.pin)}`);
  }

  return `${lines.join("\n")}\n`;
}
