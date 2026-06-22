# Browser Simulator Improvement Plan

This plan starts after the Phase 20 browser demo. The current demo proves the
public `AVR(...)` facade can drive visible parts, wires, serial output, and a
debugger panel. The next work should make the simulator feel like a real
Wokwi/Tinkercad/Scratch-style product instead of a single demo page.

The root product issue is main-thread pressure: the AVR core can run real
firmware, but the browser UI must stay responsive while simulation is running.
The fix is a worker runtime, a circuit document, reusable component adapters,
and instruments that make firmware behavior visible.

---

## Phase 21 - Browser Runtime Worker + Component API

**Goal:** keep the browser UI responsive while firmware runs, and make circuit
state explicit enough to build a scalable simulator UI.

Design references:

- Wokwi-style circuit document: components, attributes, and wires are explicit
  data, not hidden DOM state.
- Wokwi-style instruments: serial monitor, pin activity, logic analyzer, and
  frame-rate-limited visual outputs.
- Tinkercad-style beginner flow: open a starter, press Run, interact with real
  parts, and see immediate response.
- Scratch/PictoBlox-style modes: separate live interaction from upload/debug
  flows so the UI does not ask beginners to think like CPU debugger users first.

---

## Phase 21A - Worker Runtime

Move browser execution off the main thread:

```ts
const sim = createAVRWorkerRuntime({ hex, speed: 1 });

sim.on("status", renderStatus);
sim.on("frame", renderFrame);
sim.on("serial", appendSerial);

sim.start();
sim.pause();
sim.resume();
sim.stop();
sim.setSpeed(1);
sim.setSpeed("max");
```

Worker rules:

- The worker owns the real `AVR(...)` instance.
- The main thread owns DOM, canvas, drag/drop, component layout, and user input.
- Messages are structured clone friendly.
- No runtime object with methods crosses the worker boundary.
- `runCycles(...)` and deterministic tests stay in the core library; worker mode
  is a browser adapter.
- Main-thread UI receives coalesced frame snapshots at a target cadence
  (`30`-`60` FPS), not every CPU/pin edge.
- The worker emits frames on its own fixed cadence. The main thread renders from
  the latest frame during its own `requestAnimationFrame` loop and may drop
  intermediate frames.
- The worker never runs a tight infinite loop. It runs bounded chunks and yields
  to its message queue between chunks.

Message protocol:

```ts
type AnalogInputCommand =
  | { type: "setAnalog"; channel: number; value: number }
  | { type: "setAnalog"; channel: number; volts: number; referenceVolts?: number };

type PinFrame = {
  pin: number;
  high: boolean;
  port: "B" | "C" | "D";
  bit: number;
  cycles: number;
  timeMs: number;
};

type PwmFrame = {
  pin: number;
  channel: "A" | "B";
  enabled: boolean;
  inverted: boolean;
  duty: number;
  value: number;
  mode: "off" | "fast-pwm" | "phase-correct-pwm" | "other";
};

type DataWatchFrame = {
  address: number;
  writes: Array<{
    oldValue: number;
    value: number;
    cycles: number;
  }>;
};

type LogicAnalyzerChunk = {
  analyzerId: string;
  format: "u32-cycles-u8-pin-u8-high";
  buffer: ArrayBuffer;
};

type WorkerCommand =
  | { type: "loadHex"; hex: string }
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "setSpeed"; speed: number | "max" }
  | { type: "setInput"; pin: number; high: boolean }
  | AnalogInputCommand
  | { type: "serialWrite"; text: string }
  | { type: "snapshot"; includeData?: boolean }
  | { type: "restore"; snapshotId?: string; snapshot?: AVRSnapshot }
  | { type: "deleteSnapshot"; snapshotId: string }
  | { type: "step" }
  | { type: "setBreakpoint"; pc: number }
  | { type: "clearBreakpoint"; pc: number }
  | { type: "clearBreakpoints" }
  | { type: "watchData"; address: number }
  | { type: "unwatchData"; address: number }
  | { type: "pauseOnUnknownOpcode"; enabled: boolean };

type WorkerEvent =
  | { type: "ready" }
  | { type: "status"; status: AVRStatus }
  | { type: "frame"; pins: PinFrame[]; pwm: PwmFrame[]; status: AVRStatus }
  | { type: "serial"; text: string }
  | { type: "snapshot"; snapshotId: string; snapshot?: AVRSnapshot }
  | { type: "breakpoint"; pc: number }
  | { type: "watchFrame"; events: DataWatchFrame[] }
  | { type: "logicChunk"; chunk: LogicAnalyzerChunk }
  | { type: "error"; message: string };
```

