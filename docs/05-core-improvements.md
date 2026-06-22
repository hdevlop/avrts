# Core Improvement Plan

This plan starts after the first usable AVR facade is in place. The simulator can
already load real ATmega328P / Arduino AVR HEX files, run standard Blink timing,
observe GPIO, emit Serial text, read inputs, and expose PWM metadata. The next
work should make the core stronger for browser simulators, debugging tools, and
larger Arduino sketches.

Keep the same project rules:

- The public path stays `AVR(...)` first.
- Low-level APIs remain available for tests and debugging.
- Every phase ends with a focused test or real compiled fixture.
- Real Arduino/avr-gcc fixtures are preferred whenever they expose behavior better
  than synthetic opcode programs.

---

## Current Baseline

The following capabilities are already expected to stay green:

- `AVR(hex)` / `AVR({ hex })` loads HEX internally.
- `runCycles(cycles)` and `runFor(ms)` execute deterministic simulated time.
- Browser-facing runtime helpers exist:
  `frame(deltaMs)`, `start()`, `pause()`, `resume()`, `stop()`, `setSpeed(...)`.
- Loading DX exists:
  `load(...)`, `loadHex(...)`, `loadFile(...)`, `reload()`, `clearProgram()`.
- Pin helpers exist:
  `pin().read()`, `pin().setInput(...)`, `pin().pulse(ms)`, `pins.onChange(...)`.
- Raw debug access remains:
  `avr.cpu`, `avr.gpio.port("B")`, advanced `loadHex()`.
- Golden fixtures cover:
  real avr-gcc Timer0 ISR blink, Arduino `delay()` Blink, Arduino Serial,
  Arduino `digitalRead()`, and Arduino `analogWrite()`.

---

## Phase 10 - Snapshot / Restore

**Goal:** make pause, reset, replay, and UI debugging reliable.

Add:

```ts
const snap = avr.snapshot();
avr.restore(snap);
```

Snapshot should include:

- CPU state:
  `pc`, `cycles`, `data`, `flash`, stack pointer, SREG through `data`.
- Runtime state:
  clock, chip, speed, loaded program source, running/paused state.
- GPIO state:
  injected input levels, peripheral output overrides, port listener-visible state.
- Timer state:
  counters, prescaler remainders, flags already stored in data registers.
- USART state:
  TX/RX buffers, RX queue head, accumulated serial text.
- ADC/EEPROM/SPI/TWI/watchdog/pin-change interrupt state where modeled.

Implementation notes:

- Prefer explicit `snapshot()` / `restore()` methods per peripheral instead of
  reaching into private fields from `AVRRuntime`.
- Snapshot data should be plain serializable objects plus typed-array copies.
- Restoring should not duplicate event listeners; listeners belong to the runtime,
  not to snapshots.
- `restore()` should re-emit pin/serial/status changes only if the restored state
  visibly differs from the current state.

Tests:

- Run a sketch, snapshot, advance, restore, and verify CPU cycles/PC/data match.
- Verify a restored pin state matches `pin().read()`.
- Verify restored serial text matches `serial.getText()`.
- Verify timers continue from restored counter/remainder state.
- Verify EEPROM content survives normal `reset()` but follows explicit snapshot
  restore when snapshot includes EEPROM.

**Done when:** a sketch can be snapshotted, advanced, restored, and then produce
the same next pin/serial events as it did the first time.

### Phase 10 Review Findings / Resolved

Phase 10 is broadly implemented. The review found a few hardening items that are
now part of the Phase 10 contract and test suite.

1. Preserve pending interrupt acknowledge behavior after restore.

   Original risk: CPU snapshots stored pending interrupt vectors, but not the
   acknowledge callbacks that clear peripheral flags. Restored timer/ADC/SPI/
   PCINT/external-interrupt vectors can jump to the ISR while leaving the flag
   set.

   Resolution:

   - Keep snapshots plain data; do not serialize callbacks.
   - Added a runtime rehydrate path after CPU restore that re-queues
     pending vectors with the correct acknowledge behavior.
   - Added direct-vs-restored tests proving the peripheral flag state matches after
     the restored ISR is entered.

