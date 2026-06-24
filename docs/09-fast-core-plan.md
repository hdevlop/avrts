# Fast-Core Plan (profiling-driven)

This plan continues from `08-avr8js-parity-plan.md`. Doc 08 named the two root
causes (per-instruction peripheral fan-out, and megamorphic handler dispatch) and
the prerequisites for fixing each. This doc is the **action-ordered** follow-up: a
profile of what the benchmark fixtures actually execute, and the concrete patch
sequence that profile justifies.

The headline: the cheapest high-value win was hiding in the opcode mix. Profile
first, then patch — the same discipline doc 07 used for the `notifyCycles` fix.

Reproduce the profile any time:

```sh
bun run scripts/profile-opcodes.ts --top 8
```

---

## The profile (executed instructions, not static code)

```text
serial-print    SBIW 49.0%   BREQ 49.0%   (everything else < 0.2%)
analog-write    SBIW 49.6%   BREQ 49.6%   (everything else < 0.1%)
delay-blink     ADC/ADD/DEC/BRNE ~4.5% each (a flatter mix, no single dominator)
tight-loop      RJMP 100%
```

The decisive finding: **`serial-print` and `analog-write` are ~98% a two-instruction
busy-wait loop — `SBIW; BREQ`.** Those are the two workloads with the worst
avr8js ratio (0.09–0.18x), and almost everything they execute is that delay spin.

Two consequences fall straight out of this:

1. **`BREQ` is already inlined** in `runFast` (the `(opcode & 0xfc00) === 0xf000`
   branch — 0xf3f1 lands there and reads the Z bit). So half of the hot loop is
   already fast-pathed. **`SBIW` (0x9720) is the only missing half** — it falls
   through to the megamorphic `decodeCache[pc]` handler call.
2. The peripherals are **idle** during these spins, yet `tickPeripherals` still fans
   out six `tick(...)` calls *per instruction* — ~12 per loop iteration — while
   avr8js does one due-check. avrts pays the fan-out tax hardest exactly when
   nothing is happening.

So both root causes from doc 08 hit this loop every iteration: SBIW pays dispatch
(49% of instructions), the fan-out pays on 100%. That ranks the work.

---

## Step 1 — inline SBIW into `runFast` (do this first)

The single cheapest high-value patch available. It needs **none** of doc 08's
prerequisites (no event-order refactor, no large helper extraction): SBIW's effect
is a self-contained 16-bit subtract on a register pair, setting S/V/N/Z/C.

