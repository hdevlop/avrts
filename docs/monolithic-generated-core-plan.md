# Monolithic Generated Core Side-by-Side Plan

This is the implementation plan for building a full generated opcode core
without replacing the current fast core until it proves itself.

## OUTCOME (2026-06-30): experiment concluded, monolithic core removed

The prototype was built end to end, proved correct, benchmarked, and then
**removed** — it answered its question with a no. Measured production-representatively
(one firmware per process, `bench:compare --isolate`), the monolithic core showed
**no advantage over the fast core** (dsp 0.61x vs 0.62x, string 0.55x vs 0.57x, isr
0.63x vs 0.64x). Its founding premise — that real code lost to avr8js because of
handler-fallback dispatch — was disproven: eliminating fallback changed nothing.
The earlier "clear win on handler-bound code" was a benchmark co-tenancy artifact
(co-running 11 firmwares megamorphically deoptimizes the fast core more than the
monolithic core; production runs one firmware at a time). The real ~1.5x real-code
gap is clock-event + IO-hook dispatch, shared by both cores and unrelated to decode.

What was kept: the `--isolate` benchmark mode (production-representative
measurement) and the single-source generator for the fast + profiled ladders. What
was removed: `runGeneratedMonolithicCore`, `CPU.executionCore`/`--core`,
`monolithicFallbacks`, the bucket/hotness maps, and `test/phase4`/`phase5`. The rest
of this document is retained as the experiment's record and reasoning.

## Decision

- [x] Keep the current generated fast core as the stable/default execution path.
- [x] Treat the monolithic generated core as a parallel prototype, not a direct
  replacement.
- [x] Continue using avr8js as the fair JS-vs-JS speed comparison.
- [x] Continue using result benchmarks as correctness guards, not only speed
  numbers.
- [ ] Promote the monolithic core only after it passes correctness, fidelity, and
  real-workload benchmark gates.

## Why This Exists

The current engine is production-safe and well tested, but real compiled Arduino
programs still lose to avr8js because many opcodes fall back to indirect
`handler(this, opcode)` calls. avr8js gets an advantage from one monolithic
decode function where opcode behavior is inline and V8 can optimize the whole
hot function.

The goal is not to copy avr8js code. The goal is to generate an avrts-native
decode tree from avrts opcode knowledge and tested semantics.

## Current Baseline

- [x] `CPU.run()` uses the current generated fast core.
- [x] The current generated fast core remains the default product path.
- [x] Synthetic / busy-wait-heavy fixtures are already strong.
- [x] Real-code fixtures exist and expose the remaining dispatch gap:
  `sensor-format`, `float-math`, `bitbang-crc`, `peripheral-mix`,
  `isr-heavy`, `string-heavy`, and `dsp-fixed`.
- [x] Result comparisons exist for real mixed peripheral and real-code
  workloads.
- [x] A side-by-side experimental selector exists.
- [ ] A full all-opcode monolithic generated core does not exist yet.

## Non-Goals

- [ ] Do not replace the current fast core during the prototype phase.
- [ ] Do not remove FastBlocks unless the monolithic path clearly replaces their
  wins.
- [ ] Do not copy avr8js opcode implementation bodies.
- [ ] Do not start a translate-once JIT in this phase.
- [ ] Do not claim "faster than avr8js" unless real fixtures prove it.

## Target Shape

- [x] Add a separate generated execution method, tentatively
  `runGeneratedMonolithicCore`.
- [x] Put generated code between explicit BEGIN/END markers in `src/cpu/cpu.ts`
  or in a dedicated generated module if function size makes that cleaner.
- [x] Select the path through an experimental flag or internal option.
- [x] Keep the default path on the current generated fast core.
- [x] Generate a decode-tree skeleton over opcode bits instead of a long linear
  ladder.
- [x] Inline semantics for all supported AVR opcodes.
- [x] Preserve exact PC, cycles, SREG flags, stack, memory, and IO hook behavior
  for the first proven inline tranche.
- [x] Keep existing event scheduling and interrupt behavior unchanged for the
  first proven inline tranche.

## Implementation Phases

### Phase 0 - Baseline Lock

- [ ] Record a fresh baseline before touching the execution engine:
  `bun test`, `bun run typecheck`, `bun run check:fast-core`,
  `bun run bench:compare -- --repeats 5`, and `bun run bench:result`.
