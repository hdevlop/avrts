# avrts Performance & avr8js-Parity Plan (final)

This is the single, consolidated performance plan. It replaces the earlier
iterative drafts (the old `07`–`10` docs) and records the **end state**, the
measured results, the honest conclusion, and the forward path — not the
step-by-step history of how we got here.

## TL;DR

- **Synthetic fixtures beat avr8js** (local best-of-5, 2026-06-24, after the
  initial `DEC`/`RET` inline-arm slice): tight-loop **1.96x**, delay-blink **2.32x**,
  serial-print **1.01x**,
  analog-write **1.12x**.
- **A real Arduino sketch (`sensor-format`) is still ~0.66x avr8js** — i.e.
  avrts is *slower* on real, helper-heavy code.
- The current measured slice is green. The remaining gap is **architectural**
  (instruction dispatch), not one more small helper block.

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
- [x] **Commit/checkpoint the current arc** — landed the dirty work as logical
  commits so the measured baseline is stable before opening another performance
  project.
- [ ] **Next real performance project: full monolithic generated core prototype**
  — generate a decode-tree/inlined-core prototype for all opcodes, starting behind
  measurement gates.
- [ ] **Later: translate-once block JIT** — only if the product goal is to beat
  avr8js on real compiled Arduino programs, not merely match it.
- [ ] **Later: more real fixtures and external references** — `float-math`,
  `bitbang-crc`, simavr-WASM speed ceiling, simavr-native accuracy oracle, and
  final-state fidelity checks live in [`benchmark-plan.md`](benchmark-plan.md).

## Measured results

```text
bench:compare, local best of 5 on 2026-06-24 after DEC/RET slice (16 MHz):
tight-loop      1.96x   (synthetic: RJMP idle bulk-skip)
delay-blink     2.32x   (micros block + subcmp block)
serial-print    1.01x   (SBIW busy-wait bulk-skip)
analog-write    1.12x   (SBIW busy-wait bulk-skip + inline ISR)
sensor-format   0.66x   (REAL sketch: helper loops + Print/Serial)
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

## Forward path (ranked)

- [ ] **Generate the full monolithic core → MATCH avr8js on real code.** Cover *all*
   ~130 opcodes in one generated decode-tree function so the megamorphic
   `handler(...)` fallback disappears and the linear ladder becomes a tree. Take
   the *structure* (decode tree, one inlined function) as **inspiration from
   avr8js (MIT)** but generate it from avrts's **own** tested `@Op` handlers — do
   not copy avr8js code (you'd re-derive logic you already have and adapt it to a
   different object model). Expectation: this **matches** avr8js (~1.0x on real
   code); it does not beat it, because it still dispatches once per instruction.
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
     narrow slice.
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
   - Next implementation slice: profile again, then use the CFG emitter for the
     next isolated helper-loop region only if the profile shows one with enough
     weight to matter on `sensor-format` or another real compiled fixture.
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

The next implementation step is **not another narrow dispatch/JIT micro-prototype**.
If real compiled Arduino throughput is still the goal, profile the current
generated-CFG baseline and use the emitter for the next isolated helper-loop
region only if it is large enough to move a real fixture. Do not add more
incremental arms, generated-dispatch variants, or generic translated-block
layers unless a fresh profile shows a large, isolated win.

## Open decision

Whether to pursue a full JIT compiler depends entirely on whether **"fast on real
compiled Arduino programs"** is an actual product goal. If it is, the next lever
is a designed JIT compiler pass, not another local prototype. If the
synthetic-fixture wins are sufficient, the engine is in a good, well-tested state
and this work can be considered complete.
