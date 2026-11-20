# avrts Performance

The single source of truth for avrts performance. It folds in the earlier
performance docs — the original FastBlock/generated-core arc, the concluded
monolithic-core experiment, and the real-code dispatch + FastBlock levers — which
have been consolidated here and removed. (The benchmark harness / external-simulator
methodology is in [Benchmark methodology](#benchmark-methodology) below.)

Status: dated measurements and optimization rationale. Open work is listed in
[limitations](limitations.md#open-work) and release obligations in
[RELEASING.md](../RELEASING.md).

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

`serial-print` emits one startup line and then loops idle; its measured
post-warmup cycle rate does not establish continuous UART throughput.
`analog-write` has an idle foreground with active hardware PWM. The IO/peripheral
row groups different activity patterns; see the
[workload activity notes](#workload-activity)
for interpretation and outstanding result checks. The recorded ratios remain
unchanged; this qualification narrows what they support.

Seven of the ten nontrivial workloads lead the peer in cycle rate on this host;
all ten measure over 16M cycles/s, with bit-banging closest at 18.84M. This is
not a blanket realtime guarantee for other hosts, Node, browser workers or UI.
The synthetic tight-loop is bulk-skipped in a few microseconds and is excluded
from practical speed claims. Mixed-fixture cycle rates also reflect different
TWI latency models, not equal completed transaction counts.

The subsequent [peripheral event workload](evidence/peripheral-bound.md) adds
continuous high-baud USART, hardware PWM and ADC interrupts with Idle wake-ups.
Its separate best-of-five comparison measured 25.02 vs 25.58 Mcycles/s (0.98x),
with actual post-warm-up serial/PWM counts retained. Its construction-inclusive
internal rate was 13.00 Mcycles/s; the two methods are not interchangeable.

The release check passed 2,743 source tests, eight browser tests and packed
consumer checks. Eight covered result fixtures now match avr8js and native
simavr with existing normalizations; native timing and Optiboot checks passed.
The [arithmetic oracle follow-up](evidence/arithmetic-results-2026-10-06.md) adds
float/bit-bang result checks and rebuilds those two fixtures. The
[sensor-format follow-up](evidence/sensor-format-results-2026-10-10.md) adds the
eighth result case and rebuilds its image. The speed ratios above remain
measurements of the preceding images, not fresh ratios for the rebuilt ones; the follow-up does not change emulator library code.
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

## October 10 completion record

All twelve external workload result/state cases and the shared listener check
are implemented; see [current workload evidence](evidence/workload-results-2026-10-10.md).
New EEPROM/flash programming and T0/T1 clock fidelity is covered by
[runtime evidence](evidence/runtime-fidelity-2026-10-10.md).
The [scope decisions](evidence/calibration-scope-2026-10-10.md) describe the
earlier wire-model deferral. The digital extensions are now implemented;
[expanded acceptance](evidence/digital-models-2026-10-10.md) records their source
and narrow before/after performance comparisons. Physical calibration remains
unrun. Earlier measurements above remain
dated history; [current performance evidence](evidence/runtime-performance-2026-10-10.md)
uses identical candidate firmware on both revisions.

## Benchmark methodology

Moved here from the benchmark plan (removed 2026-11-20; its text is in git history at `f17ba76`), which also holds its per-fixture
history. Measurements live in the [evidence](evidence/) records.

### Workload activity

| Coverage | Workloads |
| --- | --- |
| Result comparisons against both avr8js and native simavr | `peripheral-mix`, `isr-heavy`, `string-heavy`, `dsp-fixed`, `peripheral-bound`, `float-math`, `bitbang-crc`, `sensor-format` |
| Additional completed result/state/waveform comparisons | `serial-print`, `analog-write`, `delay-blink`, `tight-loop` |
| Shared-fixture delivery check completed | `serial-print-listener`, in fast and cycle-exact modes |

The [arithmetic oracle slice](evidence/arithmetic-results-2026-10-06.md) covers
32 float iterations and 32 bit-banged transfers, expected output bytes and both
clock-edge counts, with four input patterns and no new normalizations. The
[sensor-format slice](evidence/sensor-format-results-2026-10-10.md) adds complete
history, exact UART output, counter wrap and PWM endpoints at five starting
indices, also without new normalizations. The [completion batch](evidence/workload-results-2026-10-10.md) adds the four remaining cases and shared listener check. All twelve external fixtures now have result/state checks. Native phase-correct PWM GPIO traces remain explicitly unsupported in this build; SRAM/configuration still compare and both JS engines check all five waveforms.

The current `serial-print` sketch prints `hello avrts` once at startup and then
has an empty loop. Its listener variant uses the same sketch. After warmup,
the timed region may contain only idle foreground/timer work, so neither rate
establishes sustained USART transmission or listener delivery throughput.
`analog-write` also has an empty loop, but its five hardware PWM outputs remain
active; its appropriate fidelity check observes waveforms and timer state.
The mixed and peripheral-bound fixtures run continuous batches in speed mode.
Keep these activity classifications alongside any ratio, and add a separately
named continuous serial fixture if sustained UART work is needed.

### Fixtures and toolchains (2026-10-06)

The vendored AVR compiler, installed Arduino AVR 1.8.8 core and its AVR GCC
7.3.0 tools, and local MSYS2 compiler/simavr headers and static library are
present. This is a file-availability check, not a rebuild or a native test run.
The October fixture build used that core/toolchain with cached Uno core objects
because Arduino CLI was unavailable; see the
[fixture build record](../examples/arduino-peripheral-bound/README.md).

Normal `bun run fixtures:arduino` regeneration requires a working Arduino CLI
and installed Uno board core; `ARDUINO_CLI` can select the CLI. Both fixture
scripts accept `AVR_GCC_BIN` for compiler/binutils selection. Native probes
accept `SIMAVR_PREFIX` and `SIMAVR_CC`; the Windows harness uses local MSYS2
bash when available. The existing CI does not provision these native dependencies.
Committed HEX files let ordinary source/package tests run without rebuilding
fixtures. Record the actual compiler flags and artifact digests on regeneration.

### Adding a fixture

Each fixture must target a **distinct** instruction mix, or it adds noise, not
signal. Add a fixture only with a one-line note on what it stresses that the
others don't. Adding one means: drop a compiled `.ino.hex` in `examples/`, add an
entry to `createBenchmarkCases()` for `bench` and `profile:opcodes`, add a matching
entry to `scripts/benchmark-compare.ts`'s `WORKLOADS` for avr8js comparison, and
wire `bench:result` only when the fixture has a useful final-state oracle.

Accept criteria for each new fixture: it lands with (a) a profiled hot-opcode
table showing it exercises a *different* mix, and (b) a recorded `bench:compare`
ratio. If two fixtures profile nearly identically, drop one.

### Measuring (keep the numbers honest)

- **`--isolate` is mandatory for real-code claims.** `bench:compare --isolate` runs
  one firmware per subprocess (fresh heap), which is how the simulator is used in
  production and keeps each fixture's hot methods monomorphic. The single-process
  default co-runs all firmwares and **megamorphically deoptimizes avrts's shared
  hot path ~3x** (avr8js is nearly immune), so it under-reports real-code throughput
  badly. Use the default only for the synthetic/IO-bound fixtures, which are
  insensitive to the artifact. Every real-code ratio below is `--isolate`.
- **Steady-state, not setup.** Use cycle budgets large enough that fixture
  startup is a small fraction. The comparison now excludes construction and
  runs 500,000 warm-up cycles per trial by default (`--warmup-cycles` overrides
  it). Raw samples separately record construction time and actual simulated
  cycles; `--output FILE` saves JSON and `--json` prints it. `bun run bench`
  remains a construction-inclusive regression floor; `bench:startup` separately
  measures construction. Their rates are not interchangeable.
- **Hold firmware constant across revisions.** `bench:revision` loads the
  candidate checkout's HEX for both engines and records `fixtureRoot` in JSON.
  Fixture rebuilds must not turn an emulator comparison into different programs.
- **Exercise the same environment and keep work active.** The comparison gives
  both engines ADC raw 512, D2 high and the same ACKing TWI slave. Continuous
  `peripheral-mix` resets its round accumulators; result runners select halt
  mode with SRAM `0x02ff=0x42`. Per-sample TWI STOP counts verify that measured
  execution still completes bus work after warm-up. Earlier mixed-fixture
  speed runs included a halted tail; the avr8js speed runner also omitted TWI.
  Those rates do not establish mixed-peripheral throughput.
- **Noise.** Throughput is machine-load sensitive — a uniform dip across *all*
  fixtures is load, not a regression. Use `--repeats 5` (best-of-N) and re-run
  before believing a drop. A real regression hits *specific* fixtures.
- **Cycle% ≠ host-time%.** The profiler attributes *simulated AVR cycles*, which
  is a proxy for host time, not host time itself. A row that's 14% of cycles can
  be more or less than 14% of host time depending on what those instructions do.
  Treat cycle% as a ranking hint, then confirm with `bench:compare`.
- **Profile first.** Start every optimization slice from
  `profile:opcodes --mode fast`; keep a patch only if `bench:compare` is
  neutral-or-better on the full mix.
- **Measure speed *and* fidelity.** A speed win that changes output is a bug.
  Pair every throughput fixture with a final-state oracle check (see comparison targets below).

### Comparison targets

- **avr8js** (JS/TS) is the fair speed competitor and the primary `bench:compare` target.
- **Native simavr** is the accuracy oracle: `oracle:simavr` dumps state,
  `oracle:simavr:compare` checks normalized core state, `oracle:simavr:result` compares
  result RAM, registers and serial output for the result fixtures, and
  `oracle:simavr:timing` compares peripheral timing.
- Not pursued: a general fidelity benchmark (every speed fixture paired with a
  final-state oracle check); a simavr-to-WASM speed ceiling, out of scope while the
  translate-once JIT / WASM path is not being pursued; and simulavr or qemu-system-avr,
  only worth adding to settle an accuracy dispute.
