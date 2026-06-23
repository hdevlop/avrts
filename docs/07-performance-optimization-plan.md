# Performance Optimization Plan

This plan starts after the Phase 17 performance work and the browser worker work.
The simulator now has benchmark coverage, regression floors, and a working
browser-facing runtime. The next goal is to move common 16 MHz Arduino sketches
closer to realtime without weakening instruction/peripheral fidelity.

Realtime target:

```text
16,000,000 simulated cycles per wall-clock second = 1.0x realtime at 16 MHz
```

Recent local benchmark samples are still below realtime for 16 MHz workloads.
That is acceptable for tests, stepping, snapshots, and demos, but a public
production simulator should document the limit or close the gap.

Use this command before and after every performance patch:

```sh
bun run bench -- --repeats 3
```

And keep the correctness gates green:

```sh
bun test
bun run typecheck
```

---

## Goals

- Keep correctness first: no benchmark win should break timing, interrupts,
  snapshots, or real compiled fixtures.
- Reduce fixed per-instruction overhead.
- Keep browser UI output coalesced and frame-rate limited.
- Preserve deterministic `runCycles(...)`, `runFor(...)`, and `step()` behavior.
- Make every optimization measurable with `scripts/benchmark.ts`.

---

## Phase 1 - Inactive Peripheral Fast Paths

**Goal:** avoid doing work every instruction when a peripheral is disabled or idle.

This is the highest-leverage phase. The dominant per-instruction cost is the
cycle-listener fan-out: `cpu.cycles += N` runs through the setter into
`notifyCycles`, which calls all seven registered listeners (timer0/1/2, adc,
usart, watchdog, and external-interrupt level mode) on every instruction. Most of
those peripherals are idle in a typical sketch yet still do register reads each
tick. Phase 1 makes idle peripherals return early; Phase 2 collapses the fan-out
itself. Together they are the bulk of the available win — the later phases are
second-order.

Highest-value candidates:

- `Adc.tick(cycles)`
  - Return immediately unless a conversion is active or auto-trigger is armed.
    Today `pollAutoTrigger()` runs unconditionally every tick and issues several
    `readData()` calls even when the ADC is off.
  - Cache whether auto-trigger can run instead of recomputing from registers every
    tick.
- `Watchdog.tick(cycles)`
  - Cache enabled state and timeout cycles on `WDTCSR` writes and clock changes.
  - Return immediately when disabled.
- `Usart0.tick()`
  - Safe win: cache "any USART interrupt source enabled" (RXCIE0 / UDRIE0 / TXCIE0)
    on `UCSR0B` writes and return early when none are set.
  - Caution: do not move fully to write-triggered queueing. In this immediate-TX
    model `UDRE0` is effectively always set, so the UDRE interrupt is
    *level-triggered* — it must be re-requested every instruction while UDRIE0 is
    set, exactly like external-interrupt level mode, because the vector is removed
    from the pending queue on ISR entry. A write-only model would fire it once and
    stop.
- `ExternalInterrupts.evaluateLevelMode()`
  - Only run on cycles when INT0/INT1 level mode is enabled.
  - Cache the level-mode-active flag on `EICRA` and `EIMSK` writes.

Adjacent micro-opt (fold in here):

- Hot per-instruction paths that read a register the peripheral *owns* can use
  `cpu.data[addr]` directly only when that address has no read hook, or when
  bypassing hooks is explicitly safe. This skips the `readHooks[addr]` scan.
  `Adc.pollAutoTrigger()` is the clearest case (~4-5 `readData` calls per
  instruction while idle).

Cache rule:

- Any cached peripheral state derived from CPU registers must refresh on normal
  writes, `reset()`, and `restore()`. Snapshot restore writes CPU data directly
  and does not replay `@OnWrite` hooks, so stale enabled/disabled caches would
  otherwise silently skip restored peripherals.

Tests:

- Existing ADC, USART, watchdog, and external interrupt tests stay green.
- Add narrow tests for cached enabled/disabled transitions if behavior changes.
- Add a USART test that proves the UDRE interrupt still re-fires each instruction
  while UDRIE0 + UDRE0 hold (guards against the write-only regression above).

Done when:

- `tight-loop` improves without changing fixture behavior.
- `delay-blink`, `serial-print`, and `analog-write` do not regress.