Command handling sketch:

```ts
function handleWorkerCommand(command: WorkerCommand): void {
  switch (command.type) {
    case "setInput":
      avr.pin(command.pin).setInput(command.high);
      return;

    case "setAnalog":
      if ("volts" in command) {
        avr.analog(command.channel).setVoltage(command.volts, command.referenceVolts);
      } else {
        avr.analog(command.channel).setValue(command.value);
      }
      return;

    case "restore":
      if (command.snapshot) {
        avr.restore(command.snapshot);
        return;
      }
      if (command.snapshotId) {
        const snapshot = snapshotStore.get(command.snapshotId);
        if (snapshot) {
          avr.restore(snapshot);
        } else {
          postError(`unknown snapshot id: ${command.snapshotId}`);
        }
        return;
      }
      postError("restore requires snapshot or snapshotId");
      return;
  }
}
```

Performance contract:

- Browser demo `1x` should be responsive for small Arduino fixtures without the
  current hard-coded `0.25x` workaround.
- `"max"` may prioritize throughput, but it must still yield worker messages so
  the UI can show progress and respond to Stop/Pause.
- `"max"` means larger bounded chunks, not `while (running)` forever. Stop,
  Pause, Step, and Debug commands must be observed between chunks.
- UI frame events are coalesced.
- Data watch events are batched per frame.
- Logic-analyzer edges are accumulated in a bounded worker-side ring buffer and
  shipped to the main thread in chunks.
- High-volume logic-analyzer chunks should use a transferable `ArrayBuffer`
  (`postMessage(event, [event.chunk.buffer])`) to avoid structured clone copies.

Snapshot contract:

- The worker may retain recent snapshots by id for fast restore.
- Snapshot ids must have an eviction policy, for example newest `10` snapshots
  or an explicit memory budget.
- `snapshot({ includeData: true })` can send the plain `AVRSnapshot` payload to
  the main thread for save-to-file, persistence, or replay across page reloads.
- `restore` is deterministic: a provided `snapshot` payload wins; otherwise
  `snapshotId` is looked up in the worker snapshot store; if neither is present
  or the id is missing, the worker emits an `error` event.
- Circuit documents do not include snapshots by default; saved replay/debug
  sessions can opt into an attached snapshot payload.

Tests:

- Bun unit tests cover the worker protocol: load HEX, start, emit status frames,
  pause, resume, stop.
- Button command from main thread changes pin state in firmware.
- Analog command from main thread changes `avr.analog(channel)` state in
  firmware-visible ADC reads.
- Serial output crosses worker boundary.
- Stop/Pause command is honored quickly while firmware is running.
- Debug commands set and clear breakpoints, watch data writes, and toggle
  unknown-opcode pausing through the worker.
- Playwright verifies that the UI remains clickable during a running sketch.

Implementation progress:

- Added `src/browser-runtime.ts` with the typed main-thread worker client,
  worker command/event protocol, and testable worker host.
- Added `src/browser-worker.ts` as the Web Worker entrypoint.
- Worker host now runs AVR in bounded chunks, emits coalesced frame events,
  batches watchpoint writes as `watchFrame`, supports digital and analog input
  commands, and handles snapshot/restore ids.
- Added `test/phase21-browser-runtime.test.ts` for the client protocol and
  worker-host behavior.
- Added `examples/browser-simulator/src/runtime.ts`, a demo runtime adapter that
  can wrap either the local `AVR` facade or the worker runtime.
- Migrated the non-debug demo widgets (`controls`, `board`, `LED`, `button`,
  `PWM`, `serial`) to the runtime adapter instead of direct `avr.pin(...)`,
  `avr.pwm(...)`, or `avr.serial` calls.
- Added `test/phase21-browser-demo-runtime.test.ts` to verify local facade
  compatibility plus worker frame/command consumption for UI components.
