# avrts Performance & avr8js-Parity Plan (historical)

> **Superseded:** the active roadmap is
> [`real-code-performance-plan.md`](real-code-performance-plan.md). This file is
> retained as historical context for the pre-/monolithic-core performance arc and
> should not be used as the next-step plan.

This was the consolidated performance plan for the earlier arc. It records the
measured results and reasoning from that work, but later isolated benchmarks and
the removed monolithic-core experiment changed the diagnosis. Use the real-code
plan for current priorities, gates, and root-cause framing.

## TL;DR

- **Synthetic fixtures beat avr8js** (local best-of-5, 2026-06-25): tight-loop
  **1.84x**, delay-blink **2.48x**, serial-print **1.01x**, analog-write
  **1.08x**.
- **Real Arduino fixtures still trail avr8js**: sensor-format **0.69x**,
  float-math **0.55x**, bitbang-crc **0.35x**. That is enough for a production
  simulator readiness check, but not a "faster than avr8js" claim.
- The current measured slice is green. The monolithic-core prototype
  (2026-06-29) then **eliminated** indirect handler dispatch and proved — by
  experiment — that the remaining real-code gap is the **linear decode ladder**
  inside overloaded opcode buckets, **not** framework overhead, accessors, or
  handler fallback (all measured, all ruled out). See "Monolithic core: built and
  root-caused" below.

## How the fast path works

- `CPU.run()` executes the **generated fast core** (`runGeneratedFastCore`).
- Two dispatch ladders are **single-sourced** from the `@Op` decorator table by
  [`scripts/generate-fast-core.ts`](../scripts/generate-fast-core.ts):
  `runGeneratedFastCore` (production) and `runFastProfiled` (profiler). Both live
  between `// BEGIN/END GENERATED …` markers in
  [`src/cpu/cpu.ts`](../src/cpu/cpu.ts); `bun run check:fast-core` fails if either
  drifts from the generator. (A third, hand-vs-generated `runFast` A/B twin was
  removed as dead weight once both ladders became generated.)
- **FastBlocks** recognize hot instruction *shapes* and execute them specially —
  either bulk-skipping idle loops or running a whole helper loop in one dispatch.
- The default `AVR(...)` runtime peripherals are **event-scheduled** (CPU
  clock-event queue). The public `CPU.onCycles()` listener API still exists, and
  standalone/legacy users can still install per-instruction listeners; FastBlocks
  decline whenever such listeners are present.

## Implementation checklist

- [x] **Peripheral event migration** — the default runtime path for watchdog, USART,
   Timer0/1/2, ADC, and EXTI moved onto `addClockEvent`/`clearClockEvent`, so the
   normal `AVR(...)` facade no longer pays a per-instruction peripheral fan-out.
   The public `CPU.onCycles()` API remains for compatibility and tests; EXTI keeps
   an opt-in standalone listener bridge.
- [x] **Generated per-opcode arms** — `NOP`, `RJMP`, branch predicates, `SBIW`/`ADIW`,
   the subtract/compare group (`SUB`/`SBC`/`SUBI`/`SBCI`/`CP`/`CPC`/`CPI`), the add
   group (`ADD`/`ADC`), `DEC`, `LDI`/`MOV`/`MOVW`, `PUSH`/`POP`, the `LD`/`ST`
   indirect family (X/Y/Z × none/`+`/`-`), `LPM`, `CALL`, and `RET`. Flag math mirrors the `alu.ts`
   helpers byte-for-byte; memory ops go through `readData`/`writeData` so IO hooks
   are preserved.
- [x] **FastBlocks**
   - Idle bulk-skip: `rjmp-self` (`RJMP -1`), `zero-sbiw-breq` (`SBIW;BREQ` spin).
   - Counted loops: `shift-left-dec`, `shift-right-dec`.
   - `arduino-micros` (the compiled `micros()` body).
   - `subcmp-run` (a straight-line run of subtract/compare ops — the first real
     "several instructions per dispatch" block).
   - avr-libc helper loops: `__udivmodsi4` (divide), `umulhisi3` (multiply).