---

## Phase 2 - Combine Internal Cycle Dispatch

**Goal:** reduce listener-call overhead in the hot instruction loop.

The runtime currently wires several internal peripherals through `cpu.onCycles`.
That is clean, but every instruction pays one callback dispatch per listener.

Plan:

- Keep public `cpu.onCycles(...)` for tests and advanced users.
- Add one internal runtime cycle dispatcher in `AVRRuntime`:

```ts
this.cpu.onCycles((cycles) => {
  this.timer0.tick(cycles);
  this.timer1.tick(cycles);
  this.timer2.tick(cycles);
  this.adc.tick(cycles);
  this.usart0.tick();
  this.watchdog.tick(cycles);
});
```

- Keep `ExternalInterrupts` either in the dispatcher or behind its own active
  fast path. Note the *current* wiring runs the external-interrupt level-mode
  listener first (its `attach()` registers before the timer/adc/usart/watchdog
  listeners), not last.
- Do not remove public `cpu.onCycles(...)`; it is useful for tests and tooling.
- The dispatcher is the natural home for the Phase 1 cached-enabled checks: an
  inline `if (!adcArmed) ...` skip beats a per-peripheral early-return reached
  through a closure call. Consider landing Phase 2 first and folding Phase 1's
  fast paths into the single dispatcher, rather than strictly sequencing them.

Risk:

- The one ordering that is load-bearing: ADC auto-trigger reads timer flags
  (`TIFR0` / `TIFR1`), so the timers must tick before the ADC for the ADC to see
  this instruction's flags. The dispatcher above preserves that. Beyond it,
  request *order within an instruction does not affect interrupt priority* —
  `requestInterrupt` sorts the pending queue by vector and dedups, and the lowest
  vector is serviced first regardless of insertion order. So reordering is lower
  risk than it looks; keep the timers-before-ADC constraint and let tests prove
  the rest.

Tests:

- Phase 12 timing tests.
- Timer compare and overflow tests.
- Snapshot/restore timer tests.
- Real Arduino delay/serial/analogWrite fixtures.

Done when:

- Hot-path callback count is lower.
- `bun test` and benchmark floors still pass.

---

## Phase 3 - Bulk-Advance Timers

**Goal:** stop looping one timer increment at a time when a tick covers many timer
steps.

Status: **implemented narrowly**. Timer0, Timer1, and Timer2 now bulk-advance
only for the high-value safe case: prescaler `/1` with a multi-cycle fast-mode
tick. Single timer steps and all prescaled timers keep the original exact
remainder loop so common Arduino Timer0 `/64` workloads do not pay broad
bulk-advance overhead. Timer internals also use direct `cpu.data[...]` reads for
timer-owned hot registers where no read hook behavior is required.

Measured result: correctness stayed green, but the benchmark win is mixed rather
than decisive. On this runtime, `runCycles()` still advances by executed
instructions, so most timer ticks are one to four CPU cycles and Arduino
fixtures often use prescaled timers. A 10-repeat analog-only sample after the
patch measured about `4,949,399 cycles/s` (`0.31x realtime`), so this phase
should not be treated as the path to 1.0x realtime by itself.

Current timer shape:

```ts
while (this.prescalerRemainder >= prescaler) {
  this.prescalerRemainder -= prescaler;
  this.incrementCounter();
}
```

That is accurate but expensive when a multi-cycle instruction or fast-mode chunk
produces many timer steps.

Scope honestly — this win is narrower than it first looks:

- Timers already coalesce via `prescalerRemainder`; the expensive
  `incrementCounter` body only runs when the remainder crosses the prescaler. At
  prescaler 64/256/1024 (the common case) that is rare, so the per-instruction
  cost is already just an add and a compare.
- The real gain is at **prescaler=1 with large deltas** (e.g. PWM-heavy counting).
  This should help `analog-write`, but will not move `delay-blink` — Arduino's
  `delay`/`millis` runs Timer0 at prescaler 64.
- The gain is **fast-mode only**. In cycle-exact mode the `cycles` setter calls
  `tick(1)` per cycle, so there is nothing to bulk-advance.

Plan:

- Compute timer steps in bulk:

```ts
const total = this.prescalerRemainder + cycles;
const steps = Math.floor(total / prescaler);
this.prescalerRemainder = total % prescaler;
```

- For simple normal mode with no compare/PWM/interrupt edge nearby, advance the
  counter by `steps` directly.
- When a compare match, overflow, PWM edge, or interrupt flag is reachable inside
  the step window, walk only until that event, handle it, then continue.
- Start with Timer0, then port the pattern to Timer2 and Timer1.

Risk:

- Timer edge timing is easy to get subtly wrong. This phase must be test-driven.

Tests:

- Exact cycle tests in `test/phase12-timing.test.ts`.
- Timer compare tests.
- PWM edge tests.
- Real Timer0 overflow and Arduino delay golden fixtures.

Done when:

- Prescaler=1 PWM / `analog-write` workloads improve.
- `delay-blink` does not regress; it is not expected to move much because
  Arduino `delay` / `millis` uses Timer0 prescaler 64.
- Cycle-exact tests remain exact.

---

## Phase 4 - Predecode Loaded Flash

**Goal:** dispatch each instruction without an `executor.execute()` call frame.

Status: **implemented, and it paid off — the earlier "likely low value" prediction
was wrong.** Dispatch was already a full 64K direct-indexed table
(`handlers[opcode]`), so a `pc -> handler` cache does *not* reduce the array-read
count (`flash[pc]` is still read for the opcode argument). The win turned out to
come from a different place: the cache lets the CPU hot loop call the handler
**directly** (`handler(this, opcode)`) instead of going through
`executor.execute()`, removing one call frame and the per-instruction
unknown-opcode branch. V8 was not fully inlining `execute()`, so that frame was
real. Measured (5 repeats, local Bun): tight-loop `11.5M -> 14.2M cycles/s`
(+~23%, 0.89x realtime), delay-blink `6.6M -> 8.0M` (+~21%), analog-write
`5.0M -> 5.4M`, serial-print-listener `3.0M -> 3.5M`.

Implementation:

- `CPU.decodeCache: Array<InstructionHandler | undefined>`, lazily filled per PC
  in `tick()`. On a miss it resolves `executor.handlerFor(opcode)` once and stores
  it; an unknown opcode falls through to `executor.execute()` so the rich
  `UnknownOpcodeError` (with disassembly hint) and `pauseOnUnknownOpcode` behavior
  are unchanged.
- Invalidation is automatic on `reset()` (runs after every `loadHex`/`reload`),
  `restore()`, and `setExecutor()`. A public `cpu.invalidateDecodeCache()` covers
  the one case the CPU cannot trap: a direct `cpu.flash[...]` write that mutates an
  already-executed PC (self-modifying code via the escape hatch). No `SPM`
  instruction is modeled, so firmware cannot self-modify flash.

Not done (and not needed so far): operand pre-decode into specialized closures.
The call-frame removal alone captured the gain; pre-extracting operands risks
megamorphic closure shapes for marginal benefit. Revisit only if a profile shows
operand extraction is hot.

Tests:

- `test/cpu.test.ts` — cache reuse, `invalidateDecodeCache()` after a direct flash
  rewrite, and `reset()`-driven invalidation (proves stale handlers cannot run old
  code).
- Full instruction/golden suites stay green (the handler resolved per PC is the
  same one `execute()` would have dispatched).

Done when:

- Tight loops and real firmware loops improve. ✅
- Direct flash access remains predictable: documented + `invalidateDecodeCache()`. ✅

---

## Phase 5 - Serial And Browser Output Batching

**Goal:** reduce UI/message overhead for chatty sketches.

`serial-print` is often the slowest benchmark because it exercises firmware,
USART state, host text accumulation, and event delivery.

Status: **implemented**. Core serial text accumulation is chunk-backed instead of
concatenating on every byte, the chunk buffer is bounded (folded into the joined
cache past `SERIAL_CHUNK_COMPACT_THRESHOLD` so a headless run that never calls
`serial.getText()` cannot grow unbounded), the common one-listener USART/text
paths avoid per-byte listener-array allocation, and the browser worker coalesces
serial text into one `postMessage` per frame flush.

