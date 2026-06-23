# avr8js Parity Plan

This plan continues from `07-performance-optimization-plan.md`. Phase 7 there took
the cheap structural wins (the `notifyCycles` hot path, predecode cache, flag
assembly) and explicitly deferred the two large items needed to approach avr8js.
This document is the decision record for those two items: what the remaining gap
actually is, why it exists, and the order to close it in.

The easy micro-optimization budget is spent. What is left needs small, explicit
refactors before it can be optimized safely.

---

## Where we stand

Measured locally with `bun run bench:compare --repeats 3` (Bun, 16 MHz budget),
two separate runs to show the spread:

```text
workload        avrts            avr8js          avrts/avr8js
tight-loop      24.2–25.7M/s     90.5M/s         0.27–0.29x
delay-blink     10.7–10.9M/s     45.6M/s         0.24–0.27x
serial-print     3.8M/s          34.4M/s         0.09–0.11x
analog-write     7.2–7.4M/s      42.3M/s         0.11–0.18x
```

The ratio is **noisy run-to-run** — avr8js in particular varies, so the
serial/analog ratios swing (0.09–0.18x). Treat these as order-of-magnitude, not
precise: avrts is ~4x behind on dispatch-bound loops and ~6–10x behind on
peripheral-heavy ones. Track the *trend* across a change, not a single number.

Context that matters before optimizing further:

- `tight-loop` already exceeds 16 MHz realtime (1.5x). avrts is not "broken slow";
  it is slower than avr8js by a constant architectural factor, not by a bug.
- The gap is widest on `serial-print` and `analog-write`, the workloads that keep
  peripherals busy. That points at the per-instruction peripheral dispatcher as a
  major remaining cost. It is not the only cost: `tight-loop` still shows the
  instruction dispatch/core overhead even when peripheral work is minimal.

Neither fix below reaches parity alone. Together they close the obvious remaining
gap, but avr8js still has a simpler instruction core. Decide how far up the curve
we actually want to climb before starting.

---

## Root cause 1 — per-instruction peripheral fan-out vs. event scheduling

This is the larger cause and the reason serial/analog are the worst cases.

- **avr8js** schedules peripherals as clock events. `cpu.tick()` is essentially one
  comparison: "is the next due event's cycle reached yet?" A USART that is not
  mid-byte, a timer with no near edge, an idle ADC — all cost nothing per
  instruction.