- [x] **Generator consolidation + cleanup** — both ladders generated from one arm
   list (drift is structurally impossible); the redundant `runFast` twin and its
   `bench:generated-fast-core` benchmark were deleted (~485 lines out of cpu.ts).
- [x] **Real-sketch validation** — the `sensor-format` fixture (PROGMEM table reads,
   `map()`/multiply math, `analogWrite`, `Serial.print` number formatting) wired
   into `bench`, `bench:compare`, and `profile:opcodes`.
- [x] **Expanded real-workload benchmark coverage** — `float-math` and
   `bitbang-crc` were added as committed Arduino fixtures with `.ino`, `.hex`,
   `.lst`, benchmark harness wiring, opcode profiles, and avr8js comparison rows.
- [x] **Initial real-code inline-arm slice** — inline `DEC` and `RET`, add parity
  tests, benchmark serially, and keep only because the full fixture mix stayed
  neutral-or-better.
- [x] **Rejected dispatch-tree prototype** — a high-nibble generated dispatch tree
  was correct, but it increased generated-function size enough to hurt
  `tight-loop`; it was removed instead of kept.
- [x] **Rejected direct handler-table fallback prototype** — exposing the decoder's
  frozen opcode table and skipping the PC-local decode cache was correct, but it
  made the real target worse: `sensor-format` measured **32.8M/s** (`repeats 10`)
  and **31.2M/s** in the full fixture mix (`repeats 5`), below the current
  checked-in baseline. It was removed.
- [x] **Rejected broad inline-arm linear-ladder tranche** — adding correct inline
  bodies for logic/shift, `IN`/`OUT`, `RCALL`/`JMP`, `RETI`/`SEI`/`CLI`,
  `LDS`/`STS`, and `LDD`/`STD` passed focused parity tests, but the larger linear
  ladder did not improve the real target. Best `sensor-format` was **34.4M/s**
  (`repeats 10`) and the full fixture mix measured **30.7M/s** (`repeats 5`) for
  `sensor-format`, so the code was removed.
- [x] **Rejected cold switch-tail prototype** — preserving the existing hot ladder
  and routing the same colder generated bodies through `switch (opcode >>> 12)`
  also passed parity, but still failed the real benchmark gate:
  `sensor-format` measured **34.3M/s** (`repeats 10`) and **30.4M/s** in the full
  fixture mix (`repeats 5`). It was removed.
- [x] **Rejected final tail-inline retry** — after semantic-direct `__udivmodsi4`,
  a smaller tail-only tranche for `AND`/`OR`/`EOR`/`ANDI`/`ORI`/`IN`/`OUT`/`CLI`
  passed typecheck, `check:fast-core`, and focused parity tests. It improved
  isolated `sensor-format --repeats 10` once (`39.5M/s`), but failed the full
  fixture gate twice: `sensor-format` measured **32.9M/s** and **32.8M/s** in the
  full mix (`repeats 5`), below the semantic-direct baseline. It was removed.
- [x] **Commit/checkpoint the current arc** — landed the dirty work as logical
  commits so the measured baseline is stable before opening another performance
  project.
- [x] **Full monolithic generated core prototype** (2026-06-29) — built side by
  side with the current fast core behind `CPU.executionCore = "monolithic"`.
  Every implemented opcode is now inlined; zero hot fallback is measured on all
  fixtures. It **improves** real handler-bound code but does **not** reach avr8js
  parity. Root-caused to decode-ladder depth (see below). Execution checklist:
  [`monolithic-generated-core-plan.md`](monolithic-generated-core-plan.md).
- [ ] **Later: translate-once block JIT** — only if the product goal is to beat
  avr8js on real compiled Arduino programs, not merely match it.
- [ ] **Later: external references and fidelity checks** — simavr-WASM speed
  ceiling, simavr-native accuracy oracle, and final-state fidelity checks live in
  [`benchmark-plan.md`](benchmark-plan.md).

## Measured results

```text
bench:compare, local best of 5 on 2026-06-25 (16 MHz):
tight-loop      1.84x   (synthetic: RJMP idle bulk-skip)
delay-blink     2.48x   (micros block + subcmp block)
serial-print    1.01x   (SBIW busy-wait bulk-skip)
analog-write    1.08x   (SBIW busy-wait bulk-skip + inline ISR)
sensor-format   0.69x   (REAL sketch: helper loops + Print/Serial)
float-math      0.55x   (REAL sketch: soft-float helper loops)
bitbang-crc     0.35x   (REAL sketch: port bit-banging + CRC loops)
```

