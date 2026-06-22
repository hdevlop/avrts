import { createStateStore } from "../component-bus";
import type { ComponentAdapter, ComponentRuntime } from "../component-bus";

/**
 * Scope (Phase 21D). Captures exact edges on one pin and estimates a square
 * wave's frequency and duty cycle — for tone() / analogWrite()-style outputs.
 *
 * Edges must be the exact (non-coalesced) stream; in worker mode that means
 * sourcing from an exact-edge capture rather than coalesced UI frames.
 */
export interface ScopeState {
  pin: number;
  high: boolean;
  sampleCount: number;
  frequencyHz: number | null;
  dutyCycle: number | null;
}

export interface ScopeAdapter extends ComponentAdapter<ScopeState> {
  setClock(clockHz: number): void;
  clear(): void;
}

export interface ScopeOptions {
  id: string;
  pin: number;
  clockHz?: number;
  /** Max retained edges (default 512). */
  capacity?: number;
}

interface Edge {
  high: boolean;
  cycles: number;
}

const DEFAULT_CLOCK = 16_000_000;

/**
 * Estimate frequency (Hz) and duty cycle from a stream of level-change edges.
 * Returns `null` fields when there aren't enough edges to measure.
 */
export function computeSquareWave(
  edges: ReadonlyArray<Edge>,
  clockHz: number,
): { frequencyHz: number | null; dutyCycle: number | null } {
  const risingCycles: number[] = [];
  const highDurations: number[] = [];
  let pendingRise: number | null = null;

  for (const edge of edges) {
    if (edge.high) {
      risingCycles.push(edge.cycles);
      pendingRise = edge.cycles;
    } else if (pendingRise !== null) {
      highDurations.push(edge.cycles - pendingRise);
      pendingRise = null;
    }
  }

  if (risingCycles.length < 2) return { frequencyHz: null, dutyCycle: null };

  let periodSum = 0;
  for (let i = 1; i < risingCycles.length; i += 1) periodSum += risingCycles[i]! - risingCycles[i - 1]!;
  const meanPeriod = periodSum / (risingCycles.length - 1);
  if (meanPeriod <= 0) return { frequencyHz: null, dutyCycle: null };

  const frequencyHz = clockHz / meanPeriod;
  const dutyCycle =
    highDurations.length > 0
      ? highDurations.reduce((a, b) => a + b, 0) / highDurations.length / meanPeriod
      : null;

  return { frequencyHz, dutyCycle };
}

export function scope(options: ScopeOptions): ScopeAdapter {
  let clockHz = options.clockHz ?? DEFAULT_CLOCK;
  const capacity = Math.max(2, options.capacity ?? 512);
  const store = createStateStore<ScopeState>({
    pin: options.pin,
    high: false,
    sampleCount: 0,
    frequencyHz: null,
    dutyCycle: null,
  });
  const edges: Edge[] = [];
  let off: (() => void) | null = null;

  const recompute = (high: boolean): void => {
    const { frequencyHz, dutyCycle } = computeSquareWave(edges, clockHz);
    store.set({ pin: options.pin, high, sampleCount: edges.length, frequencyHz, dutyCycle });
  };

  return {
    id: options.id,
    type: "scope",
    attach(runtime: ComponentRuntime) {
      recompute(runtime.readPin(options.pin));
      off = runtime.onPinChange(options.pin, (observation) => {
        edges.push({ high: observation.high, cycles: observation.cycles });
        if (edges.length > capacity) edges.shift();
        recompute(observation.high);
      });
    },
    detach() {
      off?.();
      off = null;
      store.clear();
    },
    setClock(hz) {
      clockHz = hz;
      recompute(store.get().high);
    },
    clear() {
      edges.length = 0;
      recompute(store.get().high);
    },
    state: store.get,
    subscribe: store.subscribe,
  };
}
