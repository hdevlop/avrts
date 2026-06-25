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
prototypes were rejected, and `sensor-format` is still below avr8js. The current
arc is landed as logical commits:

- [x] generated fast-core implementation/tests (`__udivmodsi4`,
  `shift-right-dec`, `umulhisi3`, `DEC`, `RET`)
- [x] benchmark/comment/doc consolidation (`performance-plan.md`,
  `benchmark-plan.md`, old `07`-`10` doc replacement)
- [x] benchmark result note and validation evidence
- [x] rejected separate bucketed whole-core generated-dispatch prototype
  (correct but slower; code reverted)

The next implementation step is the **translate-once block JIT** if real compiled
Arduino throughput is still the goal. Do not add more incremental arms or
generated-dispatch variants to the current ladder unless a fresh profile shows a
large, isolated win.

## Open decision

Whether to pursue the JIT depends entirely on whether **"fast on real compiled
Arduino programs"** is an actual product goal. If it is, the next lever is the
translate-once block JIT. If the synthetic-fixture wins are sufficient, the engine
is in a good, well-tested state and this work can be considered complete.