Implementation note: a high-nibble dispatch-tree prototype was tested first and
rejected because the larger generated function added enough startup/JIT cost to
hurt `tight-loop`. The kept implementation slice is narrower: inline `DEC` and
`RET`, with parity tests and neutral-or-better serial `bench:compare` results.

## The honest conclusion

avrts **wins on synthetic/idle-dominated code** because FastBlocks *bulk-skip* the
busy-wait/delay loops (jump thousands of iterations in one step) where avr8js
simulates each one. Remove that — as real code does — and it becomes a pure
**per-instruction dispatch race**, which avrts currently **loses**. The four
synthetic fixtures flattered the engine; `sensor-format` is the one that tells the
truth.

## Root cause of the remaining gap

On real code there is no idle loop to skip, so what matters is the cost of
dispatching one instruction:

- **avr8js** is one monolithic `avrInstruction()` function — a **decode tree** on
  the opcode bits with **every** opcode handled inline. No per-instruction
  function call; any opcode is reached in a few branches. V8 optimizes the whole
  thing as one hot function.
- **avrts** generates inline arms for the **hot subset** only and walks a **linear
  `else if` ladder** to find them. The newest slice removed `RET` from the fallback,
  but many real-code opcodes still fall to `handler(this, opcode)` — for example
  logic ops, `LDD`/`STD`, `IN`/`OUT`, `JMP`, `RCALL`, and less common multiply
  variants outside the guarded helper blocks. That fallback is an indirect call
  through the per-PC table that V8 **cannot inline** (megamorphic) — the slowest
  dispatch shape. The per-shape FastBlocks (`__udivmodsi4`, `umulhisi3`, …) claw
  some of it back, but real code has endless shapes; you can't block them all.

## Monolithic core: built and root-caused (2026-06-29)

The monolithic generated core (the prototype proposed above) was built end to end
behind `CPU.executionCore = "monolithic"`: a `switch(opcode >>> 12)` decode tree
that inlines **every** implemented opcode (arithmetic/flag, logic/shift, skip,
memory direct/indirect/displacement, IO, stack/call/return, control/status,
multiply, and system) from avrts's own `@Op` semantics. Fallback is instrumented
with a `monolithicFallbacks` counter and **measured to be zero** on every fixture;
the only remaining fallback is the explicitly-unsupported opcode set
(`SPM`/`ELPM`/`EICALL`/...). Full checklist + per-slice evidence:
[`monolithic-generated-core-plan.md`](monolithic-generated-core-plan.md).

### Benchmark gate (`bench:compare -- --repeats 5`, best-of-5, avrts/avr8js ratio)

| workload       | fast | monolithic | note |
| -------------- | ---- | ---------- | ---- |
| tight-loop     | 1.87x | 1.97x | synthetic win preserved |
| delay-blink    | 2.30x | 2.16x | still ≫1.0x |
| serial-print   | 1.20x | 1.19x | flat |
| analog-write   | 1.11x | 1.16x | flat |
| peripheral-mix | 1.43x | 1.43x | flat |
| sensor-format  | 0.71x | 0.73x | + |
| float-math     | 0.49x | 0.53x | + |
| bitbang-crc    | 0.35x | 0.37x | + |
| isr-heavy      | 0.23x | **0.37x** | **+56%** |
| string-heavy   | 0.20x | **0.25x** | **+24%** |
| dsp-fixed      | 0.20x | **0.25x** | **+27%** |

Correctness held throughout: `bench:result --core monolithic` matches avr8js on
all four result fixtures; `bun test` stays green (per-opcode parity in
`test/phase4.test.ts`, zero-fallback guard in `test/generated-fast-core.test.ts`
and `test/phase5.test.ts`).

**Verdict:** the monolithic core removed the cost it was designed to remove
(indirect dispatch) and clearly helps real handler-bound code, but the heaviest
real fixtures stay at ~0.25x. It does **not** reach the ~1.0x parity this plan
predicted, so it stays **experimental/opt-in**, not default.