- Kept the CPU inspector intentionally on the local `AVR` facade for now,
  because it reads `avr.cpu` directly. Worker-backed debug mode still needs a
  dedicated debug-frame protocol before the inspector can cross the worker
  boundary.

---

## Phase 21B - Circuit Document

Add a small simulator document format inspired by `diagram.json`, but scoped to
avrts:

```ts
type CircuitEndpoint = {
  part: string;
  port: string;
};

type CircuitPartType = "board" | "led" | "button" | "potentiometer";
type CircuitInstrumentType =
  | "serial"
  | "logic-analyzer"
  | "pwm-meter"
  | "scope"
  | "debugger";

type CircuitNode<TType extends string> = {
  id: string;
  type: TType;
  x: number;
  y: number;
  attrs?: Record<string, unknown>;
};

interface AVRCircuitDocument {
  version: 1;
  runtime: {
    chip: "atmega328p";
    clockHz: number;
    speed?: number | "max";
  };
  program?: {
    hex?: string;
    name?: string;
  };
  parts: Array<CircuitNode<CircuitPartType>>;
  instruments?: Array<CircuitNode<CircuitInstrumentType>>;
  wires: Array<{
    from: CircuitEndpoint;
    to: CircuitEndpoint;
  }>;
}
```

Example wire:

```ts
{
  from: { part: "led1", port: "anode" },
  to: { part: "board1", port: "D13" },
}
```

Rules:

- Document import/export must reproduce the visible simulator layout.
- Wires are functional, not decorative, and must persist exact endpoint ports.
- Board ports may use friendly labels such as `D13` / `A0` plus raw AVR labels
  such as `PB5` when useful for debugging.
- Component ports are part-specific, for example `anode`, `cathode`, `signal`,
  `vcc`, and `gnd`.
- Invalid connections should return an explicit result:

  ```ts
  type ConnectResult = { ok: true } | { ok: false; reason: string };
  ```

- The wiring layer must not persist or draw a wire when `ConnectResult.ok` is
  false. The UI should show the reason and keep the previous connection.
- Keep board naming AVR/chip-first internally; UI labels may say Arduino-style
  `D13`, `A0`, etc. for user familiarity.

Tests:

- Importing a document creates the expected parts and wires.
- Exporting after drag/rewire preserves positions and connections.
- Exporting preserves wire endpoint ports, not just connected part ids.
- Invalid PWM/analog/digital bindings are rejected deterministically.

Implementation progress:

- Added `src/circuit/board-ports.ts`: the board port catalog (`D0..D13`, `A0..A5`,
  `5V`/`GND`) with AVR port/bit, PWM capability, ADC channel, and friendly + raw
  (`PB5`) label resolution.
- Added `src/circuit/document.ts` + `types.ts`: `AVRCircuitDocument`,
  `createCircuit(doc?)` (mutable model with `addPart`/`addInstrument`/`moveNode`/
  `removeNode`/`connect`/`disconnect`/`toJSON`), and `validateConnection`.
- Validation is deterministic and explained: role-vs-pin-kind checks
  (digital/analog/PWM/power), one-source-per-pin exclusivity, one-wire-per-
  component-port, and unknown-part/port/self/board-to-board rejections, each with
  a reason. `connect` only records a wire when validation passes; `canConnect`
  never mutates.
- Wires use `{ part, port }` endpoints, so export preserves exact ports and
  import/export round-trips.
- Import is hardened (review follow-up): `createCircuit(doc)` rejects duplicate
  node ids and replays imported wires through the same validation as `connect`,
  dropping invalid ones and surfacing them via `importIssues()` — a persisted or
  hand-edited document can no longer smuggle in bad wiring.
- Exported via the `src/circuit` barrel and the main `src` barrel.
- Added `test/phase21-circuit.test.ts` (catalog, validation rejections, source
  exclusivity, sink/probe sharing, round-trip). Full suite green.

---

## Phase 21C - Component Adapter API

The core library should not become a full UI framework, but it should expose
small, testable adapters that simulator UIs can reuse.

Target shape:

```ts
const led = digitalLed({ id: "led1", pin: 13 });
const button = momentaryButton({ id: "btn1", pin: 2, activeHigh: true });
const pot = potentiometer({ id: "pot1", channel: 0, volts: 2.5 });
const serial = serialMonitor({ id: "serial1" });
const logic = logicAnalyzer({ id: "logic1", pins: [2, 9, 13] });

const circuit = createCircuit({
  runtime,
  parts: [led, button, pot],
  instruments: [serial, logic],
});
```

Component categories:

- Digital sinks: LED, relay indicator, pin activity LED.
- Digital sources: momentary button, toggle switch, pulse generator.
- Analog sources: potentiometer, slider voltage source, joystick axis.
- Output instruments: serial monitor, PWM meter, logic analyzer, simple scope.
- Debug instruments: register inspector, watchpoint panel, breakpoint panel.

Adapter rules:

- Components talk to the runtime through a narrow bus, not direct CPU writes.
- Components expose state snapshots for rendering.
- Components can run on main thread while the AVR runtime is in a worker.
- Components must be individually testable without a browser.

Tests:

- Button adapter emits `setInput` commands.
- Potentiometer/slider adapters emit `setAnalog` commands.
- LED adapter consumes pin frame events.
- PWM meter consumes PWM frame events.
- Serial monitor consumes serial events and emits serial writes.
- Logic analyzer records bounded edge buffers and can export VCD later.
- Connection adapters return `ConnectResult`, so UI wiring can refuse invalid
  targets without mutating the document.

Implementation progress:

- Added `src/component-bus.ts`: the narrow `ComponentRuntime` port adapters use,
  plus `localComponentRuntime(avr)` and `workerComponentRuntime(worker)`
  implementations, a `createStateStore` helper, and `mountComponents`.
- Added `src/adapters/`: `digitalLed`, `momentaryButton`, `toggleSwitch`,
  `potentiometer`, `serialMonitor`, `pwmMeter`, `logicAnalyzer` — all DOM-free,
  each exposing `attach`/`detach`/`state()`/`subscribe()`. Sinks (LED, PWM meter)
  consume runtime events; sources (button, switch, potentiometer) emit
  `setInput`/`setAnalog`; the logic analyzer keeps a bounded ring buffer and
  exports VCD.
- Exported via the `src/adapters` barrel and the main `src` barrel.
- Added `test/phase21-adapters.test.ts`: every adapter exercised headless against
  a fake `ComponentRuntime`, plus a `localComponentRuntime` smoke test against a
  real in-process `AVR`.
- Note: the worker `ComponentRuntime` lives in `src/` so the demo's
  `examples/.../runtime.ts` can be migrated onto it in 21E rather than keeping a
  parallel implementation.

---

## Phase 21D - Instruments

Add instruments that make firmware behavior visible:

1. **Pin activity strip**
   - Every digital pin shows LOW/HIGH and recent edge activity.
   - Useful even when no external component is wired.

2. **Serial monitor**
   - Keep TX text, host RX input, clear, pause scroll, baud label.
   - Serial output must still work through the worker.

3. **Logic analyzer lite**
   - User chooses pins.
   - Capture edges with timestamps/cycles.
   - Show a compact waveform in the browser.
   - Later export VCD.

4. **PWM / scope view**
   - Show duty, frequency estimate, and recent waveform.
   - Use frame/coalesced display for UI, exact edge buffer for analysis.

5. **Debugger panel**
   - Keep registers and breakpoints, but move it into a Debug tab/panel so
     beginner simulator use starts with components, not CPU internals.

Tests:

- Serial monitor remains usable while firmware runs.
- Logic analyzer records button and PWM edges.
- Potentiometer changes are visible to an `analogRead` fixture through the
  worker protocol.
- PWM instrument reports non-zero duty for the analogWrite fixture.
- Debug panel can pause, step, and resume through the worker protocol.
- Debug panel can set/clear breakpoints, toggle unknown-opcode pause, and show
  batched watchpoint events through the worker protocol.

Implementation progress:

- Added the reusable instrument data models (DOM-free, headless-tested):
  - `src/adapters/pin-activity.ts` (`pinActivity`): per-pin LOW/HIGH, edge count,
    and last-edge cycle for a chosen set of pins (default D0..D13).
  - `src/adapters/scope.ts` (`scope` + pure `computeSquareWave`): square-wave
    frequency and duty estimate from an exact edge stream.
  - `src/adapters/logic-analyzer.ts` (`logicAnalyzer`, from 21C): bounded edge
    ring buffer + VCD export.