2. Make CPU restore silent.

   Original risk: `CPU.restore()` assigned through the public `cycles` setter, so
   restoring a higher cycle count can tick timers/watchdog/ADC as if time passed.

   Resolution:

   - Restore CPU cycles by assigning the internal cycle storage directly.
   - Verify `cpu.onCycles(...)` is not called during `restore()`.
   - Verify timers do not advance merely because a snapshot with a higher cycle
     count was restored.

3. Decide the restore event contract for UI state.

   Original risk: pins can re-emit visible changes through GPIO restore, but
   serial text is restored silently. That is fine if UI refreshes from
   `serial.getText()`, but the contract must be clear.

   Resolution:

   - Added an explicit `"restore"` event to the facade and documented that
     restore does not replay serial text through `serial.onText(...)`.
   - Browser UIs can refresh status,
     serial monitor text, LEDs, and inspector state from getters in one pass.
   - Added a test for the chosen behavior.

**Done when:** restore is silent with respect to simulated time, restored pending
interrupts behave exactly like non-restored pending interrupts, and the UI event
contract for restore is tested and documented.

---

## Phase 11 - Debugger Core

**Goal:** expose debugger primitives needed by a browser simulator.

Add:

```ts
avr.breakpoint({ pc: 0x1234 });
avr.clearBreakpoint(0x1234);
avr.clearBreakpoints();
avr.pauseOnUnknownOpcode(true);
avr.on("breakpoint", handler);
avr.on("error", handler);
```

Possible watchpoint API:

```ts
avr.watchData(0x25, (event) => {
  console.log(event.address, event.oldValue, event.value);
});
```

Debug behavior:

- `step()` should execute exactly one instruction unless an interrupt is serviced
  as part of that instruction boundary.
- `runCycles()` / `frame()` should pause when a breakpoint is hit.
- Unknown opcodes should either throw or emit `"error"` and pause, depending on
  `pauseOnUnknownOpcode(...)`.
- Trace data should include at least:
  `pc`, `opcode`, mnemonic, cycles, and optional register/data diffs.

Tests:

- Breakpoint pauses before executing the instruction at that PC.
- Clearing a breakpoint lets execution continue.
- Watchpoint fires for firmware writes to a data-space address.
- `pauseOnUnknownOpcode(true)` pauses and emits an error event.

**Done when:** a UI can run, pause, step, resume, inspect PC/registers/data, and
stop on known program locations.

---

## Phase 12 - More Exact Timing

**Goal:** reduce instruction-boundary timing jitter for timers and peripherals.

Current model advances peripherals after each instruction by the instruction's
cycle count. That is fast and simple, but timer compare/overflow events can land
at the boundary of multi-cycle instructions. This is acceptable for many demos,
but not for cycle-exact debugging or waveform timing.

Add a timing mode:

```ts
const avr = AVR({ hex, timing: "fast" });
avr.useTiming("cycle-exact");
```

Modes:

- `"fast"`: current instruction-batched peripheral ticking.
- `"cycle-exact"`: peripherals can observe individual CPU cycles inside
  multi-cycle instructions.

Implementation notes:

- Keep `"fast"` as the default for browser performance.
- Add an internal `cpu.consumeCycles(n)` or equivalent so instruction handlers can
  optionally emit cycle boundaries without duplicating logic.
- Timer0/1/2 should be the first cycle-exact peripherals.
- USART/ADC/watchdog can follow only when tests require it.

Tests:

- Timer overflow lands at the exact expected cycle in cycle-exact mode.
- Compare match pins toggle at exact OCR boundaries.
- Existing fast-mode tests remain green.

**Done when:** the standard timing fixture still passes in fast mode, and targeted
timer tests pass exact-cycle assertions in cycle-exact mode.

---

## Phase 13 - Output Compare / Waveform Completeness