### Why it still loses — measured, not assumed

A sequence of controlled experiments on `dsp-fixed`/`string-heavy` isolated the
remaining cost. Each was applied to the monolithic core and reverted:

| experiment | change | effect | conclusion |
| ---------- | ------ | ------ | ---------- |
| E1 | skip `notifyCycles` per instruction | none | not the cost |
| E2 | strip `serviceInterrupts` + per-iteration debug guard | none | not the cost |
| E3 | inline stack ops (drop `SP` accessor) | ~noise | marginal |
| E4a | arms use `_cycles` (accessor gone), clock events skipped | +55% | **artifact** — broke peripheral updates; poll loop spun on cheaper instrs |
| E4b | same, but clock events preserved (avr8js-style accounting) | neutral | the `cycles` accessor is **not** the cost |
| E5 | hoist `LDS` to the front of the bucket-9 ladder | **~10%** | **largest single real lever found** |

The decisive finding is **E5 / decode-ladder depth**. The monolithic core decodes
with `switch(opcode >>> 12)` then a **linear `if/else if` chain** inside each
case. Bucket `0x9` is pathologically overloaded (~45 opcodes), and `LDS` — the #1
opcode in `dsp-fixed` at **18% of cycles** — sits **26th** in that chain, so every
execution walks ~25 mask-compares first. Hoisting just that one opcode bought
~10%. The losing fixtures (dsp/string/isr) are precisely the ones dense in
bucket-9/bucket-8 memory and stack opcodes (`LDS`/`LD`/`ST`/`STS`/`LDD`/`STD`/
`CALL`/`RET`) buried deep in the longest ladder.

avr8js avoids this by decoding more directly (sub-switches on lower opcode bits →
near-O(1) to the body) instead of a long linear scan. **The gap is decode
*structure*, not dispatch, not the cycle/interrupt framework, and not accessors.**
That reframes the remaining work: it is a denser-decode problem, addressed by the
new phases below.

## Forward path (ranked)

- [x] **Generate the full monolithic core** (2026-06-29) — done. All implemented
   opcodes are inlined in one `switch(opcode >>> 12)` function; the megamorphic
   `handler(...)` fallback is gone (measured zero on every fixture). Generated
   from avrts's **own** `@Op` semantics, not copied from avr8js. **Outcome did not
   match the ~1.0x prediction:** it improves real code but the heaviest fixtures
   stay ~0.25x. Root cause was *not* dispatch (removed) but the linear decode
   ladder — see "Monolithic core: built and root-caused" above. This makes the
   denser-decode phase below the next real lever.
- [ ] **Phase 8 — denser secondary decode → reclaim the decode-ladder cost.**
   Replace the linear per-bucket `if/else if` chain with a **second-level decode**
   for the overloaded buckets (start with `0x9`, then `0x8`), the way avr8js does:
   switch on more opcode bits (e.g. low nibble / `(opcode >> 8) & 0xf`) so a hot
   opcode like `LDS` is reached in O(1) instead of ~25 mask-compares. This is a
   single change in [`scripts/generate-fast-core.ts`](../scripts/generate-fast-core.ts)
   (emit a sub-switch for buckets above an arm-count threshold), re-run through the
   existing parity / `check:fast-core` / zero-fallback / `bench:result` /
   `bench:compare -- --repeats 5` gates. Because every bucket-9/bucket-8 memory and
   stack op benefits at once, expect it to move dsp/string/isr together rather than
   ~10% one opcode at a time. Keep only if the real fixtures improve and the
   FastBlock-heavy synthetic wins (`tight-loop`, `delay-blink`) do not regress.
   - First measurement to confirm the lever: hoisting `LDS` alone bought ~10% on
     `dsp-fixed` (E5); a full sub-switch should compound that across the bucket.
   - Ordering fallback: if a full sub-switch is too invasive for the generator,
     an interim step is to **order each bucket's arms by measured hotness** (hot
     opcodes first) from `profile:opcodes`, capturing most of the win with less
     structural change.
