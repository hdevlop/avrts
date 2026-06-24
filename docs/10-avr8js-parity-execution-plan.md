# avr8js Parity Execution Plan

This plan starts after `09-fast-core-plan.md` Step 5d.

Current fast-mode status:

- `CPU.run()` uses the class-local generated fast core (`runGeneratedFastCore`).
- Two ladders are now single-sourced from the generator: `runGeneratedFastCore`
  (production) and `runFastProfiled` (profiler). The old `runFast` hand-vs-generated
  A/B twin and its `bench:generated-fast-core` benchmark were **removed** as dead
  weight once both ladders became generated; the real gates are `bench:compare`
  (vs avr8js) and the generated-vs-`tick()` parity tests.
- Generated arms cover idle/counting FastBlocks, `NOP`, `RJMP`, branch predicates,
  `SBIW`/`ADIW`, the subtract/compare group (`SUB`/`SBC`/`SUBI`/`SBCI`/`CP`/`CPC`/`CPI`),
  the add group (`ADD`/`ADC`), `LDI`/`MOV`/`MOVW`, `PUSH`/`POP`, `LD`/`ST` indirect,
  `LPM`, the Arduino `micros()` FastBlock, the `subcmp-run` straight-line block,
  and `CALL`.
- Latest recorded `bench:compare` best-of-5:

```text
tight-loop, 10M cycles    178.1M/s vs avr8js 90.6M/s = 1.97x
delay-blink, 50M cycles   121.1M/s vs avr8js 50.5M/s = 2.40x
serial-print, 5M cycles    83.7M/s vs avr8js 67.7M/s = 1.24x
analog-write, 5M cycles    76.8M/s vs avr8js 71.2M/s = 1.08x
```

The job now is not just to win the current fixtures once. The job is to make the
fast path broad, tested, and hard to regress.

## Status Checklist

Implementation/status:

- [x] Step 0: baseline and profiling workflow established.
- [x] Step 1: generated subtract/compare arms (`SUB`, `SBC`, `SUBI`, `SBCI`,
  `CP`, `CPC`, `CPI`).
- [x] Step 2: generated add/word-arithmetic arms (`ADD`, `ADC`, `ADIW`).
- [x] Step 3: generated data movement, stack, and memory arms (`MOVW`,
  `PUSH`/`POP`, indirect `LD`/`ST`, `LPM`).
- [x] Generator consolidation: `runGeneratedFastCore` and `runFastProfiled` are
  generated from one arm list; the old `runFast` A/B twin was removed.
- [x] Step 4 first slice: `subcmp-run` straight-line FastBlock shipped with
  parity and guard tests.
- [x] Step 5: event-scheduled peripheral migration was already complete; this
  plan treats it as verify-don't-redo.
- [x] Real-sketch validation: `sensor-format` fixture added and wired into
  `bench`, `bench:compare`, `profile:opcodes`, and Phase 17 perf coverage.
- [x] Step 7 browser/demo release gate rerun: `bun run build:demo` and
  `bun run test:e2e` both passed.
- [x] Step 8 checkpoint: the arc was split into logical commits for fast-core
  coverage, benchmark cleanup, real-sketch validation, and docs/status.

Known result:

- [x] Current synthetic/busy-wait fixtures are near or above avr8js.
- [x] `sensor-format` proves the wins do not fully generalize to real Arduino
  helper-heavy code (`0.46x` avr8js in the recorded isolated compare).
- [x] The next real hot shape is branchy library/helper loops
  (`__udivmodsi4` / `Print::printNumber`), not another simple straight-line ALU
  run.

Not done / optional:

- [ ] Decide whether real-program throughput is a product goal. If yes, start a
  Step 6-style branchy helper-loop translator/JIT slice.
- [ ] Add more real fixtures only if broader product claims need evidence
  (for example I2C/SPI or string-heavy sketches).
- [ ] Branch-shaped loop fusion remains deliberately unshipped unless a real
  profile justifies it.

## Goal

