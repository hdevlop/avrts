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

| class | fixtures | ratio vs avr8js |
| ----- | -------- | --------------- |
| synthetic / idle-dominated | tight-loop, delay-blink | **1.48-2.65x (win)** |
| IO-bound near-parity | serial-print, analog-write, peripheral-mix | 0.83-0.94x |
| real compiled code | sensor, dsp, isr, string, float, bitbang | **0.42-1.00x** |

Real-code throughput mostly still trails avr8js: arithmetic/string/ISR fixtures
sit around 0.42-0.68x, while `sensor-format` recovered to ~1.00x in the latest
isolated sample after the serial-buffer wait FastBlock. The recorded table is
faster than realtime on every fixture, but the weakest margin is `bitbang-crc`,
so realtime headroom is fixture-specific. 513 tests green; result oracles match
avr8js for the four `bench:result` fixtures, and `oracle:simavr:result` now
cross-checks the same matrix against native simavr with the documented
`peripheral-mix` timer-threshold and PORTD PWM-latch normalizations.
`oracle:simavr:timing` also covers calibrated USART/SPI/TWI polling delays.

## What we learned (the important part)

1. **FastBlocks are avrts's unique weapon.** They *bulk-skip* busy-wait/delay/poll
   loops where avr8js simulates every iteration — that is why avrts wins ~2x on
   synthetic code and why the poll-wait block lifted dsp/isr/peripheral ~10%.
2. **On straight-line real code it's a per-instruction dispatch race, and avrts
   loses it.** avr8js is one monolithic `avrInstruction()` that V8 optimizes as a
   whole; avrts pays per-opcode ladder/dispatch cost per instruction.
3. **Many hypothesized costs were measured to be dead ends** — settled, do not
   revisit: handler-fallback dispatch (monolithic core removed it → no production
   gain), `notifyCycles`, the `cycles` accessor, clock-event re-arm, decode-ladder
   *ordering* (~10% ceiling), and several block-JIT/bucketed-core prototypes
   (correct but slower — all reverted).
4. **The "real code loses at 0.20x" scare was a benchmark artifact** — co-running
   11 firmwares megamorphically deoptimized avrts. Production is one firmware per
   process (`--isolate`), where real code is ~0.55-0.74x, not ~0.20x.

## What's banked (current levers, done)

- **Lever A — cheaper per-instruction dispatch:** `readData`/`writeData`
  `length===1` fast path; `cycles` setter reshape (boolean `cycleExact`, inlined
  empty-listener check, scalar `nextEventAt` guard). Broad +5-12% floor-lift.
- **Lever B — poll-wait FastBlock:** collapses the analogRead `LDS;SBRC/SBRS;RJMP`
  busy-wait to the next clock-event boundary. dsp +10%, isr +9%, peripheral +11%.
- **Lever C — counted-loop FastBlock cleanup:** the existing shift-left counted
  loop now covers the 2-byte `ADD;ADC;DEC;BRNE` form seen in `string-heavy`; the
  `SBIW ...,1;BRNE` delay/countdown loop is batched under the same event/listener
  guards; and the generated ladder has a narrow guarded entry for SRAM
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
2. **Big, the only real path to BEAT avr8js — a translate-once region JIT.**
   Everything else is interpretation; the only way to do *less work per executed
   instruction* than avr8js on real code is to stop interpreting hot regions. See
   next section.

## The path to beat avr8js: translate-once region JIT

Beating avr8js on *real* code is not an interpreter-tuning problem — it is an
architecture change. The plan (distilled from an earlier JIT design pass, including two rejected naive
slices):

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

**Effort & expectation:** large, multi-session, its own project. It is the only
lever with a real shot at >1.0x on arithmetic-bound real code (dsp FIR, softfloat).
Pursue it **only if "beat avr8js on real compiled Arduino code" is an explicit
product goal** — the engine is already correct, well-tested, and faster than
realtime without it.

## Working rules (still apply)

- Change dispatch only in `scripts/generate-fast-core.ts`; `check:fast-core` gates
  freshness. Mirror `@Op`/`alu.ts` masks and flag math exactly — never re-derive.
- Every arm needs handler-parity tests; every FastBlock needs decline tests (fast
  timing only, no listeners/pending-interrupt, stop before the next clock event /
  run target).
- Profile first (`profile:opcodes --mode fast`); keep a change only if
  `bench:compare --isolate` is neutral-or-better. `--isolate` is mandatory for any
  real-code speed claim (the single-process default under-reports avrts ~3x).