- [ ] **Phase 9 — promotion decision.** If Phase 8 brings real-code ratios
   meaningfully up without regressing the synthetic wins, promote the monolithic
   core from experimental to opt-in public beta, then consider default. If it only
   helps some fixtures, keep it experimental. If it ever loses like the earlier
   bucketed/linear variants, revert and keep the current fast core. (Detail in
   [`monolithic-generated-core-plan.md`](monolithic-generated-core-plan.md) Phase 7.)
- [ ] **(superseded) MATCH avr8js via the monolithic core alone.** The original
   expectation was that one inlined decode function would reach ~1.0x on real code.
   Measurement disproved it: dispatch was not the dominant cost. Parity now depends
   on Phase 8 (decode structure) and, beyond that, the translate-once JIT below.
   - Already rejected: direct-handler-table fallback, more inline bodies in the
     existing linear ladder, and a cold high-nibble switch tail.
   - [x] Rejected separate bucketed whole-core generated-dispatch prototype
     behind a gate (June 25, 2026): it passed freshness, typecheck, and fixture
     parity, but lost the benchmark gate. `sensor-format --repeats 10` fell from
     `34,142,651/s` (ladder) to `32,313,915/s` (bucketed). Full mix
     `--repeats 5` also regressed most cases: `tight-loop` `172,817,232/s` ->
     `122,198,299/s`, `delay-blink` `118,989,852/s` -> `101,404,411/s`,
     `analog-write` `76,402,015/s` -> `64,651,522/s`, and `sensor-format`
     `29,147,585/s` -> `27,868,241/s`; only `serial-print` improved
     (`74,324,244/s` -> `83,442,643/s`). Code reverted; result recorded here.
   - No incremental generated-dispatch variant remains recommended. A true
     all-opcode semantic generator would be a larger rewrite, not the next
     narrow slice. Use
     [`monolithic-generated-core-plan.md`](monolithic-generated-core-plan.md) for
     the side-by-side prototype checklist.