**Goal:** make real pin output match timer compare configuration, not only
`avr.pwm(pin).read()` metadata.

Core behavior to support:

- Normal mode compare output:
  disconnect, toggle, clear, set.
- CTC mode compare output:
  especially toggle-on-compare for `tone()`-style square waves.
- PWM modes:
  non-inverting and inverting output behavior at compare match and BOTTOM/TOP.
- Timer0 pins:
  OC0A = D6, OC0B = D5.
- Timer1 pins:
  OC1A = D9, OC1B = D10.
- Timer2 pins:
  OC2A = D11, OC2B = D3.

Design rule:

- Timer-driven output should affect `avr.pin(pin).read()` and pin listeners.
- It should not blindly mutate raw `PORTx`; raw `gpio.port("B")` should remain a
  view of the firmware-visible port latch.
- `avr.pwm(pin).read()` remains useful as metadata for UI brightness controls.

Fixtures:

- Arduino `analogWrite()` should produce real pin edges.
- Add Arduino `tone()` fixture when Timer2/CTC toggle behavior is ready.

**Done when:** UI components can watch `avr.pin(pin).onChange(...)` for PWM/tone
activity without special timer knowledge.

---

## Phase 14 - External Interrupts INT0 / INT1

**Goal:** support common button and sensor interrupt sketches.

Registers:

- `EICRA`
- `EIMSK`
- `EIFR`

Vectors:

- `INT0_VECTOR`
- `INT1_VECTOR`

Pin mapping:

- INT0 = D2 / PD2.
- INT1 = D3 / PD3.

Trigger modes:

- Low level.
- Any change.
- Falling edge.
- Rising edge.

Facade interaction:

```ts
avr.pin(2).setInput(true);
avr.pin(2).setInput(false);
```

should raise the matching interrupt when firmware enabled it.

Golden fixture:

```cpp
volatile int hits = 0;

void onButton() {
  hits++;
  digitalWrite(13, hits & 1);
}

void setup() {
  pinMode(2, INPUT);
  pinMode(13, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(2), onButton, RISING);
}

void loop() {}
```

Tests:

- Synthetic register tests for each trigger mode.
- Real Arduino `attachInterrupt()` fixture toggles pin 13 when `avr.pin(2)` rises.

**Done when:** real Arduino `attachInterrupt()` sketches work for pins 2 and 3.

---

## Phase 15 - Peripheral Fidelity Pass

**Goal:** make common Arduino libraries work without special cases.

Priority order:

1. **USART**
   - RX complete interrupt path.
   - Data register empty interrupt behavior.
   - TX complete interrupt behavior.
   - Keep immediate-transmit mode for speed, but model flags/interrupts correctly.

2. **ADC**
   - Auto-trigger modes.
   - Reference selection behavior.
   - Conversion timing.
   - ADC interrupt fixtures.

3. **EEPROM**
   - Ready interrupt timing.
   - Busy/write timing if sketches depend on it.

4. **SPI**
   - Mode bits: CPOL, CPHA, DORD, master/slave shape.
   - SPI transfer complete interrupt.

5. **TWI/I2C**
   - More complete status-code behavior.
   - Repeated start.
   - Common Wire library flows.

6. **Timer1 input capture**
   - `ICR1`, `ICES1`, `ICIE1`, `ICF1`.
   - Needed for some pulse measurement libraries.

7. **Async Timer2**
   - Later. Useful for low-power/timekeeping sketches, but not first priority.

Each peripheral should have:

- Register-level unit tests.
- At least one real Arduino or avr-libc golden fixture.
- Facade-level test when UI code needs to interact with it.

### Phase 15 Progress

Implemented ADC fidelity slice:

- `ADIF` now behaves as write-one-to-clear; normal `ADCSRA` writes preserve the
  pending conversion flag.
- `ADATE` auto-trigger is modeled for free-running mode and edge-triggered
  sources.