- Added `test/phase21-instruments.test.ts` (pin activity counters, frequency/duty
  estimation, scope reset).
- The serial monitor model already exists (`serialMonitor`, 21C).
- The instrument **widgets** (pin-activity strip, analyzer waveform, scope view)
  and moving the inspector into a Debug tab are part of the 21E demo restructure,
  so the DOM is built once against the new mode shell rather than twice.

---

## Phase 21E - Browser Demo UX

Restructure the demo around three user modes:

- **Circuit:** drag parts, wire pins, inspect component states.
- **Run:** start/pause/reset/speed, serial monitor, visible outputs.
- **Debug:** registers, breakpoints, watchpoints, single step, snapshots.

UX rules:

- The first screen should show a working starter circuit, already running.
- Every visible interaction should change visible state within one frame:
  button press, switch toggle, serial send, rewire, speed change.
- Valid wire targets should highlight while dragging.
- Invalid targets should show a short reason and keep the old connection.
- Rejected connections must not be saved to the circuit document.
- Default speed should favor responsiveness; advanced speed modes can be louder
  about tradeoffs.
- Components should use direct manipulation first, forms second.

Starter circuits:

- Blink LED.
- Button controls LED.
- Serial print and serial input echo.
- PWM fade.
- attachInterrupt button.
- Tone / square wave once the timer output path is strong enough.

Playwright coverage:

- UI remains clickable while a sketch is running.
- Button press changes board pin and firmware-visible LED output.
- Program switch restarts and clears stale component state.
- Rewiring changes the bound pin.
- Worker Stop/Pause responds quickly.
- Logic analyzer records at least one edge.

---

## Phase 21F - Documentation

Document the simulator-facing APIs separately from low-level AVR internals:

- `docs/07-browser-runtime.md`
  - worker runtime setup.
  - command/event protocol.
  - frame/coalescing behavior.
  - performance expectations.

- `docs/08-component-adapters.md`
  - LED/button/potentiometer/serial/logic analyzer examples.
  - component adapter contract.
  - circuit document schema.

- Browser demo README
  - user workflow.
  - supported fixtures.
  - known limitations.
  - how to run e2e tests.

---

## Non-Goals

- Full analog SPICE simulation.
- Full breadboard electrical correctness.
- Multiple MCU simulation in one circuit.
- Perfect cycle-accurate UI rendering of every edge.
- Replacing the existing deterministic core APIs.

---

## Recommended Order

Build this in this order:

1. Worker runtime and command/event protocol.
2. Circuit document import/export.
3. Component adapter API for LED, button, PWM, serial, and pin activity.
4. Logic analyzer lite.
5. Browser demo mode split: Circuit / Run / Debug.
6. More component starters: potentiometer, tone, servo-style timer output.
7. Performance budgets and benchmark thresholds for browser runtime.

Reasoning:

- Phase 20 proved the facade can drive an interactive simulator.
- Phase 21 removes the main-thread responsiveness limit.
- Component adapters and a circuit document make the UI scalable instead of a
  one-off demo.
- Instruments make firmware behavior visible without asking every user to open
  the CPU inspector.

---

## Code Plan

Concrete file-level plan, following the split 21A already established.

### Conventions

- Reusable, DOM-free, thread-agnostic logic lives in `src/` (pattern set by
  `src/browser-runtime.ts`) and is unit-tested headless in
  `test/phase21-*.test.ts` — no browser required.
- The worker entry is `src/browser-worker.ts` (just calls `installAVRWorker(self)`).
- Browser/DOM glue, widgets, and modes live in `examples/browser-simulator/src/`.
- End-to-end behavior is covered by Playwright in
  `examples/browser-simulator/tests/*.spec.ts` (dev-only; not in `bun test`).
- Each new `src/` subfolder gets a `types.ts` + barrel `index.ts`.

### Module map