- **avrts** does **not** register each peripheral as its own CPU cycle listener.
  The runtime installs a *single* `cpu.onCycles` listener
  ([src/avr.ts:364](../src/avr.ts#L364)) that calls one internal dispatcher,
  `AVRRuntime.tickPeripherals` ([src/avr.ts:929](../src/avr.ts#L929)). That
  dispatcher fans out to exti, timer0/1/2, ADC, and USART every instruction,
  whether or not each has work to do. The Phase 1/2 cached idle fast paths make
  each `tick(...)` return early, but the **dispatcher body still runs every
  instruction**: the six method calls, plus the `cycles` setter and
  `notifyCycles` machinery that drive the single listener.

  This matters for targeting: the work to remove is in `tickPeripherals`
  (src/avr.ts), not in the CPU's `cycleListeners` array. The migration empties
  `tickPeripherals` peripheral by peripheral; "delete the fan-out" means removing
  each `.tick(...)` line and eventually the `cpu.onCycles(...)` registration
  itself.

The foundation to remove this already exists and is partly built:

- `CPU.addClockEvent` / `clearClockEvent` / `runDueClockEvents` are implemented
  ([src/cpu/cpu.ts:229](../src/cpu/cpu.ts#L229)), with a one-comparison due-check
  folded into the `cycles` setter.
- The **watchdog** is already migrated — it is event-scheduled and *not* in
  `tickPeripherals` (see the comment at [src/avr.ts:936](../src/avr.ts#L936)).
- **exti** is a half-step: it is attached with `cycleListener: false` and called
  manually as `this.exti.tick()` inside `tickPeripherals`, so it is already
  decoupled from the CPU listener but still per-instruction.

The win is all-or-nothing. Converting one peripheral banks only ~6–7% because the
fan-out keeps running for the rest; the bulk arrives when the **last** peripheral
leaves `onCycles` and the fan-out is deleted.

### Two hard constraints (these are why it was deferred)

1. **Cycle-exact mode.** In `timing === "cycle-exact"` the `cycles` setter fires
   listeners once per simulated cycle so peripheral flags line up inside
   multi-cycle instructions (the `phase12-timing` tests observe flags through
   per-cycle listeners). Scheduled events must fire per-cycle in that mode, before
   `onCycles` listeners, or those tests break.
2. **Live counter reads.** Firmware and tests read a live, mid-window `TCNT`
   (`phase8-pwm`, `phase10-snapshot`). An event-scheduled timer only advances its
   counter when its event fires, so it needs an on-read hook that computes the
   current count from elapsed cycles since the last event. This is avr8js's
   ~500-line `timer.js` territory — the migration is real work, not a rename.

### Prerequisite — CPU event-order refactor (do this first, before any timer)

The current `cycles` setter ([src/cpu/cpu.ts:72](../src/cpu/cpu.ts#L72)) does **not**
yet satisfy constraint 1, so a migrated timer would observe events at the wrong
time:

```ts
set cycles(value: number) {
  const delta = value - this._cycles;
  this._cycles = value;
  if (delta <= 0) return;
  if (this.timing === "cycle-exact") {
    for (let i = 0; i < delta; i += 1) this.notifyCycles(1); // listeners, per cycle
  } else {
    this.notifyCycles(delta);
  }
  const next = this.nextClockEvent;
  if (next !== undefined && next.cycles <= this._cycles) this.runDueClockEvents();
}
```

Two problems for an event-scheduled peripheral:

- Clock events fire **once at the end** of the whole delta, even in cycle-exact
  mode — they are not interleaved per cycle.
- They fire **after** `onCycles` listeners, not before.

So before migrating any timer, refactor the setter so that in cycle-exact mode each
single-cycle step fires due clock events at the correct point (per constraint 1,
before that cycle's `onCycles` listeners), while fast mode keeps its coalesced
behavior. This is a small, self-contained CPU change but it is **load-bearing for
correctness** and must land — with its own tests — ahead of the timer work.

Done when:

- A cycle-exact test proves a scheduled event fires on the exact cycle and before
  the `onCycles` listeners for that cycle.
- `phase12-timing` and all existing cycle-exact tests stay green.
- Fast-mode coalescing is unchanged (benchmark floors hold).

### Plan

After the prerequisite lands, migrate in this order, keeping `tickPeripherals`
alive until the last peripheral leaves it:

1. **Timer2** first — simplest (8-bit, no input capture), proves the on-read TCNT
   hook and the cycle-exact event path on the least-coupled timer.
2. **Timer0** — the Arduino `millis`/`delay` timer; this is what moves
   `delay-blink`.
3. **Timer1** — 16-bit, input capture, the most logic; do it once the pattern is
   proven.
4. **ADC** — note the load-bearing ordering: ADC auto-trigger reads timer flags
   (`TIFR0`/`TIFR1`), so its event must observe the timers' current state. Schedule
   the conversion-complete event and compute liveness on read.
5. **USART** — the immediate-TX model makes `UDRE0` effectively always set, so the
   UDRE interrupt is **level-triggered**: while `UDRIE0` is set it must be
   re-requested every instruction (the vector is removed from the pending queue on
   ISR entry). An event model must re-arm a 1-cycle event while that condition
   holds, not fire once. The `serial-print-listener` benchmark and the Phase 1
   UDRE re-fire test guard this.
6. **External-interrupt level mode** — same level-triggered shape; keep its active
   fast path or fold it into the same re-arm pattern.
7. **Delete the `onCycles` fan-out wiring** in the runtime dispatcher. Keep public
   `cpu.onCycles(...)` — tests and tooling use it — but stop registering the
   internal peripherals on it.

### Cache/restore rule (carry over from Phase 1)

Any state derived from CPU registers — including a peripheral's "next event cycle"
— must refresh on normal writes, `reset()`, and `restore()`. Snapshot restore
writes `data` directly and does **not** replay `@OnWrite` hooks, and it already
clears `nextClockEvent`, so each peripheral's `restore()`/`resync()` must re-arm
its events from the restored register state. A peripheral that forgets this will
silently stop ticking after a restore.

### Tests (must stay green the whole way)

- `phase12-timing` (cycle-exact flag alignment) — the gate for constraint 1.
- `phase8-pwm`, `phase10-snapshot` (live TCNT reads) — the gate for constraint 2.
- Timer compare/overflow, ADC, USART, snapshot/restore suites.
- Real Arduino delay/serial/analogWrite golden fixtures.
- The UDRE re-fire test and `serial-print-listener` floor (level-triggered guard).

### Done when

- Per-instruction listener fan-out is gone for idle peripherals (an idle sketch
  does no peripheral work between scheduled events).
- `serial-print` and `analog-write` move materially toward avr8js; `delay-blink`
  improves once Timer0 lands.
- All correctness gates above stay green, in both `fast` and `cycle-exact` mode.

---

## Root cause 2 — handler dispatch vs. a monolithic switch

Smaller than cause 1, but it is the floor `tight-loop` cannot pass.

- **avr8js** decodes in one giant function (`avrInstruction`) — nested `switch`es on
  the opcode bits. V8 compiles it to a jump table inside a single optimized,
  inlinable frame.
- **avrts** dispatches through the predecode cache: `handler = decodeCache[pc]`,
  then `handler(this, opcode)` ([src/cpu/cpu.ts:464](../src/cpu/cpu.ts#L464)). That
  call site is **megamorphic** — it reaches ~130 distinct handler functions — so V8
  cannot inline through it. Every instruction pays an array read plus a real
  indirect call frame. On top of that, each `cpu.cycles += N` runs the `cycles`
  setter, and `serviceInterrupts` runs after every instruction.

The decorator/handler-table design is *why the instruction code reads well* and is
fully test-covered. The goal here is not to throw it away — it stays the source of
truth — but to keep the hottest opcodes from paying the megamorphic call.

### Required first: extract the shared helpers

The "reuse the same helpers" idea has a blocker. The arithmetic/flag/memory helpers
the handlers use are **private methods on `InstructionSet`** — e.g.
`add8` ([src/cpu/instructions.ts:913](../src/cpu/instructions.ts#L913)), `sub8`,
`multiply`. `runFast` lives in `CPU` (a different class in a different module) and
cannot call them. So inlining is **not** zero-architecture:

- Option A (preferred): extract the pure helpers (`add8`, `sub8`, flag assembly,
  the operand-field decoders already at the top of `instructions.ts`) into a shared
  module — e.g. `src/cpu/alu.ts` — as free functions taking `(cpu, ...)`. Both
  `InstructionSet` and `runFast` import them. One source of truth, no duplication.
- Option B (reject unless A proves infeasible): duplicate the hot semantics inline
  in `runFast`. Faster to write, but now two copies of flag math must stay in sync —
  exactly the bug surface this simulator's test suite exists to prevent.

Do the extraction as its own commit, prove it green (it is a pure refactor — same
handlers, same results), then build the inlining on top.

### Plan (incremental, measured per opcode)

`runFast` ([src/cpu/cpu.ts:414](../src/cpu/cpu.ts#L414)) already inlines NOP, RJMP,
and the conditional branches directly, skipping the handler call for them. Extend
that same inline ladder to the next most frequent opcodes, measuring after each:

1. Profile a representative fixture to rank opcode frequency (do not guess the
   order — confirm it). Expect the top of the list to be `LDI`, `MOV`, `OUT`, `IN`,
   `ADD`/`ADC`, `SUB`/`SUBI`, `LDS`/`STS`, `CP`/`CPI`.
2. Inline the top ~8–10 into the `runFast` switch ladder, each delegating to the
   extracted shared helpers (call `add8(cpu, …)`, `writeData`, etc. — never a second
   copy of the flag math). Anything not inlined falls through to the existing
   `decodeCache[pc]` path unchanged.
3. Re-run `bun test`, the new fast-run parity tests (below), and `bun run bench`
   after every opcode added. Stop when the curve flattens — there is a long tail
   where inlining buys nothing and only adds surface area.

This is the cheaper of the two causes to attack and the safer one — no peripheral
semantics move and the inlined ops reuse the proven helpers. Treat it as the warm-up
before the peripheral migration, or as the thing to do if the migration is judged
too risky.

### Tests — the existing suite is NOT enough

This is the trap. Most instruction tests drive `cpu.tick()` directly, but `runFast`
is reached **only** through `CPU.run()` and contains its *own* inline opcode
implementations. A bug in an inlined `runFast` opcode would not be caught by the
tick()-based tests, because those never execute the `runFast` path. Inlining
without new tests is shipping an untested second implementation of each opcode.

So each newly inlined opcode needs explicit **fast-run parity** coverage:

- For each inlined opcode, run the same program/state two ways — once stepping via
  `cpu.tick()` (handler path), once via `cpu.run()` with enough cycles to hit
  `runFast` (inline path) — and assert identical resulting CPU state (registers,
  SREG, PC, cycles, and any memory the op touches).
- Cover the flag-bearing edges, not just the happy path: carry in/out, overflow,
  half-carry, the `Z`-AND-previous behavior of `SBC`/`CPC`, and signed boundaries.
- Add these in lockstep with each opcode in step 2 above — never inline an opcode
  in one commit and test it in a later one.

### Done when

- The hottest opcodes execute without the megamorphic `handler(...)` call.
- Each inlined opcode has fast-run parity tests proving the `runFast` inline and the
  handler produce identical state.
- `tight-loop` and `delay-blink` improve; full instruction + golden suites stay
  green.

---

## Recommended order and honest ceiling

1. **Root cause 2 first** (handler inlining). The cheaper, safer one. Sequence
   inside it: (a) extract the shared ALU/flag helpers into a module — pure refactor;
   (b) inline the hottest opcodes one at a time, each with fast-run parity tests.
   Good warm-up and it buys real `tight-loop`/`delay-blink`.
2. **Root cause 1 next** (event migration). Sequence inside it: (a) the CPU
   event-order refactor prerequisite (cycle-exact events fire per-cycle, before
   `onCycles` listeners) with its own tests; (b) migrate peripherals out of
   `tickPeripherals` — Timer2 → Timer0 → Timer1 → ADC → USART → exti — then remove
   the `cpu.onCycles` registration. Bigger win, especially for serial/analog, but
   gated by cycle-exact mode and live-counter reads.

Neither phase is zero-refactor: cause 2 needs the helper extraction first, cause 1
needs the setter event-order fix first. Both prerequisites are small, but skipping
them is where this goes wrong — that is the core of the review feedback this plan
was revised against.

Set expectations before starting: even with both done, avrts is unlikely to reach
1.0x of avr8js. avr8js's remaining lead lives in the instruction-execution core
itself — `readData`/`writeData` indirection, the `cycles` setter, per-instruction
`serviceInterrupts` — which avrts keeps deliberately for fidelity, hookability, and
readability. The target is "close the obvious gap on peripheral-heavy workloads and
get `delay-blink` near realtime", not "match avr8js". Decide that target explicitly;
do not let it drift into a rewrite of the core.

Run before and after every patch:

```sh
bun run bench:compare -- --repeats 3   # track the ratio, not just cycles/s
bun run bench -- --repeats 3           # regression floors
bun test
bun run typecheck
```