- Timer/interrupt trigger source bits in `ADCSRB.ADTS2:0` are decoded for:
  - free running.
  - external interrupt 0 flag.
  - Timer0 compare A.
  - Timer0 overflow.
  - Timer1 compare B.
  - Timer1 overflow.
  - Timer1 input capture flag.
- `analog().setVoltage(...)` is treated as a physical voltage source during
  conversion, so `ADMUX.REFS1:0` affects the sampled value.
- ADC snapshot/restore now preserves voltage-backed channels and trigger latch
  state.

Added tests in `test/phase15-peripheral-fidelity.test.ts` for:

- sticky `ADIF` behavior.
- voltage sampling with internal 1.1V vs AVCC reference.
- free-running ADC auto-trigger.
- Timer0 compare-match ADC auto-trigger edge behavior.

Still remaining in Phase 15:

- ADC real Arduino/avr-libc auto-trigger fixture.
- EEPROM busy/write timing and ready interrupt delay behavior.
- SPI CPOL/CPHA/DORD/slave shape beyond the current master-byte responder.
- TWI repeated-start/Wire-library status flow fixture.
- Timer1 input-capture pin event model, not only the ADC trigger flag.
- Async Timer2.
- A named target library/sketch compatibility list.

**Done when:** the target library/sketch list runs unmodified.

---

## Phase 16 - Instruction Coverage Audit

**Goal:** remove hidden CPU gaps before they surprise larger programs.

Add an instruction coverage tracker:

- List every AVR instruction mnemonic.
- Mark implemented, aliased, intentionally unsupported, or missing.
- Link each implemented instruction to a test file.

Improve tests:

- Datasheet-style unit test per instruction or instruction family.
- Randomized/property tests for arithmetic flags where practical.
- Real compiled fixtures for instructions that only appear in larger compiler
  output.

Unknown opcode behavior:

- Error should include word PC, byte address, opcode, next word, and nearest
  known disassembly context if available.
- Debug mode should pause instead of crashing.

**Done when:** common Arduino core and library fixtures run without unknown
opcodes, and the missing-instruction list is explicit.

### Phase 16 Progress

Implemented the instruction coverage audit:

- `src/instruction-coverage.ts` lists every ATmega328P mnemonic with a status
  (`implemented` / `alias` / `not-implemented`) plus a note on each gap.
- Added the previously-untracked `CP`, `CPC`, `CPI` mnemonics (implemented in the
  decoder but missing from the coverage table).
- `COVERAGE_SAMPLES` now covers the indirect load/store and `LPM` families, which
  decode to sub-mnemonics (`LD_X`, `ST_Zinc`, `LDD_Y`, ...); the test normalizes
  those to their family. Fixed an `FMULS` sample that actually encoded `FMULSU`.
- Added `UNSUPPORTED_SAMPLES` with canonical opcodes for the intentionally
  unmodelled instructions (`ELPM`, `SPM`, `EICALL`, `EIJMP`, `DES`).

`test/phase16-coverage.test.ts` cross-checks the table against the live decoder:

- every `implemented` mnemonic is claimed by the decode table;
- every decode-table family is recorded as `implemented` or `alias` (catches
  silently-added handlers);
- every canonical sample opcode decodes to its mnemonic family, and every
  non-alias implemented mnemonic has a sample;
- each unsupported opcode is unclaimed and raises `UnknownOpcodeError`;
- `UnknownOpcodeError` carries word PC, opcode, next word, and nearest-known
  disassembly context.

Still remaining in Phase 16:

- Datasheet-style per-instruction flag unit tests and randomized arithmetic-flag
  property tests.
- Real compiled fixtures that exercise instructions only emitted in larger
  compiler output.

**Done when:** common Arduino core and library fixtures run without unknown
opcodes, and the missing-instruction list is explicit.

---

## Phase 17 - Browser Performance

**Goal:** keep real-time browser simulation smooth.

Work items:

- Avoid allocations in hot paths: instruction dispatch, timer ticks, GPIO events.
- Benchmark `runCycles()` throughput.
- Add a simple benchmark script for:
  - tight loop.
  - delay Blink.
  - Serial print.
  - analogWrite fixture.
