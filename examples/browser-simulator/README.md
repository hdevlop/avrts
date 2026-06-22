# avrts browser simulator

A browser demo that exercises the public `AVR(...)` facade: a draggable LED,
push-button, and PWM widget on a free-form canvas; a board pin-header strip you
can wire components to; a serial monitor with host-to-RX input; a CPU register /
debugger inspector; program upload; and start/pause/resume/reset, single-step,
snapshot/restore, plus speed controls.

The demo uses only the public facade. No direct CPU writes, no manual peripheral
wiring (`avr.cpu` is used read-only by the inspector) - that is the point of the
regression target.

The demo starts automatically at `0.25x` speed so the browser UI stays
responsive while firmware runs on the main thread. Switch to `1`, `10`, or
`max` from the speed controls when you want more throughput.

## Phase 20 UX foundation

- **Draggable components** - grab the striped handle on each card to move it.
- **Wiring model** - drag from a component's connector dot to a board pin header
  (`D0`-`D13`) to bind it; the widget rebinds live through `avr.pin(...)` /
  `avr.pwm(...)`. PWM-capable pins (`D3/5/6/9/10/11`) are marked with `~`.
- **Live board state** - each digital header mirrors LOW/HIGH state from
  firmware output or simulated input.
- **Snapshot / restore** - capture state once, restore it many times.
- **Inspector** - PC, SP, SREG flags, R0-R31, cycles; single-step; breakpoints
  (`avr.breakpoint`); and data watchpoints (`avr.watchData`).

The runtime opts into `eventCoalescing: { pins: true }` so high-frequency pin
edges collapse to the latest visible state per browser frame. Deterministic APIs
such as `runCycles(...)` remain exact in tests and debugging.

## Files

```text
examples/browser-simulator/
  index.html             # page layout
  src/
    main.ts              # entry: workspace assembly + program selector
    styles.css           # styling
    workspace.ts         # draggable canvas + wiring model (DOM/SVG only)
    components/
      led.ts             # LED widget (rebindable pin)
      button.ts          # push-button widget (rebindable pin)
      pwm-display.ts     # PWM duty-cycle bar (rebindable PWM pin)
      serial-monitor.ts  # Serial text + host RX input
      controls.ts        # run/pause/resume/reset/step + snapshot/restore + speed
      board.ts           # digital pin-header strip (wire targets)
      inspector.ts       # CPU register / debugger panel
  tests/
    demo.spec.ts         # Playwright visual/behavioral smoke tests
  serve.ts               # tiny Bun static server for development
```

## Build

From the repository root:

```bash
bun run build:demo
```

That runs `bun build` against `src/main.ts` and writes the bundle to
`dist/main.js`. The HEX files from `examples/arduino-*/` are embedded into the
bundle as strings, so the demo works from any static file server.

## Run

```bash
bun run demo
```

This starts a tiny Bun server at <http://localhost:5173> serving `index.html`,
`src/styles.css`, and the bundled `dist/main.js`.

## End-to-end tests (Playwright)

The Playwright smoke tests are dev-only and are **not** part of `bun test`. From
the repository root:

```bash
bun add -d @playwright/test     # if not already installed
bunx playwright install chromium
bun run test:e2e
```

`playwright.config.ts` builds and serves the demo automatically, then runs
`tests/demo.spec.ts` (load, default wiring, button input, program switching,
single-step, snapshot/restore, drag rewiring, and a baseline-free screenshot
smoke check).

## Programs

The drop-down picks between four committed fixtures:

| Program | What it does |
|--------|--------------|
| `arduino-digital-read` | Mirrors `digitalRead(2)` onto `digitalWrite(13)` for LED + button. |
| `arduino-serial-print` | `Serial.begin(9600); Serial.println("hello avrts")` once on boot. |
| `arduino-analog-write` | Sets PWM on pins 3/5/9/10/11 via `analogWrite(...)`. |
| `attachInterrupt-blink` | Uses `attachInterrupt(...)` on pin 2 to toggle pin 13 from an ISR. |

You can also upload your own HEX file with the Upload HEX button. It goes
through the public `avr.loadFile(...)` API.

## Why no direct CPU writes

The rule from `docs/05-core-improvements.md`:

> Use only public `AVR(...)` facade APIs.
> No direct CPU writes.
> No manual peripheral wiring.

Every component subscribes through `avr.pin(...).onChange`,
`avr.pwm(...).onChange`, `avr.serial.onText`, and `avr.on(...)`. The inspector
reads `avr.cpu` only for display (never writes) and drives debugging through
`avr.step()`, `avr.breakpoint(...)`, and `avr.watchData(...)`. If the facade ever
changes shape, this demo should fail to compile or fail the Phase 18/20 tests.