- Add an `SBIW` arm to the existing `runFast` ladder
  ([src/cpu/cpu.ts:414](../src/cpu/cpu.ts#L414)), matched by `(opcode & 0xff00) ===
  0x9700`. Decode the register pair exactly as the existing handler does
  ([instructions.ts:229](../src/cpu/instructions.ts#L229)) —
  `24 + ((opcode >> 4) & 0x03) * 2` (the pair selector is bits 5:4, **not** 4:3) —
  and the 6-bit immediate `(opcode & 0xf) | ((opcode >> 2) & 0x30)`, do the
  subtract, set the five flags, advance PC by 1 and cycles by 2.
  - Sanity check against the hot opcode `0x9720`: bits 5:4 = `0b10` → pair index 2
    → **r28:r29 (Y)**, immediate 0. An earlier draft of this plan used
    `(opcode >> 3) & 3`, which wrongly decodes 0x9720 to r24 — copy the handler's
    formula, do not re-derive it.
- Reuse, do not duplicate: if the SBIW flag logic already lives in a helper on
  `InstructionSet`, prefer extracting it (per doc 08's "extract shared helpers"
  note) over copying the flag math. If it is small enough to inline cleanly without
  a second copy of any *shared* logic, that is acceptable for one opcode — but a
  fast-run parity test is mandatory either way.

This fast-paths ~half of every instruction `serial-print` and `analog-write`
execute. It will not close the whole gap (the fan-out still runs — that is Step 3),
but it is a ship-today, prerequisite-free chunk.

### Tests (mandatory — the existing suite does not cover `runFast`)

`runFast` is reached only through `CPU.run()` and most instruction tests drive
`cpu.tick()` directly, so an inlined-opcode bug would pass the current suite. Add a
**fast-run parity test** for SBIW: run identical state through `cpu.tick()` (handler
path) and `cpu.run()` (inline path) and assert identical registers, SREG, PC, and
cycles. **Include the real hot opcode `0x9720` (r28:r29) explicitly** — it is what
serial/analog actually execute, and it is the exact case the bad `>> 3` decode would
have gotten wrong. Also cover the flag edges — borrow/carry, signed overflow, zero
result, the high-byte boundary — not just the happy path, and at least one of the
other three pairs (r24, r26/X, r30/Z) so a wrong pair-index mask cannot pass.

### Done when

- SBIW executes in `runFast` without the megamorphic `handler(...)` call.
- Fast-run parity test proves the inline and the handler produce identical state.
- `serial-print` / `analog-write` improve; full instruction + golden suites green.

---

## Step 2 — numeric kind-cache dispatch (only once the ladder earns it)

Codex's suggestion: replace the growing `if/else` chain in `runFast` with a
`fastKindCache[pc]` (classify each PC's opcode to a small integer once) plus a
compact `switch (kind)`.

This is the right structure **eventually**, but it is premature today. The ladder
currently has a handful of arms; a linear `if/else` over ~5 cheap bit-mask tests is
not the bottleneck. Build the kind-cache when:

- the inline ladder grows past ~6–8 opcodes, **and**
- a profile shows the ladder's own branch sequence (not the work inside each arm) is
  measurable.

Adding the dispatch infrastructure before there are enough ops to amortize it is
the same trap as pre-decoding operands in doc 07's Phase 4 — speculative structure
for marginal benefit.

Sequencing (revised — do not pre-commit to growing the ladder): inline **only SBIW
first** and measure. The current hot loop is *already* a four-arm branch ladder
([cpu.ts:429](../src/cpu/cpu.ts#L429)), and a previous inline-ladder attempt
regressed rather than helped — so adding more arms is not a safe default. If SBIW
alone helps, stop and bank it. Only if you then want more opcodes (the
`delay-blink` mix: ADC/ADD/DEC): add the *next one* and re-measure — **the moment
adding an opcode regresses or flattens the benchmark, switch to the numeric
kind-cache instead of extending the chain further.** Let the measurement, not the
plan, decide ladder-vs-kind-cache.

### Done when

- SBIW is banked on its own first.
- If more opcodes are pursued, the kind-cache replaces the `if/else` chain at the
  first sign the chain itself regresses or stops paying — not on a fixed opcode count.

---

## Step 3 — peripheral migration (the bigger structural win)

This is doc 08's Root Cause 1, unchanged in plan but **reinforced** by the profile:
the busy-wait fixtures prove the fan-out is a pure idle tax — 12 early-returning
`tick(...)` calls per loop iteration that produce nothing. Removing it is worth more
than the SBIW dispatch (it hits 100% of instructions vs SBIW's 49%); it is simply
more expensive and gated by prerequisites, so it comes second.

Follow doc 08 exactly:

1. **Prerequisite first:** the CPU event-order refactor so cycle-exact clock events
   fire per-cycle, before `onCycles` listeners
   ([08-avr8js-parity-plan.md, "Prerequisite"](08-avr8js-parity-plan.md)).
2. Then migrate out of `tickPeripherals` ([src/avr.ts:929](../src/avr.ts#L929)):
   Timer2 → Timer0 → Timer1 → ADC → USART → exti, then delete the `cpu.onCycles`
   registration. Watchdog is already migrated; exti is a half-step.

Constraints, test gates, and the cache/restore rule are all in doc 08 — do not
re-derive them here. The on-read live-`TCNT` hook and the USART level-triggered UDRE
re-arm are the two sharp edges.

### Done when

- Idle peripherals do no per-instruction work between scheduled events.
- `serial-print` / `analog-write` move materially toward avr8js; `delay-blink`
  improves once Timer0 is event-scheduled.
- All doc 08 correctness gates green in both `fast` and `cycle-exact` mode.

---

## Step 4 — generated fast core vs. JIT (only if throughput becomes the product)

Codex's third idea: keep the clean decorated handler table as the source of truth,
but **generate** a speed-first monolithic core from it (the avr8js shape) rather than
hand-writing it. The codegen-from-source-of-truth framing is better than a
hand-written second core — but "cannot drift" is too strong. A generated core *can*
drift: if the generated output is committed and the generator changes underneath it
without regeneration, if the generator mis-models a helper or an edge case, or if
generation is skipped in a build. Generation reduces drift; it does not eliminate it.
So gate it:

- **Pin the generated output:** either commit the generated file and fail CI if a
  fresh regeneration differs (`git diff --exit-code` after running the generator), or
  generate it during the build so a stale checkout cannot ship.
- **Prove equivalence, do not assume it:** run the same parity/golden suites the
  interpreter passes against the generated core, opcode-by-opcode, on every change —
  the generated core is a second implementation and must be tested like one (same
  rule as the `runFast` inlines in Step 1).

One further correction to set expectations honestly:

- A generated **monolithic interpreter** gets you to avr8js **parity** on dispatch.
  It matches avr8js's *approach* (one big switch, no per-handler call frame). It does
  **not** beat avr8js, because it still interprets — one dispatch per *executed*
  instruction.
- To actually **surpass** avr8js you need **translate-once**: a block JIT that
  compiles a basic block of AVR into one JS function via `new Function`, cached by
  block-start PC, so a hot loop pays dispatch *zero* times after the first compile.
  That is the only architecture that does less work per executed instruction than an
  interpreter. (Details and the fidelity tradeoffs — hooks, cycle-exact, breakpoints
  all force a bail to the interpreter — are in the Option B discussion; a JIT is a
  *separate* fast-headless engine that must match the interpreter on the golden
  suite, not a patch to the core.)

Revised recommendation: do **not** start a full generated core yet, but a tiny
proof-backed block specialization is now banked because the profiler found two
stable idle-loop shapes that are both easy to prove and expensive to interpret.

### Step 4a implemented -- guarded idle-loop fast-forward

Implemented in `CPU.runFast`:

- `RJMP -1` self-loop: bulk-advance whole 2-cycle loop iterations.
- `SBIW pair,0; BREQ -2` while the pair is zero: bulk-advance whole 4-cycle loop
  iterations. This is the Arduino busy-wait shape seen in `serial-print` and
  `analog-write`.

The guardrails are the important part. The fast-forward refuses to run when any
observable per-instruction behavior could be skipped:

- timing mode must be `"fast"`;
- no cycle listeners are installed;
- no enabled pending interrupt is waiting;
- the skip stops before the next scheduled CPU clock event;
- parity tests compare the fast-forward path against the handler path, including
  scheduled-event boundaries and cycle-listener opt-out.

Measured result after the event-driven peripheral migration:

```text
short default bench (setup-heavy):
delay-blink           13.5M cycles/s
tight-loop            32.5M cycles/s
serial-print           3.9M cycles/s
serial-print-listener  4.0M cycles/s
analog-write           7.8M cycles/s

steady-state targeted compare:
serial-print, 5M cycles   51.8M/s vs avr8js 64.0M/s  = 0.81x
analog-write, 5M cycles   73.6M/s vs avr8js 77.5M/s  = 0.95x
tight-loop, 100M cycles    1.65B/s vs avr8js 92.5M/s = 17.8x
```

This is **not** a full generated core. It is a narrow block-JIT-style fast-forward
for proven idle loops. The remaining broad solution is unchanged: a generated
monolithic interpreter for general avr8js-style parity, or a real block JIT for
general hot blocks.

### Step 4b implemented -- guarded counted-loop block

The next measured target was `delay-blink`. PC profiling showed a stable loop in
Arduino's delay/millis helper:

```text
ADD rN,rN; ADC rN+1,rN+1; ADC rN+2,rN+2; ADC rN+3,rN+3; DEC rC; BRNE loop
```

Implemented a narrow block in `CPU.runFast` that recognizes this exact 32-bit
left-shift counted loop and executes the whole remaining count in one local loop.
It keeps the same guardrails as Step 4a and adds one more: the counter register
must not overlap the shifted register window. Tests cover handler parity,
mid-block run targets, scheduled event boundaries, cycle-listener opt-out, and
overlapping-counter refusal.

Measured result:

```text
delay-blink, 10M cycles   35.9M/s vs avr8js 48.2M/s = 0.74x
delay-blink, 50M cycles   40.6M/s vs avr8js 49.2M/s = 0.83x
```

This is still a block-specialization layer, not a general generated interpreter.

### Step 4c implemented -- PC-local FastBlock cache/classifier

The hand-proven blocks now go through a tiny PC-local `FastBlock` cache. Candidate
PCs are classified once into a numeric block kind:

- none;
- `RJMP -1`;
- `SBIW pair,0; BREQ -2`;
- 32-bit shift-left counted loop.

This avoids re-reading and re-checking the full shape on every hot-loop iteration,
and gives the next block a single route: add a classifier, add a guarded executor,
then add parity/event/listener tests. The cache is invalidated with the decode
cache so direct flash rewrites cannot keep a stale block classification.

Measured result after this cache layer:

```text
short default bench:
delay-blink           12.9M cycles/s
tight-loop            32.5M cycles/s
serial-print           3.9M cycles/s
serial-print-listener  4.0M cycles/s
analog-write           8.0M cycles/s

steady-state targeted compare:
delay-blink, 50M cycles   42.5M/s vs avr8js 50.5M/s = 0.84x
serial-print, 5M cycles   77.5M/s vs avr8js 76.8M/s = 1.01x
analog-write, 5M cycles   74.5M/s vs avr8js 74.7M/s = 1.00x
```

### Step 4d implemented -- profiled fast path + Arduino `micros()` block

The old opcode profiler used `tick()`, so it intentionally bypassed `runFast()`
and could not show what remained after the FastBlock layer. The profiler now has
a fast-path mode:

```sh
bun run profile:opcodes -- --case delay-blink --cycles 10000000 --mode fast --top 40 --window 8
```

That showed the remaining `delay-blink` cost was the repeated Arduino `micros()`
body at `0x00b8`, called from the delay loop at `0x00ef`. The new FastBlock
specializes exactly that compiled Arduino shape. It still:

- calls `readIo` / `readData` for SREG, `timer0_overflow_count`, TCNT0, and TIFR0;
- reads TCNT0 and TIFR0 at the cycle positions where the real instructions read them;
- refuses to cross scheduled clock events, pending enabled interrupts, cycle
  listeners, and short run targets;
- requires ABI `r1 == 0`, otherwise it falls back to the normal handlers;
- reproduces the three timing branches: 43 cycles, 45 cycles, and 48 cycles.

Measured result:

```text
short default bench:
tight-loop            31.5M cycles/s
delay-blink           17.0M cycles/s
serial-print           3.9M cycles/s
serial-print-listener  4.0M cycles/s
analog-write           7.8M cycles/s

steady-state targeted compare:
delay-blink, 50M cycles   75.4M/s vs avr8js 49.9M/s = 1.51x
serial-print, 5M cycles   74.9M/s vs avr8js 76.2M/s = 0.98x
analog-write, 5M cycles   71.7M/s vs avr8js 76.4M/s = 0.94x
```

This is the first point where the main Arduino delay workload beats avr8js
steady-state. The cost is deliberate specificity: this block is for the compiled
Arduino `micros()` helper, not a general call optimizer.

### Step 5a implemented -- keep hot switches, centralize profile metadata

The first cleanup attempt pushed FastBlock classification and execution through a
definition table. Correctness stayed green, but the hot workloads slowed down:
the extra indirection in `tryRunFastBlock()` was visible exactly where the
specializations matter. That path was rejected.

The kept cleanup is smaller and performance-neutral:

- `runFast()` keeps its numeric hot switches and direct FastBlock dispatch;
- `profileRun()` keeps the profiler-only loop, so normal execution has no
  profiling branch in the hot path;
- FastBlock profile labels are centralized in one `FAST_BLOCK_PROFILE_KINDS`
  table;
- repeated profile emission code is now one `profileFastBlock()` helper;
- the debugger/trace fallback loop is factored into `runTicksUntil()`.

Measured result after restoring the hot switch path:

```text
steady-state targeted compare:
delay-blink, 50M cycles   63.1M/s vs avr8js 40.2M/s = 1.57x
serial-print, 5M cycles   68.9M/s vs avr8js 64.0M/s = 1.08x
analog-write, 5M cycles   70.7M/s vs avr8js 73.6M/s = 0.96x
```

The main rule for future FastBlock cleanup: metadata can be table-driven, but
execution dispatch stays numeric until a generated core can prove equal or
better throughput.

### Step 5b implemented -- make avr8js compare steady-state by default

The old `bench:compare` default cycle budgets were too short for the Arduino
fixtures after FastBlocks landed. Startup and fixture construction dominated the
reported ratios, so the default full compare could still claim serial/analog were
far behind even when targeted steady-state runs were already at parity.

The compare harness now keeps setup inside the timed window, but uses longer
per-workload cycle budgets and defaults to three repeats:

```text
tight-loop      10M cycles
delay-blink     50M cycles
serial-print     5M cycles
analog-write     5M cycles
```

It also prints the cycle budget per row so short custom runs are obvious in the
report.

Fresh default compare after the harness update:

```text
tight-loop, 10M cycles    164.4M/s vs avr8js 92.2M/s = 1.78x
delay-blink, 50M cycles    77.1M/s vs avr8js 51.8M/s = 1.49x
serial-print, 5M cycles    78.6M/s vs avr8js 78.7M/s = 1.00x
analog-write, 5M cycles    78.4M/s vs avr8js 78.1M/s = 1.01x
```

This is measurement cleanup only: no runtime hot path changed.

### Step 5c implemented -- generated-core scaffold

The generated-core work now has a safe first layer:

- `scripts/generate-fast-core.ts` is the source for the generated fast-run body
  and the generated metadata file.
- `src/cpu/generated/fast-core.ts` is committed generated metadata.
- `src/cpu/cpu.ts` has a generated, class-local `runGeneratedFastCore()` method
  between explicit markers.
- `bun run check:fast-core` fails if the committed output is stale.
- `test/generated-fast-core.test.ts` checks freshness and runs the generated path
  against the benchmark fixtures.
- `bun run bench:generated-fast-core` A/Bs the handwritten hot path against the
  generated one.

The first external-function scaffold was correct but not strong enough to replace
the handwritten hot path. Moving the generated body inside the `CPU` class removed
that access shape, so `CPU.run()` now uses `runGeneratedFastCore()` for normal
fast-mode execution. The old handwritten `runFast()` remains as a benchmark and
parity baseline only.

Short default A/B after the swap:

```text
tight-loop, 2M cycles            generated/base = 0.98x
delay-blink, 2M cycles           generated/base = 1.06x
serial-print, 250k cycles        generated/base = 1.05x
serial-print-listener, 250k      generated/base = 1.04x
analog-write, 500k cycles        generated/base = 1.00x
```

Default avr8js compare after the swap:

```text
tight-loop, 10M cycles    163.7M/s vs avr8js 91.9M/s = 1.78x
delay-blink, 50M cycles    77.0M/s vs avr8js 50.4M/s = 1.53x
serial-print, 5M cycles    78.9M/s vs avr8js 77.2M/s = 1.02x
analog-write, 5M cycles    78.5M/s vs avr8js 76.4M/s = 1.03x
```

The next broad step is to expand generation beyond the current hot arms or start
a mini block compiler on top of the FastBlock cache. Every expansion needs the
same freshness check, parity coverage, and A/B gate before it replaces handwritten
logic.

### Step 5d implemented -- generated CALL arm

Fast-mode profiling after the generated-core swap showed `delay-blink` still had
a hot leftover `CALL micros()` instruction outside the Arduino `micros()` body
FastBlock. `CALL` is a narrow two-word control-transfer opcode and the generated
method is class-local, so it can push the return address directly without exposing
new public CPU surface.

Added to the generated arm list:

- `CALL`: push `pc + 2`, decode the absolute target from the second word, jump,
  and bill 4 cycles.

The focused parity test covers PC, cycles, SP, stack bytes, and SREG. Freshness
and fixture-level generated-vs-handwritten parity still gate the generated output.

Measured A/B:

```text
short default A/B, best of 5:
tight-loop, 2M cycles            generated/base = 1.14x
delay-blink, 2M cycles           generated/base = 1.21x
serial-print, 250k cycles        generated/base = 1.05x
serial-print-listener, 250k      generated/base = 0.98x
analog-write, 500k cycles        generated/base = 1.03x

steady listener check:
serial-print-listener, 5M        generated/base = 1.03x

avr8js compare, best of 5:
tight-loop, 10M cycles    168.9M/s vs avr8js 90.7M/s = 1.86x
delay-blink, 50M cycles    93.3M/s vs avr8js 51.3M/s = 1.82x
serial-print, 5M cycles    84.3M/s vs avr8js 67.4M/s = 1.25x
analog-write, 5M cycles    79.1M/s vs avr8js 71.4M/s = 1.11x
```

---

## Recommended order (summary)

1. **Inline SBIW** — cheap, prerequisite-free, ~half of serial/analog's instructions. Ship first.
2. **Event-order refactor → peripheral migration** — the big structural win; the busy-wait profile proves the fan-out is the dominant idle tax.
3. **Kind-cache dispatch** — only once the inline ladder is long enough to justify it.
4. **Generated core / JIT** — only if throughput becomes the product. Generated core = parity; block JIT = beat.

Run before and after every patch:

```sh
bun run scripts/profile-opcodes.ts -- --mode fast --top 8   # re-rank if a fixture changes
bun run check:fast-core                       # generated fast core is fresh
bun run bench:generated-fast-core -- --repeats 3  # generated-vs-handwritten A/B
bun run bench:compare -- --repeats 3          # track the avr8js ratio trend
bun run bench -- --repeats 3                   # regression floors
bun test
bun run typecheck
```