- [ ] **Translate-once block JIT → BEAT avr8js on real code.** Compile hot basic
   blocks (branches included) into one JS function via `new Function`, cached by
   block-start PC, so a hot region pays dispatch *zero* times after the first
   compile. This is the only architecture that does less work per executed
   instruction than an interpreter. Large, separate project; hooks / cycle-exact /
   breakpoints all force a bail to the interpreter, so the JIT must match the
   interpreter on the golden suite.
   - [x] Rejected first JIT slice: **direct-handler translated blocks** (June 25,
     2026). The prototype cached a `new Function` per block-start PC and emitted
     literal calls to the existing tested handlers for safe straight-line
     register/stack/arithmetic blocks. It passed `check:fast-core`, typecheck,
     and fixture parity, but it was much slower because it kept per-instruction
     handler calls and disrupted the current fast-block wins. `sensor-format
     --repeats 10` fell from `34,934,937/s` (JIT off) to `20,455,235/s`
     (direct-handler blocks). Full mix `--repeats 5` regressed every case:
     `tight-loop` `177,773,669/s` -> `46,547,740/s`, `delay-blink`
     `120,470,548/s` -> `31,635,244/s`, `serial-print` `77,887,807/s` ->
     `32,286,414/s`, `analog-write` `81,149,071/s` -> `34,167,172/s`, and
     `sensor-format` `30,087,766/s` -> `18,758,045/s`. Code reverted.
   - Next JIT attempt, if any, must inline opcode semantics into the generated
     block body and preserve existing FastBlocks; translating to handler calls is
     not a viable stepping stone.
   - [x] Rejected second JIT slice: **inline-semantics translated straight-line
     blocks** (June 25, 2026). This prototype did inline register/flag semantics
     directly into cached `new Function` blocks, preserved existing FastBlocks,
     and refused to cross events/listeners/interrupts. It first exposed a
     correctness edge around word arithmetic feeding `ADC`; after tightening the
     candidate set (no `PUSH`/`POP`, no `ADIW`/`SBIW`, min block length 8), it
     passed typecheck and fixture parity. It still lost the benchmark gate:
     `sensor-format --repeats 10` was `32,257,315/s` with JIT off vs
     `30,270,742/s` with inline semantics. Full mix `--repeats 5` also failed to
     justify keeping it: `tight-loop` `162,115,017/s` -> `159,573,619/s`,
     `delay-blink` `116,826,743/s` -> `104,566,087/s`, `serial-print`
     `72,509,691/s` -> `72,854,649/s`, `analog-write` `65,779,693/s` ->
     `72,715,850/s`, and `sensor-format` `27,773,951/s` -> `27,498,258/s`.
     Code reverted.
   - No narrow translated-block prototype remains recommended. A future JIT
     would need a real compiler pass: profile hot branch-shaped regions, generate
     semantics from a single instruction-description source, and prove it keeps
     FastBlocks or replaces them with equivalent loop compilation.
   - [x] **JIT compiler design pass** (June 25, 2026). Fresh profile evidence
     says the next useful JIT cannot be a straight-line-block wrapper:
     `sensor-format --mode pc` is dominated by branch-shaped helper loops around
     `__udivmodsi4`, especially `0x052d:BRNE` (160,479 hits, 316,175 cycles),
     `0x0523:BRCS` (155,616 hits, 288,270 cycles), and the loop body at
     `0x051b..0x052d` (`ADC/CPC/BRCS/SUB/SBC/ADC/DEC/BRNE`). Opcode totals agree:
     `BRNE`, `BRCS`, `ADC`, `CPC`, `CP`, and `DEC` dominate the sample. The
     compiler therefore has to compile **hot branch-shaped regions**, not just
     fall-through runs.
   - **Required design before implementation:**
     1. Hot-region selector: use `profileRun()`/PC counts to find loop headers
        and back-edges (`BRNE`, `BRCS`, `RJMP`) above a threshold; seed with the
        known `__udivmodsi4` loop region (`0x051b..0x052d` in `sensor-format`) so
        the first compiler target is the current bottleneck.
     2. Region IR: represent a small control-flow graph of basic blocks with
        explicit exits, cycle costs, branch conditions, and touched registers.
        Stop at memory/IO/call/ret unless the instruction semantics are already
        single-sourced and parity-tested.
     3. Single-source semantics: do not hand-copy flag math into ad hoc
        `new Function` strings again. Create instruction-description emitters
        that can generate both the current fast-core arms and JIT IR/JS for
        shared opcodes (`ADC`, `CP`, `CPC`, `SUB`, `SBC`, `DEC`, branches).
     4. FastBlock equivalence: either keep current FastBlocks ahead of the JIT
        or make the compiler generate equivalent loop code with the same
        `canRunFastBlock()` guards. No JIT path may regress `tight-loop`,
        `delay-blink`, or the helper-loop FastBlocks.
     5. Guard/bailout contract: compile only in fast timing, with no cycle
        listeners, no active trace/breakpoint/unknown-opcode pause, no enabled
        pending interrupt, and no scheduled clock event inside the region's
        worst-case cycle window. Bail to `runGeneratedFastCore()` otherwise.
     6. Validation gate: first target is a generated `__udivmodsi4` CFG compiler
        behind an opt-in flag. It must pass fixture parity vs `tick()`,
        `check:fast-core`, typecheck, and a full `bench:compare -- --repeats 5`.
        Keep it only if `sensor-format` improves and the full mix is
        neutral-or-better.
   - [x] **Instruction-description emitter extraction** (June 25, 2026).
     `scripts/generate-fast-core.ts` now owns the `__udivmodsi4` CFG region via a
     small two-block descriptor (`ep` + `body`) and instruction emitters for
     `ADC self`, `CP`/`CPC`, `SUB`/`SBC`, `DEC`, and `BRCS`. The generated CPU
     region is guarded by `bun run check:fast-core`, just like the fast-core
     ladders.
   - [x] **Implemented first CFG region slice: `__udivmodsi4` generated-CFG mode**
     (June 25, 2026). Added a selectable `CPU.udivmodsi4RegionMode` with the
     generated-CFG path as the default and the old handwritten FastBlock kept as
     an A/B fallback. The CFG path preserves the existing `canRunFastBlock()`
     guard contract, passes the same handler-parity and clock-event refusal tests
     as the handwritten block, and can still be benchmarked with
     `--udivmodsi4-region handwritten|generated-cfg`.
   - Validation: `bun run typecheck`, `bun run check:fast-core`, and
     `bun test test/cpu.test.ts test/generated-fast-core.test.ts` all passed.
   - Benchmark result: `sensor-format --repeats 10` improved from
     `34,088,252/s` (handwritten) to `36,378,399/s` (generated-CFG). Full mix
     `--repeats 5` also improved the important real-code fixture:
     handwritten `sensor-format` `29,523,764/s` vs generated-CFG
     `32,472,340/s`. Final no-flag/default full mix with generated-CFG:
     `tight-loop` `172,091,863/s` (`1.88x` avr8js), `delay-blink`
     `118,675,881/s` (`2.30x`), `serial-print` `80,583,684/s` (`1.21x`),
     `analog-write` `81,597,083/s` (`1.14x`), `sensor-format`
     `32,171,389/s` (`0.66x`).
   - Post-extraction validation: `bun run typecheck`, `bun run check:fast-core`,
     and `bun test test/cpu.test.ts test/generated-fast-core.test.ts` all passed.
     Full default benchmark after the emitter move (`bench:compare -- --repeats
     5`): `tight-loop` `173,323,142/s` (`1.97x` avr8js), `delay-blink`
     `119,660,967/s` (`2.34x`), `serial-print` `75,695,414/s` (`1.12x`),
     `analog-write` `76,598,535/s` (`1.08x`), `sensor-format` `31,471,599/s`
     (`0.65x`).
   - [x] **Semantic-direct `__udivmodsi4` prototype promoted to default** (June
     25, 2026). The exact avr-libc entry state (`counter=33`, cleared
     remainder, carry clear, nonzero divisor) now computes quotient/remainder
     directly, writes the same pre-epilogue complemented quotient and remainder
     registers, preserves final SREG semantics, and falls back to generated-CFG
     for noncanonical synthetic states. A/B remains available with
     `--udivmodsi4-region handwritten|generated-cfg|semantic-direct`.
   - Semantic-direct validation: `bun run typecheck`, `bun run check:fast-core`,
     and `bun test test/cpu.test.ts test/generated-fast-core.test.ts` all passed.
     Focused `sensor-format --repeats 10`: generated-CFG `33,142,345/s` vs
     semantic-direct `36,330,318/s`. Full mix `--repeats 5`: generated-CFG
     `sensor-format` `31,503,366/s` vs semantic-direct `33,852,885/s`; full
     semantic-direct mix was `tight-loop` `169,620,034/s` (`1.83x` avr8js),
     `delay-blink` `115,827,504/s` (`2.22x`), `serial-print` `80,973,365/s`
     (`1.19x`), `analog-write` `78,994,682/s` (`1.10x`), `sensor-format`
     `33,852,885/s` (`0.69x`). Final no-flag/default full mix:
     `tight-loop` `174,185,985/s` (`1.94x` avr8js), `delay-blink`
     `116,175,673/s` (`2.25x`), `serial-print` `79,612,637/s` (`1.17x`),
     `analog-write` `79,771,789/s` (`1.12x`), `sensor-format`
     `33,858,593/s` (`0.70x`).
   - Next implementation slice: profile the semantic-direct baseline and only
     pursue another helper/block if it is still isolated and large enough to move
     `sensor-format` or another real compiled fixture.
