import { createStateStore } from "../component-bus";
import type { ComponentAdapter, ComponentRuntime } from "../component-bus";

/**
 * Pin activity strip (Phase 21D). Tracks LOW/HIGH and recent edge activity for a
 * set of digital pins — useful even when nothing external is wired.
 */
export interface PinActivity {
  pin: number;
  high: boolean;
  edges: number;
  lastEdgeCycles: number;
}

export interface PinActivityState {
  channels: PinActivity[];
}

export interface PinActivityAdapter extends ComponentAdapter<PinActivityState> {
  /** Reset edge counters (keeps current levels). */
  resetCounters(): void;
}

export interface PinActivityOptions {
  id: string;
  /** Digital pins to monitor (default D0..D13). */
  pins?: number[];
}

const DEFAULT_PINS = Array.from({ length: 14 }, (_, pin) => pin);

export function pinActivity(options: PinActivityOptions): PinActivityAdapter {
  const pins = options.pins ?? DEFAULT_PINS;
  const initial = (): PinActivityState => ({
    channels: pins.map((pin) => ({ pin, high: false, edges: 0, lastEdgeCycles: 0 })),
  });
  const store = createStateStore<PinActivityState>(initial());
  const offs: Array<() => void> = [];

  const update = (pin: number, mutate: (channel: PinActivity) => PinActivity): void => {
    store.set({
      channels: store.get().channels.map((channel) => (channel.pin === pin ? mutate(channel) : channel)),
    });
  };

  return {
    id: options.id,
    type: "pin-activity",
    attach(runtime: ComponentRuntime) {
      for (const pin of pins) {
        update(pin, (channel) => ({ ...channel, high: runtime.readPin(pin) }));
        offs.push(
          runtime.onPinChange(pin, (observation) =>
            update(pin, (channel) => ({
              ...channel,
              high: observation.high,
              edges: channel.edges + 1,
              lastEdgeCycles: observation.cycles,
            })),
          ),
        );
      }
    },
    detach() {
      for (const off of offs) off();
      offs.length = 0;
      store.clear();
    },
    resetCounters() {
      store.set({
        channels: store.get().channels.map((channel) => ({ ...channel, edges: 0, lastEdgeCycles: 0 })),
      });
    },
    state: store.get,
    subscribe: store.subscribe,
  };
}