- Consider a generated/function-table decoder if the current table becomes a
  bottleneck.
- Add configurable event coalescing for high-frequency pin/PWM edges in UI mode.

Runtime modes:

```ts
avr.setSpeed(1);
avr.setSpeed(10);
avr.setSpeed("max");
```

should remain predictable:

- Realtime mode should avoid blocking a frame for too long.
- Max mode should favor throughput.
- Debug mode should favor precision and observability.

### Phase 17 Progress

Implemented browser-performance slice:

- Added `scripts/benchmark.ts` plus `bun run bench`.
- Benchmark cases cover:
  - tight `RJMP -1` dispatch loop.
  - Arduino `delay()`/`millis()` Blink fixture.
  - Arduino `Serial.println` fixture.
  - Arduino `analogWrite` PWM fixture.
- Added frame-level pin event coalescing:
  - `AVR({ eventCoalescing: { pins: true } })`
  - `avr.setEventCoalescing({ pins: true })`
  - `avr.frame(...)` delivers at most the latest pin event per pin at frame end.
  - `runCycles(...)`, `runFor(...)`, and `step()` still deliver exact events.
- Added regression tests in `test/phase17-performance.test.ts`.

Usage:

```sh
bun run bench
bun run bench -- --case tight-loop --cycles 1000000 --repeats 5
bun run bench -- --json
```

Regression floors:

- `scripts/benchmark-baseline.json` records a reference measurement and an
  enforced `floor` (cycles/s) per case. `test/phase17-performance.test.ts`
  asserts current throughput stays above each floor (best-of-3 runs to damp
  noise). Floors sit ~2.5-3x below measured numbers, so they catch large
  regressions (e.g. a reintroduced per-instruction allocation) without flaking
  on machine/CI variance.

Still remaining in Phase 17:

- Profile and reduce allocations in instruction dispatch, USART, SPI, and GPIO
  listener paths if benchmarks show pressure. (Done so far: removed the
  per-instruction `cycleListeners` clone; see `CPU.notifyCycles`.)
- Consider a generated/function-table decoder only if the current prebuilt table
  becomes the bottleneck.
- Add PWM signal coalescing if the browser demo starts rendering every PWM edge.

**Done when:** the browser demo can run common sketches at realtime or faster
without visible UI stutter.

---

## Phase 18 - Browser Simulator Demo

**Goal:** prove the public API is enough for a Wokwi/Tinkercad-style UI surface.

Create:

```
examples/browser-simulator/
  index.html
  src/
    main.ts
    components/
```

Minimum demo:

- Load a committed HEX file.
- LED on pin 13.
- Button on pin 2 using `avr.pin(2).setInput(...)`.
- Serial monitor using `avr.serial.onText(...)`.
- PWM LED using real pin edges or `avr.pwm(pin).read()`.
- Controls:
  start, pause, resume, reset, speed.

Rules:

- Use only public `AVR(...)` facade APIs.
- No direct CPU writes.
- No manual peripheral wiring.
- Keep the demo simple enough to be a regression target.

### Phase 18 Progress

Implemented browser simulator demo in `examples/browser-simulator/`:

- Builds a standalone browser bundle through `bun run build:demo`.
- Runs through `bun run demo` using the tiny Bun static server.
- Loads committed HEX programs from a selector:
  - Arduino digital-read LED/button fixture.
  - Arduino serial-print fixture.
  - Arduino analogWrite PWM fixture.
  - attachInterrupt fixture.
- Supports custom HEX upload through `avr.loadFile(...)`.
- Provides widgets for:
  - LED on pin 13 through `avr.pin(13).onChange(...)`.
  - Button on pin 2 through `avr.pin(2).setInput(...)`.
  - PWM duty display through `avr.pwm(pin).read()` / `onChange(...)`.
  - Serial monitor through `avr.serial.onText(...)` and `avr.serial.write(...)`.
  - Start/pause/resume/reset/speed controls through facade runtime APIs.
