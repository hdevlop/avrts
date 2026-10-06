# avrts Performance

The single source of truth for avrts performance. It folds in the earlier
performance docs — the original FastBlock/generated-core arc, the concluded
monolithic-core experiment, and the real-code dispatch + FastBlock levers — which
have been consolidated here and removed. (The benchmark harness / external-simulator
methodology lives separately in [`benchmark-plan.md`](benchmark-plan.md).)

## How the engine works

`CPU.run()` executes a **generated fast core** (`src/cpu/generated/cores.ts`),
single-sourced with a profiled twin from `scripts/generate-fast-core.ts` (drift is
caught by `check:fast-core`). Per-opcode inline arms handle the common opcodes;
**FastBlocks** recognize hot instruction *shapes* and run them specially — either
bulk-skipping idle/poll loops (jump thousands of iterations in one step) or running
a whole helper loop (`__udivmodsi4`, `umulhisi3`/`mulhisi3`) in one dispatch. Default
peripherals are event-scheduled on a clock-event queue, so the normal runtime pays
no per-instruction peripheral fan-out.

## Where we are (measured `--isolate`, production-representative)

The [2026-10-06 comparison refresh](evidence/benchmark-comparison-refresh.md)
supersedes the historical July ratios. It excludes construction, adds explicit
warm-up, supplies matching host inputs/TWI and keeps the mixed fixture running.
Both engines execute in Bun 1.3.14 on the same Windows i7-7700K host, best of
five 50-million-cycle trials per workload in isolated processes.

| class | fixtures | ratio vs avr8js |
| ----- | -------- | --------------- |
| idle/delay | delay-blink | 0.94x |
| IO/peripheral | serial-print, analog-write, peripheral-mix | 3.08-4.39x |
| formatting / ISR / DSP | sensor-format, string-heavy, isr-heavy, dsp-fixed | 1.11-1.69x |
| soft-float / bit-banging | float-math, bitbang-crc | 0.44-0.73x |

Seven of the ten nontrivial workloads lead the peer in cycle rate on this host;
all ten measure over 16M cycles/s, with bit-banging closest at 18.84M. This is
not a blanket realtime guarantee for other hosts, Node, browser workers or UI.
The synthetic tight-loop is bulk-skipped in a few microseconds and is excluded
from practical speed claims. Mixed-fixture cycle rates also reflect different
TWI latency models, not equal completed transaction counts.

The release check passed 2,729 source tests, eight browser tests and packed
consumer checks. The four covered result fixtures still match avr8js and native
simavr with existing normalizations; native timing and Optiboot checks passed.
See [release preparation](evidence/release-0.1.2.md) and the refresh for exact
coverage. The historical source-revision samples remain in
[peripheral patch evidence](evidence/peripheral-performance.md); their old
mixed-fixture rate describes a halted tail, not continuous peripheral activity.

## What we learned (the important part)

1. **FastBlocks are avrts's unique weapon.** They *bulk-skip* busy-wait/delay/poll
   loops where avr8js simulates every iteration — that is why avrts wins ~2x on
   synthetic code and why the poll-wait block lifted dsp/isr/peripheral ~10%.
2. **Dispatch cost remains workload-specific.** avr8js uses one monolithic
   `avrInstruction()`; avrts combines a generated ladder with FastBlocks.
   In these comparisons both execute in Bun's JavaScriptCore. The current
   matrix, rather than a universal dispatch claim, determines which paths trail.
3. **Many hypothesized costs were measured to be dead ends** — settled, do not
   revisit: handler-fallback dispatch (monolithic core removed it → no production
   gain), `notifyCycles`, the `cycles` accessor, clock-event re-arm, decode-ladder
   *ordering* (~10% ceiling), and several block-JIT/bucketed-core prototypes
   (correct but slower — all reverted).
4. **The historical "real code loses at 0.20x" scare was a benchmark artifact** — co-running
   11 firmwares megamorphically deoptimized avrts. Production is one firmware per
   process (`--isolate`). The old ratios also included construction and should
   not be substituted for the refreshed execution-only sample.

## What's banked (current levers, done)

- **Lever A — cheaper per-instruction dispatch:** `readData`/`writeData`
  `length===1` fast path; `cycles` setter reshape (boolean `cycleExact`, inlined
  empty-listener check, scalar `nextEventAt` guard). Broad +5-12% floor-lift.
- **Lever B — poll-wait FastBlock:** collapses the analogRead `LDS;SBRC/SBRS;RJMP`
  busy-wait to the next clock-event boundary. dsp +10%, isr +9%, peripheral +11%.