- [ ] Record the current ratios in this document.
- [ ] Confirm the working tree is clean or checkpointed.

### Phase 1 - Side-by-Side Harness

- [x] Add an experimental monolithic-core mode behind a flag.
- [x] Add benchmark selection so the same fixture can run with:
  current avrts core, monolithic avrts core, and avr8js.
- [x] Add result-benchmark selection so the same fidelity oracle can run against
  the current or monolithic avrts core.
- [x] Add tests that prove the flag does not change the default path.
- [x] Add freshness checks so generated monolithic code cannot drift from its
  generator.

Exit gate:

- [x] Default focused generated-core tests and `bun run typecheck` remain green.
- [x] Default `bun test`, `bun run typecheck`, and `bun run check:fast-core`
  remain green.
- [x] Existing benchmark commands still use the current stable core unless the
  experimental mode is explicitly selected.

Evidence:

- `bun test test/generated-fast-core.test.ts test/benchmark-results.test.ts`:
  51 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun test`: 457 pass, 0 fail.
- `bun run check:fast-core`: pass.
- `bun run bench -- --case tight-loop --cycles 100000 --repeats 1 --core
  monolithic`: experimental benchmark selector works.
- `bun run bench:compare -- --case tight-loop --cycles 100000 --repeats 1
  --core monolithic`: experimental comparison selector works.
- `bun run bench:result -- --case dsp-fixed --analog 512 --d2 high --core
  monolithic`: pass.

### Phase 2 - Decode-Tree Skeleton

- [x] Generate the opcode decode tree structure.
- [x] Allow temporary fallback to existing handlers only for bring-up.
- [x] Measure tree overhead early before investing in every opcode body.
- [ ] Reject the shape immediately if the empty/tree skeleton has unacceptable
  startup or hot-loop overhead.

Exit gate:

- [x] Skeleton passes parity on existing fixtures.
- [x] Skeleton overhead is measured and recorded.
- [x] No performance claim is made while fallback handlers remain in the hot path.

Evidence:

- Generated region: `// BEGIN GENERATED MONOLITHIC CORE` now lives in
  `src/cpu/cpu.ts` and is checked by `bun run check:fast-core`.
- The skeleton dispatches on `opcode >>> 12`, then falls back to the existing
  tested handler path. No opcode semantics are inlined yet.
- `bun test test/generated-fast-core.test.ts test/benchmark-results.test.ts`:
  51 pass, 0 fail.
- `bun run bench:result -- --case dsp-fixed --analog 512 --d2 high --core
  monolithic`: pass.
- Serial overhead sample, `--cycles 1000000 --repeats 5`:
  - `tight-loop`: fast `16,279,518/s`, monolithic skeleton `13,941,059/s`.
  - `sensor-format`: fast `10,089,335/s`, monolithic skeleton `8,398,723/s`.

### Phase 3 - Single-Source Semantic Emitters

- [x] Create a small semantic-emitter layer for generated opcode bodies.
- [x] Start with opcodes already proven in the current generated fast core:
  `NOP`, `RJMP`, branch predicates, `SBIW`/`ADIW`, subtract/compare, add,
  `DEC`, `LDI`, `MOV`, `MOVW`, `PUSH`, `POP`, indirect `LD`/`ST`, `LPM`,
  `CALL`, and `RET`.
- [x] Emit code from avrts semantics, helpers, or shared descriptions, not from
  avr8js implementation bodies.
- [x] Add focused parity tests per opcode family.

Exit gate:

- [x] The first semantic tranche matches the interpreter on focused tests.
- [x] No result benchmark regresses in default mode.

Evidence:

- The monolithic generator now reuses the existing generated fast-core arms,
  bucketed by opcode high nibble, and falls back only for uncovered opcodes.
- First attempt caught and fixed a switch fallthrough bug; matched inline arms
  now `break` after one instruction while FastBlock arms still `continue`.