| Phase | File | Responsibility | Thread | Tests |
|------|------|----------------|--------|-------|
| 21A ✅ | `src/browser-runtime.ts` | protocol types, `createAVRWorkerRuntime` (client), `installAVRWorker` (host) | both | `test/phase21-browser-runtime.test.ts` |
| 21A ✅ | `src/browser-worker.ts` | Web Worker entrypoint | worker | — |
| 21A ✅ | `examples/browser-simulator/src/runtime.ts` | demo runtime adapter (local facade or worker) | main | `test/phase21-browser-demo-runtime.test.ts` |
| 21B | `src/circuit/board-ports.ts` | board port catalog (`D0..D13`/`A0..A5` ↔ port/bit/channel, digital/analog/pwm capability) | both | `test/phase21-circuit.test.ts` |
| 21B | `src/circuit/document.ts` | document types, `createCircuit`, `validateConnection`, `toJSON`/`fromJSON` | main | `test/phase21-circuit.test.ts` |
| 21C | `src/component-bus.ts` | `ComponentBus` + `workerBus(runtime)` + `localBus(avr)` (promote demo `runtime.ts`) | main | `test/phase21-adapters.test.ts` |
| 21C | `src/adapters/*.ts` + `index.ts` | `digitalLed`, `momentaryButton`, `toggleSwitch`, `potentiometer`, `serialMonitor`, `pwmMeter`, `logicAnalyzer` | main | `test/phase21-adapters.test.ts` |
| 21D | `src/adapters/logic-analyzer.ts` | edge ring buffer + `toVCD()` data model | main | `test/phase21-instruments.test.ts` |
| 21D | `examples/.../components/{pin-activity,logic-analyzer,pwm-scope}.ts` | instrument widgets | main | e2e |
| 21E | `examples/.../src/{app,modes/circuit,modes/run,modes/debug,starters}.ts` | Circuit/Run/Debug shell + starter circuits | main | e2e |
| 21F | `docs/07-browser-runtime.md`, `docs/08-component-adapters.md`, demo `README.md` | docs | — | — |

### Key new abstraction — `ComponentBus` (21C)

Adapters must work whether the AVR runs locally or in a worker, so they depend on
a narrow bus, not on `AVR` or `Worker` directly. This generalizes the existing
demo `runtime.ts`:

```ts
export interface ComponentBus {
  send(command: AVRWorkerCommand): void;
  on<T extends AVRWorkerEventType>(type: T, handler: AVRWorkerEventHandler<T>): () => void;
}

export function workerBus(runtime: AVRWorkerRuntime): ComponentBus; // thin pass-through
export function localBus(avr: AVR): ComponentBus;                   // synthesizes frame/serial/watchFrame from the facade
```

Adapter contract (pure, DOM-free, individually testable):

```ts
export interface ComponentAdapter<State> {
  readonly id: string;
  readonly type: CircuitPartType | CircuitInstrumentType;
  attach(bus: ComponentBus): void;   // subscribe to events / wire inputs
  detach(): void;
  state(): State;                    // render snapshot for the UI layer
  subscribe(listener: (state: State) => void): () => void;
}
```

### Task checklist

**21B — Circuit document** ✅
- [x] `board-ports.ts`: catalog + `resolveBoardPort(label)` → `{ kind, port, bit, pin?, channel?, pwm }`; friendly (`D13`) and raw (`PB5`) labels.
- [x] `document.ts`: `AVRCircuitDocument`/`CircuitEndpoint`/`ConnectResult` types; `createCircuit(doc?)` with `addPart`/`addInstrument`/`moveNode`/`removeNode`/`connect(from,to): ConnectResult`/`disconnect`/`toJSON`.
- [x] `validateConnection`: reject PWM-meter→non-PWM pin, analog source→non-analog pin, two sources on one pin, unknown ports — each with a `reason`.
- [x] Import/export round-trips positions + exact endpoint ports.
- [x] Tests: import builds parts/wires; export preserves ports; invalid bindings rejected deterministically.

**21C — Component adapters** ✅
- [x] `component-bus.ts`: `ComponentRuntime` port + `localComponentRuntime` + `workerComponentRuntime` + `createStateStore` + `mountComponents`. (Demo `runtime.ts` migrates onto this in 21E.)
- [x] `src/adapters/`: `digitalLed`/`momentaryButton`/`toggleSwitch`/`potentiometer`/`serialMonitor`/`pwmMeter`/`logicAnalyzer`; sinks consume events, sources emit `setInput`/`setAnalog`, serial both ways.
- [~] Binding adapters to a circuit doc via `ConnectResult` — deferred to 21E (workspace ↔ circuit bridge), where the demo wires it up.
- [x] Tests: each adapter headless against a fake runtime + a `localComponentRuntime` smoke test.