1. Keep the tracked workloads at or above avr8js steady-state throughput.
2. Broaden the generated core so real Arduino programs do not fall back to the
   handler path for common ALU, compare, memory, and stack instructions.
3. Only after generated-core gains flatten, decide whether to build a true block
   compiler. A generated monolithic interpreter can match avr8js's dispatch shape;
   beating avr8js generally requires running multiple AVR instructions per host
   dispatch.

## Rules

- Profile first. Every implementation slice starts from `profile:opcodes`, not a
  guess.
- Keep a patch only if correctness is green and benchmark results are neutral or
  better on the full fixture mix.
- Do not inline an opcode without same-commit generated-fast-core parity tests.
- Do not bypass `readData` / `writeData` semantics for IO, hooks, or public
  behavior just to make a benchmark prettier.
- Prefer small measured commits. If a slice is neutral, park it in the doc or
  revert it before moving on.

## Step 0 - Session Baseline

Run this at the start of each optimization session:

```sh
git status --short
bun run profile:opcodes -- --mode fast --top 12 --window 6
bun run bench:compare -- --repeats 5
```

Record:

- hottest fallback opcodes per fixture;
- generated-vs-handwritten ratios;
- avrts-vs-avr8js ratios;
- any noisy or suspicious fixture.

Done when the next target is justified by the profile, not by memory of an older
run.

## Step 1 - Generated Subtract And Compare Group — IMPLEMENTED

Generated arms for the subtract/compare family now live in
`scripts/generate-fast-core.ts` (built by a shared `subtractArm()` helper so the
generator stays DRY while still emitting fully inline flag math):

- `SUB`, `SBC`, `SUBI`, `SBCI`, `CPC`, `CPI` — the planned set.
- `CP` was added too: it is the read-only counterpart of `SUB`, identical shape,
  and very common in real compare chains. Omitting it would have left the most
  frequent compare on the handler path.

What was implemented:

- Inline flag math in each arm body — no helper call on the hot path — mirroring
  `sub8` in [src/cpu/alu.ts](../src/cpu/alu.ts) byte-for-byte (`H,V,N,Z,C,S`).
- The AVR multi-byte zero rule for `SBC`/`SBCI`/`CPC`: new `Z` is set only when
  the current result is zero **and** the previous `Z` was already set (`carry`
  and `prevZ` are read from SREG before SREG is rewritten).