- `bun test test/generated-fast-core.test.ts test/benchmark-results.test.ts`:
  51 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun run check:fast-core`: pass.
- `bun run bench:result -- --case dsp-fixed --analog 512 --d2 high --core
  monolithic`: pass.
- Serial overhead sample, `--cycles 1000000 --repeats 5`:
  - `tight-loop`: fast `16,358,725/s`, monolithic inline tranche
    `16,207,497/s`.
  - `sensor-format`: fast `9,915,770/s`, monolithic inline tranche
    `9,840,780/s`.

### Phase 4 - Full Opcode Coverage

- [x] Add arithmetic and flag-heavy opcodes:
  `INC`, `COM`, and `NEG`.
- [x] Add first logic and shift/rotate opcode slice:
  `AND`, `EOR`, `OR`, `ORI`, `ANDI`, `SWAP`, `LSR`, `ROR`, and `ASR`.
- [x] Add first skip opcode slice:
  `CPSE`, `SBRC`, `SBRS`, `SBIC`, and `SBIS`.
- [x] Add remaining compare/control branch opcodes. All conditional branches
  (`BREQ`/`BRNE`/`BRCS`/`BRCC`/`BRMI`/`BRPL`/`BRLT`/`BRGE`/`BRVS`/`BRVC`/`BRHS`/
  `BRHC`/`BRTS`/`BRTC`/`BRIE`/`BRID`) are covered by the generic
  `branch-if-set`/`branch-if-clear` arms; the T-flag bit ops `BST` and `BLD`
  complete the bit/branch family.
- [x] Add direct and displacement memory opcode slice:
  `LDS`, `STS`, `LDD_Y`, `LDD_Z`, `STD_Y`, and `STD_Z`.
- [x] Add first IO opcode slice: `IN` and `OUT`.
- [x] Add IO bit opcode slice: `SBI`, `CBI`, `SBIC`, and `SBIS`.
- [x] Add stack/call/return opcode slice:
  `PUSH`, `POP`, `CALL`, and `RET`.
- [x] Add control/status opcode slice:
  `JMP`, `RCALL`, `RETI`, `SEI`, `CLI`, `IJMP`, `ICALL`, `BSET`, and `BCLR`.
- [x] Add multiply and extended helper-related variants:
  `MUL`, `MULS`, `MULSU`, `FMUL`, `FMULS`, and `FMULSU`.
- [x] Add system-control opcodes: `SLEEP`, `WDR`, and `BREAK`.
- [x] Track unsupported or intentionally unimplemented opcodes explicitly: the
  interpreter has no handler for `SPM`, `ELPM`, `EIJMP`, `EICALL`, `DES`, `XCH`,
  `LAS`, `LAC`, or `LAT` (none are valid on the ATmega328P / not modeled), so the
  monolithic core deliberately routes them through the shared fallback, which
  raises `UnknownOpcodeError` exactly as the handler path does.

Exit gate:

- [x] All implemented opcodes have focused parity coverage. Every inlined opcode
  is exercised against the tick()/handler interpreter — broad fixtures in
  `test/generated-fast-core.test.ts` plus per-opcode cases in `test/phase4.test.ts`.
- [x] The monolithic path can run all committed benchmark fixtures.
- [x] Fallback use for implemented opcodes is now zero in the monolithic core;
  the only remaining fallback is the explicitly-unsupported opcode set above.

Evidence:

- Logic/shift/IO slice reuses the generator's single-source arm list and stays
  behind `--core monolithic`.
- Direct/displacement memory slice mirrors the existing stable handlers:
  `LDS`/`STS` use the second flash word as the SRAM address, and `LDD`/`STD`
  compute the AVR `q` displacement from opcode bits before going through
  `readData`/`writeData`.
- Skip/IO-bit slice mirrors the stable skip helper's two-word accounting for
  `JMP`/`CALL`/`LDS`/`STS`, and uses `readIo`/`writeIo` for observable I/O
  side effects.
- Control/status slice preserves exact opcode specificity (`SEI`/`CLI` before
  generic `BSET`/`BCLR`), uses the same far-address decode as `CALL`, and keeps
  `RETI`'s interrupt-enable side effect.
- `bun test test/generated-fast-core.test.ts test/benchmark-results.test.ts`:
  51 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun run check:fast-core`: pass.
- `bun test test/generated-fast-core.test.ts test/benchmark-results.test.ts
  test/phase3.test.ts`: 69 pass, 0 fail.
- `bun run bench:result -- --case dsp-fixed --analog 512 --d2 high --core
  monolithic`: pass.