**21D — Instruments** (models ✅, widgets → 21E)
- [x] `src/adapters/logic-analyzer.ts`: bounded ring buffer keyed by chosen pins + `toVCD()`.
- [x] `src/adapters/pin-activity.ts` + `src/adapters/scope.ts` (with pure `computeSquareWave`).
- [x] Tests: bun for ring buffer + VCD, pin-activity counters, frequency/duty estimate.
- [ ] Demo widgets (pin-activity strip, analyzer waveform, scope) + inspector → Debug tab — built in 21E against the mode shell.

**21E — Demo UX** (must also close the review findings below)
- [ ] **Worker-backed demo (review High #1):** switch `main.ts` from `createLocalSimulatorRuntime(AVR(...))` to the worker runtime so firmware runs off the main thread; migrate the demo `runtime.ts` onto the `src/` `ComponentRuntime` port (removes the duplicate worker runtime).
- [ ] **Deployable worker bundle (review High #2):** `new Worker(new URL("./browser-worker.ts", ...))` 404s because `build:demo` emits only `main.js`. Add a `build:worker` step that bundles `src/browser-worker.ts` to the demo `dist/`, serve it, and point the worker URL at the built artifact (or construct the `Worker` in `main.ts` and pass it in).
- [ ] **Exact-edge capture for analyzer/scope (review Medium #3):** coalesced `frame` events drop edges, so worker-mode logic-analyzer/scope/PWM-frequency are inaccurate. Add an exact-edge capture path in the worker host that emits `LogicAnalyzerChunk` (the type exists but is never posted) for subscribed pins, and feed analyzer/scope from it instead of coalesced frames.
- [ ] Tab shell `app.ts` + `modes/{circuit,run,debug}.ts`; first paint shows a running starter.
- [ ] Bridge the Phase 20 workspace to `createCircuit`: workspace `onBind` → `circuit.connect()`; refuse the wire when `ok` is false and surface `reason` (+ `importIssues()` on load).
- [ ] `starters.ts`: Blink, Button→LED, Serial echo, PWM fade, attachInterrupt.
- [ ] Default speed back to responsive (drop the `0.25x` workaround) once worker-backed.
- [ ] Playwright: clickable-while-running, button→LED, program switch clears state, rewire, fast Stop/Pause, one analyzer edge.

**21F — Docs**
- [ ] `docs/07-browser-runtime.md`, `docs/08-component-adapters.md`, demo README update.

### Gates (per phase)

`bun test` + `bun run typecheck` stay green at every step; `bun run test:e2e`
green by end of 21E. Reusable logic ships with bun unit tests before any demo
widget consumes it.

### Recommended next step

21B + 21C give the biggest leverage: a validated circuit document plus the
`ComponentBus`/adapter layer turn the existing widgets into reusable, headless-
testable parts and unlock the rest of the demo work.

---

## v1.3 Definition Of Done

v1.3 is done when:

- Browser simulation runs through a Web Worker runtime.
- The main thread stays responsive during running firmware.
- The demo can default back to `1x` for small fixtures; responsiveness must not
  depend on a hard-coded `0.25x` speed workaround.
- Circuit state is represented by an import/export document.
- LED, button, PWM, serial, pin activity, and logic analyzer instruments are
  modeled as reusable component adapters.
- The demo is organized around Circuit / Run / Debug modes.
- Playwright covers responsiveness and component interactions, not only static
  rendering.

---

## Done When

Phase 21 is done when:

- The browser demo runs the AVR core in a Web Worker.
- The main UI remains responsive while firmware is running.
- Button, LED, PWM, serial, and pin activity components communicate through the
  worker protocol.
- A circuit document can import/export visible parts, instruments, and exact
  wire endpoint ports.
- The demo has Circuit / Run / Debug modes.
- Playwright covers runtime responsiveness, button interaction, program switch,
  rewiring, snapshot/restore, serial monitor, and one logic-analyzer capture.
- `bun test`, `bun run typecheck`, and `bun run test:e2e` pass.