- Uses `eventCoalescing: { pins: true }` so browser frames do not render every
  high-frequency pin edge.
- Components refresh from facade lifecycle events (`reset`, `load`, `clear`,
  `restore`) so program switching does not leave stale LED/PWM/serial UI.
- Phase 18 tests rebuild the demo bundle, verify static serving, verify embedded
  HEX content, and guard against direct CPU/peripheral access from demo code.

Still remaining for a richer Wokwi/Tinkercad-style UI:

- Add draggable components / wiring canvas.
- Add multiple LEDs/buttons and basic sensor widgets.
- Add snapshot/restore buttons for replay.
- Add a register/memory inspector powered by the debugger APIs.
- Add Playwright visual smoke tests once browser automation is introduced.

**Done when:** opening/running the browser example gives a working interactive
simulator with LED, button, serial, and speed controls.

---

## Phase 19 - Compiler Tooling

**Goal:** make local fixture generation repeatable without making the simulator
depend on compilers at runtime.

Add scripts:

```json
{
  "fixtures:arduino": "...",
  "fixtures:avr-gcc": "..."
}
```

Tooling should:

- Compile all Arduino examples with Arduino CLI.
- Compile avr-libc examples with local `avr-gcc`.
- Generate `.hex`.
- Generate `.lst` disassembly.
- Leave `.elf` and build folders ignored.

Rules:

- Tests consume committed `.hex`; they should not require Arduino CLI.
- Fixture rebuild scripts are dev-only.
- Document expected local paths or env vars:
  `ARDUINO_CLI`, `AVR_GCC_BIN`.

### Phase 19 Progress

Implemented dev-only fixture tooling:

- `scripts/fixtures-avr-gcc.ts` (`bun run fixtures:avr-gcc`) compiles every
  `examples/<name>/<name>.c` avr-libc fixture and refreshes its committed `.hex`
  and `.lst`. Flags match the committed artifacts exactly
  (`-mmcu=atmega328p -Os -DF_CPU=16000000UL`); a clean rebuild reproduces every
  committed `.hex` byte-for-byte.
- `scripts/fixtures-arduino.ts` (`bun run fixtures:arduino`) compiles every
  `examples/<name>/<name>.ino` sketch with Arduino CLI
  (`--fqbn arduino:avr:uno`), copies `<name>.ino.hex` out of the build folder,
  and regenerates `<name>.lst`.
- `bun run fixtures` runs both.

Toolchain resolution (dev-only; never touched at test time):

- `$AVR_GCC_BIN` overrides the avr-gcc/objcopy/objdump directory; it defaults to
  the vendored `./avr-gcc/bin`, then falls back to `PATH`.
- `$ARDUINO_CLI` overrides the Arduino CLI path.
- When `$ARDUINO_CLI` is not set on Windows, the Arduino fixture script also
  discovers common Arduino IDE bundled CLI locations, including
  `~/Downloads/arduino-ide/resources/app/lib/backend/resources/arduino-cli.exe`,
  before falling back to `arduino-cli` on `PATH`.

Behavior matches the phase rules: `.elf` and `build/` stay git-ignored, only
`.hex`/`.lst` are committed, and the test suite consumes only the committed
`.hex` (252 tests stay green after a rebuild).

**Done when:** one command refreshes all golden HEX/disassembly artifacts.

---

## Phase 20 - Browser Simulator UX Foundation

**Goal:** turn the Phase 18 proof-of-concept into a Wokwi/Tinkercad-style
interactive surface, still driven only by the public `AVR(...)` facade.

Work items:

- Draggable LED / button / serial / PWM components on a free-form canvas.
- A simple wiring model: drag a wire from a component to a board pin header to
  bind it; rebinding is live and re-subscribes through the facade.
- Snapshot / restore buttons for replay (capture once, restore many times).
- A debugger / register inspector panel: PC, SREG flags, R0-R31, SP, cycles,
  single-step, breakpoints, and data watchpoints.