Important measurement note: the original `serial-print` benchmark registers **no**
`onText` listener, so none of the above is on its hot path — its throughput is
firmware-bound (Print integer formatting) plus per-instruction peripheral ticks
already handled by Phases 1-2, and it does not move with Phase 5. A second
benchmark case, `serial-print-listener`, attaches a text subscriber so the Phase 5
output path is actually exercised and regression-gated. The browser-side win
(fewer `postMessage` calls per frame) is a responsiveness property the throughput
benchmark cannot see and must be judged separately.

Plan:

- Buffer serial characters inside the browser worker and emit text chunks at
  frame cadence.
- Keep exact serial byte callbacks available in core/runtime mode.
- Avoid repeated string concatenation for large output; accumulate chunks and
  join when `serial.getText()` is requested, but bound the chunk buffer so a run
  with no `getText()` consumer cannot accumulate forever.
- Stop allocating a fresh listener array per byte. Both `emitSerialByte`
  (`[...this.textListeners]`) and USART `onWriteUdr0` (`[...this.txListeners]`)
  copy their listener set on every emitted byte; iterate directly, or snapshot
  only when a listener actually mutates the set during dispatch.
- Keep logic analyzer exact-edge capture opt-in only.

Browser rules:

- Pins: frame-rate coalesced by default.
- PWM: frame-rate sampled by default.
- Serial: chunked by frame or bounded buffer size.
- Logic analyzer/scope: exact only while capture is active.

Tests:

- Serial text fixture still emits the same final text.
- Chunk buffer stays bounded across a long headless run (compaction fires).
- Browser worker serial events preserve order and coalesce per frame.
- Existing exact edge capture tests still pass.

Done when:

- `serial-print-listener` throughput does not regress (the listener path is
  exercised and floored in `benchmark-baseline.json`). `serial-print` itself is
  firmware-bound and is not the metric for this phase.
- Browser worker emits at most one serial `postMessage` per frame for a
  serial-heavy sketch (responsiveness), verified separately from raw throughput.
- The core chunk buffer stays bounded with no `getText()` consumer.

---

## Phase 6 - Production Performance Gates

**Goal:** make performance regressions visible before release.

Plan:

- Keep `scripts/benchmark-baseline.json` with conservative floors.
- Add an optional CI job that reports benchmark numbers without failing on small
  variance.
- Only raise floors after a measured improvement is stable on at least two
  machines or CI runners.
- Record benchmark command, machine notes, and commit hash when changing floors.

Release notes should document:

- Realtime factor for common workloads.
- Recommended clocks for browser demos.
- Difference between deterministic core execution and browser worker mode.
- Known fidelity/performance tradeoffs.

Done when:

- CI runs tests and typecheck on every change.
- Benchmark floors catch large regressions.
- Public docs explain the 16 MHz realtime status honestly.

---

## Phase 7 - avr8js Comparison, the notifyCycles Bottleneck, and Event Scheduling

This phase started as "can we adopt avr8js's architecture to close the gap?" and
ended somewhere more useful: the biggest win was a ~30-line hot-path fix, not a
rearchitecture. Recording the full path because the *method* (probe before you
build) is the reusable part.

### The avr8js comparison

`scripts/benchmark-compare.ts` (`bun run bench:compare`) runs the same HEX through
avrts and avr8js with equivalent peripherals. Starting point (after Phases 1-4):

```text
workload        avrts        avr8js     avrts/avr8js
tight-loop      14.0M/s      ~91M/s     0.16x
delay-blink      7.4M/s      ~50M/s     0.18x
serial-print     3.1M/s      ~43M/s     0.08x
analog-write     5.6M/s      ~68M/s     0.08x
```

avr8js was 6-12x faster. Its core difference: peripherals are **event-scheduled**
(a clock-event queue; `cpu.tick()` is one due-check) rather than ticked every
instruction.

### Probes (measure the ceiling before building)

Throwaway probes on the clean isolator (tight-loop: synthetic, all peripherals
idle, no control-flow dependency):

| probe | tight-loop | reading |
| --- | --- | --- |
| baseline | 14.0M | — |
| skip the 6 peripheral `tick()` calls | 14.97M (+7%) | the ticks themselves are cheap |
| bypass the whole `notifyCycles` fan-out | 25.2M (+80%) | the *fan-out machinery* is the cost |
| plain `notifyCycles` loop (no bookkeeping) | 21.9M (+60%) | specifically the **deferred-removal bookkeeping** |