- Compare arms (`CP`/`CPC`/`CPI`) leave the destination register untouched.
- **Decode mirrors the handlers exactly** (this project has shipped a wrong-mask
  decode before — see doc 09's SBIW note): `SUB`/`SBC`/`CP`/`CPC` use
  `regD5`/`regR5` (r0..r31); `SUBI`/`SBCI`/`CPI` use `regD4` (**r16..r31**,
  `16 + ((opcode >> 4) & 0xf)`) and `imm8`. Do not re-derive — import the same
  `regD4`/`regD5`/`regR5`/`imm8` helpers the handlers use.

### Ladder-sync rule — now STRUCTURAL (the ladders are generated)

There are two copies of the dispatch ladder in [src/cpu/cpu.ts](../src/cpu/cpu.ts):

1. `runGeneratedFastCore` — the path `CPU.run()` executes.
2. `runFastProfiled` — the path `profile:opcodes --mode fast` walks.

**Both are generated from the single `GENERATED_ARMS` list** (a
`"core" | "profiled"` variant flag handles the profiler's per-step
`profileFastBlock`/listener emits). Each lives between `// BEGIN/END GENERATED …`
markers; `bun run check:fast-core` and the `generated fast core` freshness test
fail if either drifts from the generator. So adding an arm now means editing the
generator **only** — manual mirroring is no longer needed or possible without the
freshness gate catching it. (Before this, the `CALL` arm had drifted into the
generated copy alone — exactly the failure this closes.) A
`profiled ladder matches run()` test proves the profiler ladder reaches identical
state and bills every cycle, and a `generated fast core matches the tick()/handler
path` test proves the production ladder matches the pure interpreter on every
fixture — so profiling stays honest and correctness is anchored to the handler,
not to a sibling copy.

(There was a third ladder, `runFast`, kept only as a hand-vs-generated A/B
baseline. Once it became a generated twin of `runGeneratedFastCore` it was pure
duplication, so it and its `bench:generated-fast-core` benchmark were removed.)

Tests (added in [test/cpu.test.ts](../test/cpu.test.ts), `runFast opcode parity`):

- Fast-run (`run`) vs handler (`tick`) parity for all seven opcodes across the
  flag-edge cross product: no-borrow, borrow/carry, half-carry, signed overflow,
  negative, zero, and — for `SBC`/`SBCI`/`CPC` — `prevZ` preservation via seeded
  SREG (C and Z toggled).
- `CP`/`CPC`/`CPI` assert the destination register is not written.
- Tests reuse two persistent CPUs (Decoder construction is expensive) and
  `reset()` per case rather than reconstructing.

Measured (best of 3): the tracked fixtures stayed neutral and the A/B held —
`bench:compare` tight-loop 1.93x, delay-blink 1.94x, serial-print 0.97x,
analog-write 0.99x; `bench:generated-fast-core` generated/base ≥ 1.0x on every
non-noisy fixture. The win is on general compare-heavy code that previously fell
to the handler, not on the idle-loop fixtures (already FastBlock-served).

Benchmark gate (unchanged for the next group):

```sh
bun run generate:fast-core
bun run check:fast-core
bun test test/cpu.test.ts test/generated-fast-core.test.ts
bun run bench:compare -- --repeats 5
```

Keep if `delay-blink` improves or stays neutral and `serial-print` /
`analog-write` do not regress outside normal noise.

## Step 2 - Generated Add And Word-Arithmetic Group — IMPLEMENTED (ADD/ADC/ADIW)

Re-profiling after Step 1 (`profile:opcodes --mode fast`) showed the tracked
fixtures have **no hot add-family handler fallback left**: the delay/`micros`
arithmetic chain is `SUB/SBC/CPC/CPI/SBCI` (covered by Step 1), the counted shift
loop is already a FastBlock, and `ADD`/`ADC`/`ADIW` outside those are cold
(<0.1%). So this group is a **breadth** patch (Goal #2 — keep general Arduino code
off the handler path), expected to be **neutral on the fixtures**, which it is.

Implemented:

- `ADD`, `ADC`, `ADIW` — the symmetric mirror of Step 1 (`add8`↔`sub8`,
  `ADIW`↔`SBIW`). Built by a shared `addArm()` helper in the generator; `ADIW` is
  an explicit word-arithmetic arm.
- Inline flag math mirroring `add8` byte-for-byte (`H,V,N,Z,C,S`, `ADC` carry-in);
  `ADIW` uses the word-flag mask (`SREG_WORD_MASK`, V/N/Z/C/S, no H) exactly like
  the handler, kept separate from byte arithmetic.
- **Guard ordering matters:** `ADD` shares the `0x0c00` mask with the
  `shift-left-dec` FastBlock, so the `ADD` arm is placed **after** it — the block
  specialization gets first crack and only general `ADD`s fall through.
- Mirrored into `runFast` and `runFastProfiled` per the Step 1 ladder-sync rule.

**Skipped (profile-gated, per this step's own "only if hot" guidance):** `INC`,
`DEC` (`DEC` lives inside the shift-left-dec FastBlock; neither is hot elsewhere),
and `NEG` (absent from every fixture). Add them only when a profile shows them hot.

Tests (`runFast opcode parity` in [test/cpu.test.ts](../test/cpu.test.ts)):
handler-vs-fast parity for `ADD`/`ADC`/`ADIW` across the carry/half-carry/signed-
overflow/zero/wrap edges with seeded SREG.

Measured (best of 3): no regression — `bench:compare` tight-loop 1.89x,
delay-blink 1.84x, serial-print 1.11x, analog-write 1.01x; A/B generated/base
within noise of 1.0x on every fixture.

## Step 3 - Generated Data Movement, Memory, And Stack Group — DONE (MOVW, PUSH/POP, LD/ST, LPM)

Started with the two lowest-risk slices. Implemented:

- **`MOVW`** — register-only word copy (`data[d..d+1] = data[r..r+1]`), zero memory
  risk, placed right after `MOV`.
- **`PUSH` / `POP`** — they call the CPU's own `pushByte`/`popByte` primitives (the
  exact call the handlers make and the same ones the `CALL` arm uses for
  `pushWord`), so SP wrap and stack-SRAM access stay byte-identical. `pushByte`
  writes the stack directly (no IO hook — the stack is plain SRAM), so this is the
  "narrower proof says direct access is safe" case from the safety rules below.

Why these first: post-Step-1/2 profiling showed the analog-write ISR prologue
spends its non-block time in a long `PUSH` run, and `MOVW` shows up around the
`micros` block edges. Both were still hitting the handler.

Tests (`runFast opcode parity` in [test/cpu.test.ts](../test/cpu.test.ts)): handler-vs-fast
parity for `MOVW` (both bytes + SREG untouched), `PUSH` (register, stack byte at
RAMEND, `SPL`/`SPH`), and `POP` (dest register, `SPL`/`SPH`, stack byte), over
several registers including r0/r31 boundaries.

Measured (best of 3): **analog-write 1.01x → 1.08x** (the ISR `PUSH` run now
inlines), serial-print 1.09x, tight-loop 1.87x, delay-blink 1.86x; full suite 380
green, A/B neutral.

> **Drift found here — and since CLOSED.** While adding these arms I found the
> `CALL` arm (doc 09 Step 5d) had only ever been added to the *generated* core,
> never to the handwritten `runFast`/`runFastProfiled` ladders. That was the
> concrete proof that hand-mirroring leaks. It is now fixed structurally: **all
> three ladders are generated from one `GENERATED_ARMS` list** (see the
> ladder-sync rule under Step 1), so `CALL` — and every future arm — lands in all
> three at once, with `check:fast-core` + the freshness/profiler-parity tests
> guarding against any drift.

### Memory arms — IMPLEMENTED (the higher-risk slice)

Profiling confirmed `ST X+` was the hottest remaining handler fallback in
serial-print-listener (6.4% of events), with `LPM` next. Implemented the full
indirect family plus LPM, all single-sourced in the generator (one edit →
regenerated into all three ladders):

- **`LD`/`ST` indirect** — `X`, `Y`, `Z` with no-change / post-increment (`+`) /
  pre-decrement (`-`): 14 arms via a `memIndirectArm()` helper that mirrors
  `loadIndirect`/`storeIndirect` exactly. Pointer registers (X=26, Y=28, Z=30) are
  the plain register file (`data[...]`), but the access goes through
  **`this.readData`/`this.writeData`** so every IO hook (pin changes, UDR side
  effects, …) fires identically — the arm just skips the dispatch, not the hook.
  (Plain `LD/ST` via Y/Z with displacement `q=0` are `LDD`/`STD`, left for later.)
- **`LPM`** — R0 (`0x95c8`), `Rd,Z` (`0x9004`), `Rd,Z+` (`0x9005`); pure flash
  reads, no hooks.
- Placed **late** in the ladder (after `call`): colder than the ALU/branch/stack
  arms, so hot instructions never test past them — confirmed by benchmark.

Tests: handler-vs-fast parity for every LD/ST variant (dest/src reg, both pointer
bytes, the pre-dec and post-inc target SRAM bytes), the `ST X+` store-the-pointer
edge, and all three LPM forms incl. the odd-`Z` high-byte path. Plus an
**IO-hook test** that stores to `PORTB` via `ST X` and asserts the *entire* data
array is byte-identical between the handler and fast paths — proving the
`writeData` side effects are preserved.

Measured (best of 5): no regression — tight-loop 1.95x, delay-blink 1.82x,
serial-print 1.27x, analog-write 1.10x; full suite 389 green. (A 3-repeat run
showed a transient dip that vanished at 5 repeats — background load, not the new
arms.)

### Still optional

- `IN` / `OUT` — only with hook and IO semantics preserved; add if a profile shows
  them hot outside the FastBlocks.
- `LDD`/`STD` with non-zero displacement — add if array/struct access shows up hot.

Safety rules (unchanged):

- Register-file reads/writes can use `data[...]` directly.
- SRAM/IO reads and writes must preserve existing `readData` / `writeData`
  behavior unless a narrower proof says direct access is safe for that address.
- Stack pointer updates must match the handler path byte-for-byte.
- No memory arm lands without tests that inspect touched registers, memory, `SP`,
  `SREG`, `PC`, and cycles.

Benchmark gate is the same as Step 1. Revert any arm that adds branch-ladder cost
without reducing handler fallback enough to pay for itself.

## Step 4 - Expand FastBlocks Into A Small Block Compiler — FIRST SLICE DONE (subcmp-run)

Generated per-opcode arms still dispatch once per AVR instruction (one ladder
traversal each). The first block-compiler slice executes a *straight-line run* of
several instructions in one host dispatch.

**Implemented: the subtract/compare straight-line block (`FAST_BLOCK_SUBCMP_RUN`).**
Profiling showed delay-blink's 8-instruction 64-bit elapsed compare
(`SUB; SBC; SBC; SBC; CPI; SBCI; CPC; CPC` at 0xf1–0xf8) was **~13.6% of the
fixture's cycles** — the largest non-block hot region left. The block:

- classifies a run of consecutive subtract/compare-class ops
  (`SUB/SBC/CP/CPC/SUBI/SBCI/CPI`) starting at a `SUB`, length ≥ 3, and executes
  the whole run in one go, **reusing the same `sub8` helper the handlers use** —
  so flag math (including the multi-byte `Z` rule) is provably identical, not a
  second implementation.
- triggers from a `subcmp-run-block` arm placed before the general `SUB` arm
  (same pattern as shift-left-dec before `ADD`); a non-run `SUB` classifies to
  `NONE` once and falls straight through.
- keeps the standard FastBlock guards via `canRunFastBlock`: fast mode only, no
  cycle listeners, no enabled pending interrupt, and it **stops before the next
  scheduled clock event / the run target** — so it never bills a multi-cycle jump
  past an event that must fire mid-run (it declines and the per-instruction path
  takes over).

**Measured (best of 5): delay-blink 1.82x → 2.30x** (90M → ~115M cycles/s); other
fixtures unchanged (tight-loop 1.98x, serial-print 1.22x, analog-write 1.10x);
full suite 398 green. Tests cover handler-vs-block parity across SREG seeds
(carry-in + multi-byte Z), block recognition via the profiler, the short-run
(< min length) fall-through, the clock-event guard (event fires on time), and the
cycle-listener decline.

> This is the proof that the block-compiler direction pays *beyond* per-opcode
> generation — exactly the Step 4 "done when" bar. An earlier instinct that the
> chain was negligible was wrong: it conflated event% with cycle%.

### Remaining Step 4 work (start narrow, profile-driven)

- More straight-line shapes if a profile shows them hot (e.g. logic/ALU runs);
  the `subcmp-run` block is the template (classify → guard → execute via the
  shared helper → parity + guard tests).
- Then counted loops already recognized by the FastBlock cache, and short
  branch-shaped blocks with one stable exit.

Required guards (unchanged): fast timing mode only; no breakpoints/trace/unknown-
opcode pause/debug hooks; opcode words at the cached PC still match; no pending
clock event inside the block window unless split before it; no instruction in the
block can observe a timer counter that must be live at an intermediate cycle;
interrupts serviced at points that preserve existing behavior.

## Step 5 - Event-Scheduled Peripheral Migration — ALREADY DONE (verify, don't redo)

**This migration is complete.** When this plan was first drafted only the
watchdog was event-scheduled; since then all peripherals were moved onto the CPU
clock-event queue. Verified in the tree:

- [src/avr.ts](../src/avr.ts) no longer has a `tickPeripherals` method or an
  `onCycles` registration — the per-instruction fan-out is gone.
- All seven peripherals — watchdog, USART, Timer0 ([timer.ts](../src/peripherals/timer.ts)),
  Timer1, Timer2, ADC, EXTI — call `addClockEvent`/`clearClockEvent`.
- [src/cpu/cpu.ts](../src/cpu/cpu.ts) drives due events off `nextClockEvent` /
  `runDueClockEvents` in the `cycles` setter (one null-check on the hot path when
  nothing is scheduled), with the cycle-exact path firing events in per-cycle
  order.

So the task here is no longer "migrate" — it is **verify and harden**:

- Confirm cycle-exact mode still fires events in per-cycle order (the
  `advanceCycleExact` loop).
- Confirm `TCNTx` on-read stays live even though timers are no longer ticked
  every instruction (the live-`TCNT` read hook is one of the two sharp edges).
- Confirm compare match, overflow, PWM edge timing, interrupt flags,
  snapshot/restore, and prescaler behavior remain byte-exact — the USART
  level-triggered UDRE re-arm is the other sharp edge.

Re-open a real migration only if a fresh profile proves cycle fan-out is again
dominant (it should not be — there is no per-instruction fan-out left).

Validation focus:

```sh
bun test test/phase12-timing.test.ts test/phase8-cpu.test.ts test/phase10-snapshot.test.ts test/phase15-peripheral-fidelity.test.ts
bun run bench:compare -- --repeats 5
```

## Step 6 - Translate-Once Core For Beating avr8js

If the product goal becomes "consistently faster than avr8js", a generated
monolithic interpreter is not the final architecture. It still dispatches once per
executed AVR instruction. The next architecture is translate-once execution:

- detect hot PCs or hot basic blocks;
- translate them into a compact internal block representation or JS closure;
- cache by flash identity, PC, opcode words, timing mode, and debug state;
- invalidate on flash replacement, reset, restore, or any mode change that makes
  the block unsafe;
- execute blocks only when the Step 4 guards hold.

Start with a tiny block compiler, not a whole-program JIT:

1. register-only straight-line ALU block;
2. counted delay loop block;
3. branch-with-one-hot-exit block;
4. memory block with conservative `readData` / `writeData` calls;
5. optional specialized ISR prologue/epilogue block if profiles justify it.

This is the step that can beat avr8js structurally, because it reduces host
dispatch count below avr8js's one-dispatch-per-AVR-instruction model.

## Step 7 - Full Validation Gate

Latest pass:

```sh
bun run build:demo
# passed; emitted browser-worker.js and main.js

bun run test:e2e
# passed; 8 browser tests, including snapshot then restore rewinds CPU state
```

Before calling any implementation step done:

```sh
bun run check:fast-core
bun run typecheck
bun test
bun run build:demo
bun run test:e2e
git diff --check
```

Performance proof:

```sh
bun run bench:compare -- --repeats 5
bun run bench -- --repeats 3
```

Acceptance:

- correctness gates are green;
- generated output is fresh;
- no benchmark-floor regression;
- no tracked compare fixture regresses outside noise without an explicit reason;
- the plan doc records what changed and what the measurements said.

## Step 8 - Commit Discipline

Latest checkpoint:

- `Expand generated fast core coverage`
- `Remove generated fast core A/B benchmark`
- `Add real Arduino sensor benchmark fixture`
- `Update avr8js parity plan status`

Commit each measured slice separately:

1. generated ALU group;
2. generated memory/stack group;
3. block compiler scaffold;
4. each peripheral event migration;
5. each validation or benchmark-harness adjustment.

Each commit should include:

- implementation;
- parity tests;
- generated artifact refresh, if needed;
- doc measurement note;
- benchmark result summary.

## Immediate Next Patch

Steps 1 (subtract/compare + `CP`), 2 (`ADD`/`ADC`/`ADIW`), and the first half of
Step 3 (`MOVW` + `PUSH`/`POP`) are **done** — see above. The generated core now
covers the common ALU + the safe data-movement/stack ops.

The consolidation (single-source the dispatch ladders from the generator) is
**done**, and the follow-up cleanup with it: the redundant `runFast` twin and its
`bench:generated-fast-core` A/B benchmark were **deleted** (~485 lines out of
cpu.ts). Two generated ladders remain (`runGeneratedFastCore`, `runFastProfiled`);
correctness is anchored by the new generated-vs-`tick()` fixture parity test and
the profiler-parity test, and the perf gate is `bench:compare`.

Step 3's memory arms are now **done** too (`LD`/`ST` indirect family + `LPM`), so
the generated core covers the common ALU, compare, data-movement, stack, and
memory instructions. The per-opcode generation strategy has largely played out:
the remaining handler fallbacks in the fixtures are cold.

Step 4's first slice is **done**: the `subcmp-run` straight-line block took
delay-blink from 1.82x to **2.40x**, proving the block-compiler direction pays
beyond per-opcode generation. The template is established (classify → guard →
execute via the shared helper → parity + guard tests).

**Re-profiled afterward for the next block shape and found none worth building.**
Every fixture is now dominated by an existing fast block (tight-loop = RJMP skip;
delay-blink = micros 74.7% + subcmp 13.9%; serial-print / analog-write = the SBIW
busy-wait skip, ~99% of analog-write's cycles). The only remaining non-block hot
rows are single inline instructions (CALL/BRCS) or the periodic ISR — nothing a
new straight-line block helps. So the per-shape, per-opcode strategy is
**effectively complete**.

## Real-sketch validation - DONE (sensor-format)

The recommended validation pivot is now done. Added
`examples/arduino-sensor-format`, a committed Arduino CLI fixture that mixes
`PROGMEM` table reads, `map()`/32-bit math, RAM history updates, repeated
`analogWrite(...)`, and occasional numeric `Serial.print(...)` formatting from
flash strings. It is wired into `bench`, `bench:compare`, `profile:opcodes`, and
the Phase 17 benchmark coverage.

Measured after adding the fixture:

```sh
bun run bench -- --case sensor-format --repeats 5
# sensor-format   19,017,129 cycles/s    1.19x realtime

bun run bench:compare -- --case sensor-format --repeats 5
# sensor-format: avrts 22,843,912/s vs avr8js 50,171,234/s = 0.46x

bun run profile:opcodes -- --case sensor-format --mode fast --top 16 --window 8
# top row: PC 0x052d (byte 0x0a5a), BRNE inside __udivmodsi4
# subcmp-run block: 1.8% of sampled cycles
```

Conclusion: the synthetic-loop wins do **not** prove the work is done for real
Arduino code. This sketch runs correctly, but it surfaces a different hot shape:
the decimal/32-bit arithmetic helper loop in `__udivmodsi4` / `Print::printNumber`
(`ADC` chain, `CP`/`CPC`, `BRCS`, `DEC`/`BRNE`). The remaining gap is no longer
the old busy-wait/event-scheduling path, and it is not another straight-line ALU
run like `subcmp-run`.

## Recommendation — what's actually next

The validation pivot is done; "next" is now the unchecked part of the checklist:

1. **Checkpoint the work (recommended).** The arc is large: subtract/compare +
   add + memory + stack arms, single-source generator consolidation, the
   `subcmp-run` block, `runFast` cleanup, doc updates, and now one realistic
   validation fixture that prevents overclaiming. Land it as logical commits.
2. **Choose whether the new real-sketch gap matters.** If throughput on arbitrary
   Arduino programs is the headline goal, the next target is branch-shaped
   compiler/library helper loops, starting with `__udivmodsi4` / decimal
   formatting. Treat that as Step 6 / translate-once work or a deliberately
   scoped helper-loop block, not more per-opcode arm polishing.
3. **Add more real fixtures only to scope product claims.** An I2C/SPI driver or
   a string-heavy sketch would broaden confidence, but the first realistic
   fixture already answered the key question: the wins do not fully generalize.

Verdict: checkpoint this arc first. Continue performance work only if the goal is
"faster on real compiled Arduino programs"; in that case the next meaningful lever
is branchy helper-loop translation/JIT work, with the usual correctness and
invalidation risk.