- Playwright visual smoke tests for the browser demo.

Rules:

- Keep the public-only rule: components use `AVR(...)` handles and `avr.cpu`
  only as the documented read-only inspection escape hatch (no CPU/flash/data
  writes, no manual peripheral wiring).
- Keep the Phase 18 demo working: existing slot IDs and widget classes stay so
  the Phase 18 smoke test stays green.
- Playwright is dev-only and must not be required by the unit test suite.

### Phase 20 Progress

Implemented the UX foundation in `examples/browser-simulator/`:

- `src/workspace.ts` - free-form canvas with draggable nodes and an SVG wire
  overlay. Ports register themselves; dragging from a component port to a pin
  port (or vice-versa) creates a wire and invokes a bind callback. Wires reroute
  whenever a node is dragged. A component can hold one wire at a time; rebinding
  replaces it.
- LED / button / PWM components gained `setPin(pin)` so the wiring model can
  rebind them live; they re-subscribe through the facade and keep refreshing
  from lifecycle events.
- `src/components/board.ts` - digital pin-header strip (D0-D13) exposing one
  wire port per pin. The board now mirrors each pin's effective LOW/HIGH state
  through `avr.pin(pin).onChange(...)`, so firmware output and simulated input
  are visible without opening the inspector.
- The button widget now shows LOW/HIGH state directly, and program switching or
  custom HEX upload restarts the simulator after loading so the UI does not
  appear idle.
- The browser demo starts at `0.25x` by default to keep the main-thread UI
  responsive; the speed controls still expose `1`, `10`, and `max`.
- `src/components/inspector.ts` - register/memory + debugger panel reading
  through `avr.cpu` (PC, SP, SREG flags, R0-R31, cycles), with single-step,
  add/clear breakpoint, and a data watchpoint that uses `avr.watchData(...)`.
- `src/components/controls.ts` - added Snapshot / Restore / Step buttons backed
  by `avr.snapshot()` / `avr.restore(...)` / `avr.step()`. Runtime counters are
  throttled so live status does not churn the DOM while the user clicks or drags.
- `playwright.config.ts` + `examples/browser-simulator/tests/*.spec.ts` -
  visual/behavioral smoke tests (load demo, press button, program switching,
  snapshot -> advance -> restore, drag rewiring, inspector shows registers, and
  screenshot smoke). Run with
  `bunx playwright install` then `bun run test:e2e`; not part of `bun test`.
- `test/phase20-ux.test.ts` - bun smoke tests (bundle/markup/styles/facade-only
  rules) that run in the normal suite without a browser.

**Done when:** the browser demo lets a user drag components, wire them to pins,
snapshot/restore, and inspect registers/step the CPU, with Playwright smoke
tests covering the happy path.

---

## Next Browser Simulator Improvements

The next browser-product roadmap has moved to
[`docs/06-browser-simulator-improvements.md`](./06-browser-simulator-improvements.md).

Keep this file focused on core simulator phases and completed baseline work; use
the separate browser improvement plan for Phase 21 worker runtime, circuit
documents, component adapters, instruments, and the v1.3 target.

---

## v1.1 Definition Of Done

v1.1 is done when:

- Real Arduino Blink, Serial, digital input, PWM, and attachInterrupt fixtures run.
- Browser demo uses only public facade APIs.
- Simulator supports start/pause/resume/stop/speed/reset/load/reload.
- Snapshot/restore works for CPU, pins, timers, serial, and loaded program state.
- Breakpoints and single-step are usable from the facade.
- Common failures pause with useful errors instead of leaving the UI confused.

---

## v1.2 Definition Of Done

v1.2 is done when:

- The browser demo offers a draggable component canvas with a functional wiring
  model bound through the public facade.
- Snapshot/restore and single-step/breakpoints are usable from the demo UI, not
  only from code.
- A register/memory inspector reflects live CPU state.
- Playwright smoke tests cover load, interaction, snapshot/restore, and the
  inspector happy path.