- [ ] **More real fixtures + external references (only to scope product claims).** An
   I2C/SPI driver or a string-heavy sketch would broaden confidence, but
   `sensor-format` already answered the key question: the synthetic wins do not
   generalize. The concrete workload-fixture and external-simulator (avr8js,
   simavr-WASM ceiling, simavr-native oracle) benchmarking plan lives in
   [`benchmark-plan.md`](benchmark-plan.md).

## Working rules (keep following these)

- **Single source.** Add/Change dispatch only in
  [`scripts/generate-fast-core.ts`](../scripts/generate-fast-core.ts); run
  `bun run generate:fast-core`; `bun run check:fast-core` gates freshness in CI.
- **Mirror the handlers exactly.** Decode masks and flag math must copy the `@Op`
  handler / `alu.ts` helper — never re-derive (a wrong mask shipped once before).
- **Every arm needs handler parity tests** (`run()` fast path vs `tick()` handler
  path), covering flag edges. Memory arms additionally verify touched registers,
  memory, `SP`, `SREG`, `PC`, cycles — and an IO-write goes through `writeData`.
- **Every FastBlock needs guard tests.** A block may run only in fast mode, with no
  cycle listeners, no enabled pending interrupt, and must **stop before the next
  scheduled clock event / the run target** — otherwise it declines and the
  per-instruction path takes over. Test the decline paths, not just the happy path.