- Serial sample, `--cycles 1000000 --repeats 5`:
  - `tight-loop`: fast `16,163,225/s`, monolithic `15,135,160/s`.
  - `sensor-format`: fast `10,245,133/s`, monolithic `9,999,190/s`.
  - `string-heavy`: fast `8,401,509/s`, monolithic `9,723,765/s`.
- Post-memory-slice serial sample, `--cycles 1000000 --repeats 5`:
  - `sensor-format`: fast `10,224,959/s`, monolithic `10,068,070/s`.
  - `string-heavy`: fast `8,290,441/s`, monolithic `9,392,635/s`.
  - `dsp-fixed`: fast `8,774,066/s`, monolithic `10,167,053/s`.
- Post-skip/IO-bit-slice serial sample, `--cycles 1000000 --repeats 5`:
  - `sensor-format`: fast `10,708,151/s`, monolithic `10,382,344/s`.
  - `string-heavy`: fast `8,238,596/s`, monolithic `9,520,821/s`.
  - `dsp-fixed`: fast `8,462,707/s`, monolithic `8,794,526/s`.
- Post-control/status-slice serial sample, `--cycles 1000000 --repeats 5`:
  - `sensor-format`: fast `9,911,033/s`, monolithic `10,417,761/s`.
  - `string-heavy`: fast `7,212,580/s`, monolithic `9,550,502/s`.
  - `dsp-fixed`: fast `8,272,361/s`, monolithic `8,670,411/s`.
- Full-coverage tranche (`INC`/`COM`/`NEG`/`BST`/`BLD`/`MUL`/`MULS`/`MULSU`/
  `FMUL`/`FMULS`/`FMULSU`/`SLEEP`/`WDR`/`BREAK`):
  - `bun test`: 471 pass, 0 fail.
  - `bun run typecheck`: pass.
  - `bun run check:fast-core`: pass.
  - `bun test test/phase4.test.ts`: 14 pass, 0 fail (per-opcode monolithic-vs-tick
    parity).
  - `bun run bench:result -- --case dsp-fixed --analog 512 --d2 high --core
    monolithic`: pass.
  - Serial sample, `--cycles 1000000 --repeats 5`:
    - `sensor-format`: fast `11,043,881/s`, monolithic `10,911,853/s`.
    - `string-heavy`: fast `9,735,838/s`, monolithic `9,924,215/s`.
    - `dsp-fixed`: fast `8,385,581/s`, monolithic `8,075,147/s`.

### Phase 5 - Remove Hot Fallback

- [x] Instrument the monolithic fallback: a per-CPU `monolithicFallbacks` counter
  increments whenever the decode `switch` falls through to the shared handler
  path. The increment lives in the cold `else` branch, so it adds no hot-path
  cost.
- [x] Keep a debug-only fallback if it is useful for bring-up diagnostics. The
  fallback remains as the route for genuinely unsupported opcodes
  (`SPM`/`ELPM`/...), which still raise `UnknownOpcodeError` exactly as before.
- [x] Fail tests if production monolithic mode hits fallback unexpectedly. Every
  committed fixture now asserts `monolithicFallbacks === 0`
  (`test/generated-fast-core.test.ts`), and `test/phase5.test.ts` proves the
  counter actually fires for an unsupported opcode (so the guard is not vacuous).
- [ ] Profile real fixtures and confirm indirect handler dispatch is gone from
  the hot path.

Exit gate:

- [x] Fallback dispatch is measured to be zero on every committed fixture, so the
  remaining avr8js gap cannot be attributed to handler fallback in the hot loop.
- [x] `bench:result` still matches avr8js on real result fixtures.

Evidence:

- `bun test`: 484 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun run check:fast-core`: pass.
- `bun test test/generated-fast-core.test.ts test/phase4.test.ts
  test/phase5.test.ts test/benchmark-results.test.ts`: green; the per-fixture
  `monolithic core takes no hot fallback` cases all report
  `monolithicFallbacks === 0`.
- `bun run bench:result -- --case dsp-fixed --analog 512 --d2 high --core
  monolithic`: pass.

### Phase 6 - Benchmark Gate

- [x] Compare current avrts core vs monolithic avrts core vs avr8js.
- [x] Run at minimum:
  `tight-loop`, `delay-blink`, `serial-print`, `analog-write`,
  `sensor-format`, `float-math`, `bitbang-crc`, `peripheral-mix`,
  `isr-heavy`, `string-heavy`, and `dsp-fixed`. (`peripheral-mix` was added to
  `scripts/benchmark-compare.ts` for this gate.)
- [x] Use repeated runs, not one sample (`--repeats 5`, best-of).
- [x] Record both speed and correctness evidence.

Speed evidence (`bun run bench:compare -- --repeats 5`, best-of-5, 16 MHz,
cycles/s; ratio is avrts/avr8js, higher is better):

| workload       | fast core    | monolithic   | avr8js       | fast ratio | mono ratio |
| -------------- | ------------ | ------------ | ------------ | ---------- | ---------- |
| tight-loop     | 172,957,117  | 177,859,356  | ~91M         | 1.87x      | 1.97x      |
| delay-blink    | 115,995,071  | 112,164,586  | ~51M         | 2.30x      | 2.16x      |
| serial-print   | 83,936,557   | 82,575,974   | ~70M         | 1.20x      | 1.19x      |
| analog-write   | 81,777,249   | 82,049,397   | ~71M         | 1.11x      | 1.16x      |
| sensor-format  | 35,261,254   | 35,778,022   | ~49M         | 0.71x      | 0.73x      |
| float-math     | 19,406,540   | 20,249,588   | ~39M         | 0.49x      | 0.53x      |
| bitbang-crc    | 14,154,490   | 14,753,062   | ~40M         | 0.35x      | 0.37x      |
| peripheral-mix | 76,925,444   | 76,070,271   | ~53M         | 1.43x      | 1.43x      |
| isr-heavy      | 10,129,824   | 15,765,908   | ~43M         | 0.23x      | 0.37x      |
| string-heavy   | 10,179,648   | 12,624,940   | ~50M         | 0.20x      | 0.25x      |
| dsp-fixed      | 10,492,508   | 13,296,539   | ~52M         | 0.20x      | 0.25x      |

Correctness evidence:

- `bun run bench:result --core monolithic` passes on all four result fixtures
  (`peripheral-mix`, `isr-heavy`, `string-heavy`, `dsp-fixed`): result block,
  serial output, I2C transcript, and register summary all match avr8js.
- `bun test`: 484 pass, 0 fail (includes the monolithic-vs-tick parity and
  zero-fallback guards).

Promotion target:

- [x] Real-code fixtures improve clearly over the current core. The handler-bound
  workloads gain most: `isr-heavy` +56% (0.23x→0.37x), `dsp-fixed` +27%
  (0.20x→0.25x), `string-heavy` +24% (0.20x→0.25x); `float-math`/`bitbang-crc`/
  `sensor-format` each tick up a few points. None regress.
- [ ] The real-code avr8js ratio approaches roughly `1.0x`. **Not met, and now
  judged unreachable via decode work.** The root-cause experiments below flagged
  decode-ladder depth as the largest single lever found (~10%), but the Phase 8
  ceiling experiment (2026-06-30) then proved that lever tops out at ~10% on the
  worst fixture and is noise elsewhere — it does not close the ~2x gap. Decode
  structure is closed as a parity path; see the ceiling experiment and revised
  Phase 7/8 below.
- [x] Synthetic FastBlock-heavy wins are not destroyed. `tight-loop` actually
  improves (1.87x→1.97x); `delay-blink` dips slightly (2.30x→2.16x) but stays far
  above 1.0x; `serial-print`/`analog-write`/`peripheral-mix` are flat.
- [x] Startup/generated-function cost is acceptable. No fixture shows a
  startup-dominated regression; the monolithic function compiles and runs within
  the same envelope as the fast core.

Verdict: the monolithic core is a correctness-preserving win on real,
handler-bound code and does not damage the FastBlock-heavy synthetic wins — but it
does **not** bring real-code throughput near avr8js parity. Per Phase 7, this keeps
it **experimental/opt-in**, not a default. The remaining gap was hypothesized to be
an opcode-decode-*structure* problem (Phase 8); the 2026-06-30 ceiling experiment
disproved that as the path to parity (decode ordering tops out at ~10%). The real
lever is **megamorphic-dispatch sensitivity**: avrts loses ~3x under a mixed
workload while avr8js loses ~5%. See "Megamorphic dispatch is the real real-code
gap" below.

### Root-cause experiments (2026-06-29)

After Phase 6 showed the gap was not dispatch, a sequence of controlled
experiments on `dsp-fixed`/`string-heavy` (each applied to the monolithic core and
reverted) isolated the real cost:

| experiment | change | effect | conclusion |
| ---------- | ------ | ------ | ---------- |
| E1 | skip `notifyCycles` per instruction | none | not the cost |
| E2 | strip `serviceInterrupts` + per-iteration debug guard | none | not the cost |
| E3 | inline stack ops (drop `SP` accessor) | ~noise | marginal |
| E4a | arms use `_cycles` (accessor gone), clock events skipped | +55% | **artifact** — broke peripheral updates; poll loop spun on cheaper instrs |
| E4b | same, but clock events preserved (avr8js-style accounting) | neutral | the `cycles` accessor is **not** the cost |
| E5 | hoist `LDS` to the front of the bucket-9 ladder | **~10%** | **largest single real lever found** |

Decisive finding (E5): the monolithic core decodes with `switch(opcode >>> 12)`
then a **linear `if/else if` chain** inside each case. Bucket `0x9` is overloaded
(~45 opcodes), and `LDS` — the #1 opcode in `dsp-fixed` at **18% of cycles** —
sits **26th**, so every execution walks ~25 mask-compares first. Hoisting just
that one opcode bought ~10%. The losing fixtures (dsp/string/isr) are exactly the
ones dense in bucket-9/bucket-8 memory and stack opcodes
(`LDS`/`LD`/`ST`/`STS`/`LDD`/`STD`/`CALL`/`RET`) buried deep in the longest
ladder. avr8js decodes more directly (sub-switches on lower opcode bits →
near-O(1)). The fix is denser decode structure, not more inline bodies.

Ruled out by these experiments: the per-instruction framework
(`notifyCycles`/`serviceInterrupts`/debug guard), the `cycles` accessor, and the
`SP` stack accessor — none move the needle once correctness is preserved.

### Phase 8 ceiling experiment - hotness-ordered decode (2026-06-30)

Before committing to the full second-level sub-switch (Phase 8 below), the cheap
version of the same lever was wired up and measured: reorder each monolithic
bucket's `if/else if` chain so the hottest opcodes are tested first. This is the
ceiling for "reach the hot opcode sooner" — a full sub-switch can only match
testing the hot opcode first, never beat it.

Implementation: `MONOLITHIC_HOTNESS` + `orderMonolithicArms` in
`scripts/generate-fast-core.ts`, derived from `profile:opcodes` cycle-share across
the three losing fixtures. A stable descending sort keeps overlapping-guard arms
in original order (FastBlock guards share their partner's rank), so `LDS` moves
from 27th to 1st in bucket `0x9` while every parity and zero-fallback guard stays
green (484 pass).

A/B in the **isolated** regime (one `--case` per process, original linear ladder
vs hotness-ordered, `--core monolithic`, best-of-5, two samples each; run-to-run
variance ~4%):

| fixture      | old order (LDS 27th) | new order (LDS 1st) | delta        |
| ------------ | -------------------- | ------------------- | ------------ |
| dsp-fixed    | 27.85M/s (0.50x)     | ~31.0M/s            | **+11%**     |
| string-heavy | 28.89M/s (0.55x)     | ~30.3M/s            | +5% (noisy)  |
| isr-heavy    | 29.40M/s (0.61x)     | ~28.7M/s            | ~flat (noise)|

Hotness ordering recovers ~10% on `dsp-fixed` (the one fixture where `LDS` is 18%
of cycles *and* was buried 27th) and noise elsewhere. It is a real, zero-risk win
(it never regresses), so it is **kept**. But it does not approach parity, and the
full second-level sub-switch can only match "test the hot opcode first" — its
ceiling is this ~10%. The sub-switch is therefore **not worth building for parity**.

**Critical correction (the isolated regime *is* production):** the numbers above
are ~3x higher than the Phase 6 table because Phase 6 ran *all 11 fixtures in one
process* while the A/B above ran *one fixture per process*. That is not a stale
baseline or uncommitted WIP — it is a **benchmark co-tenancy artifact**: co-running
11 firmwares megamorphically deoptimizes avrts's shared hot path. Real use runs
*one* firmware per CPU, i.e. the isolated regime, so the isolated numbers are the
production-representative ones and the Phase 6 mixed numbers under-report real-code
throughput ~3x. See the next section.

### The real-code gap was a benchmark artifact; production is ~0.6x (2026-06-30)

The whole "real code loses at ~0.20x" premise was a **benchmark co-tenancy
artifact**. `bench:compare` ran all 11 firmwares in one process; co-running that
many distinct peripheral/closure shapes megamorphically deoptimizes avrts's shared
hot-path methods. avr8js is nearly immune. Real use runs **one firmware per CPU**,
which is the isolated regime — so the isolated numbers are production.

A `--isolate` mode was added to `scripts/benchmark-compare.ts` (one subprocess per
fixture, fresh heap each). Production-representative numbers, best-of-5:

| fixture       | mixed (old default) | **isolated (production)** | avr8js |
| ------------- | ------------------- | ------------------------- | ------ |
| dsp-fixed     | 0.20x               | **0.62x**                 | 55M    |
| string-heavy  | 0.20x               | **0.57x**                 | 53M    |
| isr-heavy     | 0.24x               | **0.64x**                 | 47M    |
| float-math    | 0.49x               | 0.60x                     | 43M    |
| bitbang-crc   | 0.35x               | 0.38x                     | 43M    |
| sensor-format | 0.71x               | 0.69x                     | 53M    |

So real-code production throughput is **~0.55-0.70x of avr8js (~1.5x slower), not
~0.20x (~5x).** The synthetic/IO-bound fixtures (`tight-loop`, `delay-blink`,
`serial-print`, `analog-write`, `peripheral-mix`) are unchanged — they were always
monomorphic or IO-dominated.

Two further findings overturn earlier conclusions:

- **The monolithic core gives no production advantage.** In the isolated regime
  fast ≈ monolithic (dsp 0.62x vs 0.61x, string 0.57x vs 0.55x, isr 0.64x vs
  0.63x). The monolithic core's entire measured "win on handler-bound code" was the
  mixed-regime artifact — it has less megamorphic surface to pollute, so it
  degraded *less* under co-tenancy, but in production there is nothing to degrade.
  This undercuts the project premise (the gap was never handler fallback).
- **E1-E5 and the decode-depth conclusion were measured isolated** — the correct
  (production) regime, as it turns out — so they correctly found the framework is
  cheap *in production*. The decode lever is still only ~10% (hotness ceiling);
  decode was never the gap.

Where the remaining production ~1.5x lives — ablation in the **isolated
(production) regime**, fast core, ratio vs avr8js (each gate skips real work, so
these are upper bounds, not fixes):

| ablation                | dsp  | string | isr  |
| ----------------------- | ---- | ------ | ---- |
| baseline (isolated)     | 0.51 | 0.55   | 0.58 |
| skip `notifyCycles`     | 0.54 | 0.51   | 0.58 |
| skip clock events       | 0.63 | 0.61   | 0.69 |
| skip IO-hook dispatch   | 0.58 | 0.67   | 0.68 |

The two real production levers are **clock-event dispatch** (`runDueClockEvents` →
megamorphic `callback()`; +12-20% across the board) and **IO-hook dispatch**
(`hook(...)` in `readData`/`writeData`; +12-22%, mostly on IO-heavy fixtures).
`notifyCycles` is **noise** in production — only `exti` still uses `onCycles`; all
timers/USART/ADC/watchdog already use `addClockEvent`. So the lever is **not**
"migrate peripherals to clock events" (already done) — it is making the
clock-event and IO-hook *dispatch* cheaper (e.g. the sorted-linked-list re-arm in
`addClockEvent` runs on every timer reschedule). Both costs are shared by both
cores. A quarantine-the-megamorphic-call refactor of `readData`/`writeData` was
tried and was perf-neutral in production (reverted), so the cost is real dispatch
work, not hot-method shape. Note these levers are individually modest (~10-20%):
closing the full ~1.5x is diminishing-returns architectural work, and the sim
already runs comfortably faster than realtime (≈1.6x) on these fixtures.

### Phase 8 - Denser Secondary Decode (deprioritized; ceiling measured ~10%)

**Status:** the cheap version of this lever (hotness ordering, the "interim
fallback" below) was implemented and measured — see the ceiling experiment above.
It buys ~10% on `dsp-fixed` only and does not approach parity. The full
second-level sub-switch is **not pursued for parity**; its ceiling is already
known. The hotness ordering itself is kept as a free, zero-risk ~10% win. The
sub-switch items remain recorded only as the rejected fuller variant.

- [x] Interim version shipped: order each bucket's arms by measured hotness
  (`profile:opcodes`) so hot opcodes are tested first
  (`MONOLITHIC_HOTNESS`/`orderMonolithicArms`). Parity and zero-fallback guards
  stay green; `dsp-fixed` +~10%, others flat.
- [~] Rejected for parity: replace the linear per-bucket `if/else if` chain with a
  **second-level decode** (sub-switch on more opcode bits) for overloaded buckets
  (`0x9`, then `0x8`). Ceiling experiment shows the upside is ~10%, not the ~2x
  needed; the added generator complexity (bucket `0x9`'s arms have no single clean
  discriminator) is not justified.
- [x] Single-source generator contract preserved: arms stay defined once; only the
  per-bucket emission *order* changed.

Exit gate (against the shipped hotness-ordering version):

- [x] Parity holds: monolithic vs `tick()` and zero-fallback guards stay green
  (484 pass).
- [x] `bench:result --core monolithic` still matches avr8js on all result
  fixtures.
- [~] Real-code fixtures improve only marginally: `dsp-fixed` +~10%,
  `string-heavy`/`isr-heavy` within noise. Below the bar for the full sub-switch.
- [x] FastBlock-heavy synthetic wins (`tight-loop`, `delay-blink`) do not regress.

### Phase 7 - Production Decision

Revised after the 2026-06-30 measurement-regime correction. Two prior promotion
rationales are now closed: decode structure (ceiling ~10%) and "monolithic beats
the fast core on real code" (a benchmark-co-tenancy artifact — see "The real-code
gap was a benchmark artifact"). Measured production-representatively (`--isolate`),
fast ≈ monolithic on every real fixture.

- [x] Decision: keep the monolithic core **experimental / opt-in only — and weigh
  removing it.** It is correctness-preserving and carries a free ~5-10% (`dsp-fixed`)
  from hotness ordering, but in the production-representative regime it shows **no
  advantage over the fast core** (dsp 0.61x vs 0.62x, string 0.55x vs 0.57x, isr
  0.63x vs 0.64x). Its premise — that real code lost to avr8js because of handler
  fallback — did not hold: eliminating fallback did not beat the fast core.
- [x] Corrected: the earlier "clear win on handler-bound code" (Phase 6) and the
  "wins more in the mixed regime" note were both the co-tenancy artifact, not a real
  production win. Do not promote on those numbers.
- [ ] If the monolithic core is to be kept, it needs a production-regime reason to
  exist (e.g. a future inlining win the fast core can't match). Absent that,
  consider reverting it to keep maintenance surface down, per the "if it loses like
  the previous variants, revert it" rule below.
- [ ] The remaining production gap (~1.5x, not ~5x) is **clock-event dispatch and
  IO-hook dispatch** (isolated-regime ablation above), shared by both cores — not
  decode, not handler dispatch, and not per-instruction cycle listeners (already on
  `addClockEvent`). Levers are cheapening those dispatch paths (e.g. the
  sorted-linked-list re-arm in `addClockEvent`), each ~10-20%. Diminishing returns;
  the sim already runs ≈1.6x realtime. Pursue only if real-code speed becomes a
  priority, and it benefits both cores equally (so it does not change the
  fast-vs-monolithic decision).

## Required Verification

Run these before calling the prototype slice done:

```powershell
bun test
bun run typecheck
bun run check:fast-core
bun run bench:result
bun run bench:compare -- --repeats 5 --isolate
```

Use `--isolate` for any real-code speed claim: it runs each fixture in its own
process (one firmware per CPU), which is how the simulator is used in production.
The single-process default co-runs all 11 firmwares and megamorphically
under-reports avrts real-code throughput ~3x (avr8js is nearly immune), so it is
only meaningful for the synthetic/IO-bound fixtures. When the monolithic flag
exists, also run the result and comparison gates with `--core monolithic`.

## Recommended First Slice

- [x] Add only the side-by-side harness, generator freshness check, and benchmark
  selection first.
- [x] Do not inline all opcodes in the first slice.
- [x] Prove the default engine is untouched.
- [x] Then add the decode-tree skeleton and measure overhead.

This keeps the current solution safe while opening the larger performance path.