- **Lever C — counted-loop FastBlock cleanup:** the existing shift-left counted
  loop now covers the 2-byte `ADD;ADC;DEC;BRNE` form seen in `string-heavy`; the
  `SBIW ...,1;BRNE` delay/countdown loop is batched under the same event/listener
  guards, including partial skips up to the next clock event for interrupt-heavy
  countdowns; and the generated ladder has a narrow guarded entry for SRAM
  `LD Z+; ST X+; AND; BRNE` string copies. The avr-libc `__utoa_common`
  `ADD;ADC;ADC;CP;BRCS;SUB;INC;SUBI;BRNE` bit loop is also recognized exactly.
  Float-math's avr-libc `__addsf3x` right-normalize
  `LSR;ROR;ROR;ROR;SBCI;INC;BRNE` loop is batched as `softfloat-right-inc`.
  Its hot `__fp_split3`/`__fp_splitA` no-branch exits are batched as
  `fp-split3-common` and `fp-splitA-common` while the rare branch exits still
  fall back to handlers. The fresh `float-math` profile shows
  `fp-split3-common` at 30,380 hits / 577,220 simulated cycles (11.5% of the
  sample), with the old split-helper instruction rows removed from the top table.
  After real USART timing exposed Arduino's `HardwareSerial::write` ring-buffer
  wait as the new `sensor-format` hotspot, `serial-buffer-wait` batches the exact
  `LDD Y+28; CPSE; RJMP; IN SREG; SBRC; RJMP -6` shape while preserving the same
  event/listener guards as the poll-wait block.
  A fresh `dsp-fixed` profile then picked the avr-libc signed multiply wrapper,
  so `mulhisi3` now batches the exact `CALL __umulhisi3; AND; BRPL; SUB/SBC; JMP;
  SBRS/RET; SUB/SBC; RET` shape while preserving the inner CALL/RET stack
  footprint. The post-change profile shows `mulhisi3` at 31,889 hits in the 5M
  cycle `dsp-fixed` sample, with the old wrapper `AND`/`BRPL`/`JMP`/tail rows
  removed from the top table.
  Profiles confirm these blocks remove hot rows; benchmark samples are noisy, so
  treat this as a profile-backed cleanup, not a new table-changing win yet.

## What remains (ranked by payoff)

1. **Small, low-risk — more FastBlocks.** Continue only from fresh
   `profile:opcodes --mode fast` evidence. Current candidates are helper-loop
   shapes that still rank in the real-code profiles, especially residual
   softfloat helper kernels, `__udivmodsi4` CFG rows, and branch-shaped helper
   loops that survive after the counted-loop cleanup. A few % each,
   fixture-specific. Same machinery as the poll-wait block.
   The old 2026-07-02 `sensor-format` non-canonical `__udivmodsi4` candidate is
   no longer the obvious next patch after `serial-buffer-wait`; the fresh fast
   profile leaves its `BRNE` at `0x052d` in the small tail (2,674 hits / 5,379
   cycles in a 5M-cycle sample). Re-profile before choosing the next block.
2. **Large optional architecture change — a translate-once region JIT.**
   This could reduce interpretation in hot arithmetic regions, but would need
   independent profiling, parity and throughput evidence. It is not required
   for workloads that already lead the current comparison. See next section.

## Optional direction: translate-once region JIT

A region JIT is a possible architecture change for hot arithmetic code. This
earlier proposal remains conditional on an explicit product goal and fresh
evidence; the benchmark refresh does not implement it. The design, including
two rejected naive slices:

**Why the naive versions failed (don't repeat):**
- Blocks that emit *handler calls* keep per-instruction dispatch → slower.
- Straight-line-only blocks miss the point: real hot regions are **branch-shaped
  loops** (`__udivmodsi4`, softfloat, DSP inner loops), not fall-through runs.

**The design that can work:**
1. **Hot-region selector.** Use `profileRun()` PC/back-edge counts to find loop
   headers above a threshold (`BRNE`/`BRCS`/`RJMP` back-edges). Seed with a known
   region (the `__udivmodsi4`/DSP/softfloat loops).
2. **Region IR.** A small CFG of basic blocks with explicit exits, per-block cycle
   cost, branch conditions, and touched registers. Stop at memory/IO/call/ret
   unless the semantics are single-sourced and parity-tested.
3. **Single-source semantics (critical).** Do **not** hand-copy flag math into
   `new Function` strings. Extend the instruction-description emitters that already
   feed the fast-core arms so the *same* source emits both the fast-core arm and
   the JIT block body. (The generated-CFG `__udivmodsi4` region is the working
   proof-of-concept of exactly this — generalizing it *is* the JIT.)
4. **Compile + cache.** `new Function` per hot region, cached by block-start PC;
   after the first compile a hot region pays dispatch *zero* times.
5. **Guard/bailout contract.** Compile only in fast timing, with no cycle
   listeners, no trace/breakpoint/unknown-opcode pause, no enabled pending
   interrupt, and no scheduled clock event inside the region's worst-case cycle
   window. Bail to `runGeneratedFastCore()` otherwise, and keep (or regenerate)
   the existing FastBlocks so `tight-loop`/`delay-blink` never regress.
6. **Validation gate.** First target: a generated `__udivmodsi4`/DSP-loop CFG
   compiler behind an opt-in flag. Must pass fixture parity vs `tick()`,
   `check:fast-core`, typecheck, and `bench:compare -- --repeats 5 --isolate`.
   Keep only if a real fixture crosses toward/over 1.0x with no synthetic
   regression.

**Effort & expectation:** large, multi-session, its own project. Throughput
benefits remain unproven and would need measurement on the intended workloads.
Pursue it **only if "beat avr8js on real compiled Arduino code" is an explicit
product goal**. Existing correctness and timing limits remain in
[limitations](limitations.md); realtime headroom is host- and workload-specific.

## Working rules (still apply)

- Change dispatch only in `scripts/generate-fast-core.ts`; `check:fast-core` gates
  freshness. Mirror `@Op`/`alu.ts` masks and flag math exactly — never re-derive.
- Every arm needs handler-parity tests; every FastBlock needs decline tests (fast
  timing only, no listeners/pending-interrupt, stop before the next clock event /
  run target).
- Profile first (`profile:opcodes --mode fast`); keep a change only if
  `bench:compare --isolate` is neutral-or-better. `--isolate` is mandatory for any
  real-code speed claim (the single-process default under-reports avrts ~3x).