- **Profile first, measure after.** Start every slice from
  `bun run profile:opcodes -- --mode fast`; keep a patch only if `bench:compare`
  is neutral-or-better on the full fixture mix (watch for machine-load noise — use
  `--repeats 5`).

## Validation gates

```sh
bun run generate:fast-core      # regenerate the ladders
bun run check:fast-core         # generated output is fresh
bun run typecheck
bun test
bun run bench:compare -- --repeats 5   # avr8js ratio (the real perf gate)
bun run bench -- --repeats 3           # regression floors
bun run build:demo && bun run test:e2e # browser/demo release gate
```

## Recommended next step

**Checkpoint complete.** The code and docs now describe a measured, green
baseline: `DEC`/`RET` were kept, the dispatch-tree, direct-handler-table, broad
inline-linear-ladder, cold switch-tail, and bucketed whole-core generated-dispatch
prototypes were rejected, direct-handler and inline-semantics block-JIT slices
were rejected, and `sensor-format` is still below avr8js. The current arc is
landed as logical commits:

- [x] generated fast-core implementation/tests (`__udivmodsi4`,
  `shift-right-dec`, `umulhisi3`, `DEC`, `RET`)
- [x] benchmark/comment/doc consolidation (`performance-plan.md`,
  `benchmark-plan.md`, old `07`-`10` doc replacement)
- [x] benchmark result note and validation evidence
- [x] rejected separate bucketed whole-core generated-dispatch prototype
  (correct but slower; code reverted)
- [x] rejected direct-handler translated-block JIT prototype
  (correct but much slower; code reverted)
- [x] rejected inline-semantics translated-block JIT prototype
  (correct after tightening, but still slower/mixed; code reverted)
- [x] completed JIT compiler design pass from fresh `sensor-format` profiles
  (next code slice is a generated `__udivmodsi4` CFG compiler)
- [x] implemented generated-CFG `__udivmodsi4` region as the default path
  (handwritten block remains selectable for A/B benchmarks)
- [x] extracted the `__udivmodsi4` CFG path into a generated CPU region backed
  by a small instruction-description emitter
- [x] promoted semantic-direct `__udivmodsi4` as the default after A/B
  benchmarks showed the best real-fixture win

The next implementation step is now identified by fresh measurement. The
monolithic-core arc (2026-06-29) added:

- [x] full monolithic generated core behind `CPU.executionCore = "monolithic"`,
  inlining every implemented opcode (Phases 4–6 of the side-by-side plan)
- [x] zero-hot-fallback instrumentation + parity guards
  (`monolithicFallbacks`, `test/phase4.test.ts`, `test/phase5.test.ts`)
- [x] three-way benchmark gate (fast vs monolithic vs avr8js) recorded above
- [x] root-cause experiments E1–E5 isolating decode-ladder depth as the dominant
  remaining real-code cost

Per this plan's own "large, isolated win" rule, that fresh evidence **justifies**
the next slice: **Phase 8 — denser secondary decode** (sub-switch the overloaded
`0x9`/`0x8` buckets). It is a single generator change gated by the existing
parity/freshness/zero-fallback/benchmark checks, and it targets exactly the cost
the experiments measured. Do **not** add more incremental linear arms or generic
translated-block layers; the lever is decode *structure*, not more inline bodies.

## Open decision

Whether to pursue a full JIT compiler depends entirely on whether **"fast on real
compiled Arduino programs"** is an actual product goal. If it is, the next lever
is a designed JIT compiler pass, not another local prototype. If the
synthetic-fixture wins are sufficient, the engine is in a good, well-tested state
and this work can be considered complete.