The decisive finding: the per-instruction cost was **not** the peripheral work. It
was `notifyCycles` running its reentrancy/deferred-removal bookkeeping — a
`Map.clear()`, an array drain, and a `for..of` (allocating an iterator) — on
*every instruction*, to guard an unsubscribe-during-dispatch case that essentially
never happens at runtime.

### The fix (implemented)

`CPU.notifyCycles` now has a hot path: when not reentrant and no removals are
pending (every normal instruction), it runs a plain listener loop and skips all
the bookkeeping. The full depth-aware path is kept for the reentrant /
removal-pending case, so the three `cpu.test.ts` reentrancy semantics
(unsubscribe-during-dispatch still fires this round; add-during-dispatch waits;
nested-removal depth rules) and the cycle-exact timing tests stay green.

Result (5-repeat local Bun), all 343 tests green:

```text
workload        before   after    realtime   avrts/avr8js
tight-loop      14.0M    20.7M    1.29x       0.16x -> 0.24x
delay-blink      7.4M    11.7M    0.73x       0.18x -> 0.27x
serial-print     3.1M     3.6M    0.23x       0.08x -> 0.11x
analog-write     5.6M     6.6M    0.41x       0.08x -> 0.10x
```

tight-loop now exceeds realtime; delay-blink reached 0.73x. This was the cheapest,
lowest-risk win available and it was hiding in plain sight.

### Event scheduling: foundation laid, migration deferred

The CPU also gained an event-queue API (`addClockEvent` / `clearClockEvent`, with a
one-comparison due-check in the `cycles` setter), and the **watchdog** was moved
onto it as the first peripheral off the per-instruction dispatcher (correct,
green, perf-neutral — it was already near-free when idle).

The full event migration (all timers + ADC + USART + EXTI, then delete the
fan-out) is **deferred**, with two findings that reshape its priority:

- Its win is back-loaded and all-or-nothing: converting one peripheral banks ~6-7%
  because the fan-out keeps running for the rest. You only collect the bulk of it
  when the *last* peripheral leaves `onCycles`. The `notifyCycles` fix already
  captured most of that bulk far more cheaply.
- Two hard constraints make it costly: (1) cycle-exact mode requires events to fire
  per-cycle *before* `onCycles` listeners (the `phase12-timing` flag tests observe
  flags via per-cycle listeners); (2) an on-read TCNT liveness hook is required
  because tests/firmware read live mid-window counter values
  (`phase8-pwm`, `phase10-snapshot`). This is avr8js's ~500-line timer.js territory.
- Even at its ceiling (~25M tight-loop), avrts would be ~0.28x of avr8js. The
  remaining ~3.5x is the **instruction-execution core** (decode/handler structure,
  `readData`/`writeData` indirection, the `cycles` setter, `serviceInterrupts` per
  instruction) — a separate, larger effort.

Recommendation: take the cheap structural wins first (done), then decide the event
migration against the core-execution work — neither alone reaches avr8js parity.

---

## Recommended Next Patch

**Phase 1 + Phase 2 are now implemented.** The runtime has one internal cycle
dispatcher, and ADC, USART, watchdog, and external-interrupt level mode have
cached idle fast paths that refresh on writes, reset, and restore.

**Phase 7's `notifyCycles` hot path is the headline win so far** (+48-58% on
dispatch-bound and millis-driven workloads; tight-loop > realtime). The next
profitable step is most likely the instruction-execution core, not more peripheral
work — confirm with a profile before committing to the event migration.

**Phase 3 is now implemented narrowly.** Timer bulk-advance is present for
prescaler `/1` multi-cycle ticks and timer hot paths use direct owned-register
reads, but local benchmarks show only mixed/neutral gains. Do not broaden timer
bulk logic without a profile or a scheduler change that creates larger safe timer
deltas.

Reassess with fresh benchmark numbers before going further:

- **Profile next** if realtime is still the target. The current evidence points
  more toward CPU dispatch / instruction execution cost than toward timer
  increment loops.
- **Phase 4 (predecode)** only if a profile proves decode is hot; expect it to be
  cut, since dispatch is already a direct table.
- **Phase 5 follow-up** only if browser responsiveness under very large serial
  streams still needs work.
