# Benchmark Plan (internal workloads + external simulators)

Companion to [`performance-summary.md`](performance-summary.md). That doc says
*what* to optimize and why; this doc says *what to measure it against* — both the
internal workload fixtures avrts runs and the external simulators to compare with.

## Why this exists

The four original fixtures are synthetic (busy-wait / delay loops) and are
**bulk-skipped** by FastBlocks, so they flatter the engine. `sensor-format` (a real
sketch) already showed the wins don't generalize. The point of this plan is to
**stop guessing**: add fixtures whose instruction mixes are *distinct* (each one
reveals something the others can't), and add external references so "fast" and
"correct" are both measured against something real.

## Current state

- Internal fixtures (in [`scripts/benchmark.ts`](../scripts/benchmark.ts)) — 12:
  `tight-loop`, `delay-blink`, `serial-print`, `serial-print-listener`,
  `analog-write`, `sensor-format`, `float-math`, `bitbang-crc`, `isr-heavy`,
  `string-heavy`, `dsp-fixed`, `peripheral-bound`. The external comparison also
  has 12 workloads: it uses `peripheral-mix` instead of `serial-print-listener`.
- Harness: `bun run bench` (floors), `bun run bench:compare` (vs avr8js — pass
  `--isolate` for any real-code claim, see Methodology), `bun run bench:result`
  (defaults to all final-state oracle scenarios vs avr8js:
  `peripheral-mix`/`isr-heavy`/`string-heavy`/`dsp-fixed`/`peripheral-bound`;
  use `--case` for one),
  `bun run profile:opcodes` (hot opcode / fast-block profile).
- Local fixture toolchains verified on 2026-07-01: vendored `./avr-gcc/bin`
  (`avr-gcc` 15.2.0) and Arduino IDE bundled `arduino-cli` 1.5.1 with
  `arduino:avr` 1.8.8.
  The 2026-10-06 mixed fixture was rebuilt with the installed Arduino AVR 1.8.8
  core and its AVR GCC 7.3.0 toolchain; the formerly bundled CLI was unavailable.
- Native simavr installed locally on 2026-07-02 and exposed through
  `bun run oracle:simavr`, which compiles/runs a tiny state-dump helper against
  the local simavr library. `bun run oracle:simavr:compare` performs a normalized
  avrts comparison for a simple firmware path (cycles, PC, SP, R0-R31, and SREG
  with the interrupt-enable bit masked by default). `bun run oracle:simavr:result`
  runs the five result fixtures against native simavr and avrts. The result oracle
  compares result SRAM, selected registers, serial output, and TWI transcripts;
  `peripheral-mix` normalizes its old timer-threshold byte because timed TWI
  makes that threshold engine-dependent, and normalizes the PORTD PWM latch byte
  because simavr keeps timer-driven OC0B state separate from the PORTD latch
  while avrts/avr8js expose that bit in the latch. `bun run oracle:simavr:timing`
  covers USART/SPI/TWI polling timing and calibrates the AVR-visible USART TXC0,
  USART RXC0/data arrival, SPI master `SPIF`, SPI slave receive/SPIF, Timer2
  async 32.768 kHz drift, and TWI START/STOP delays. USART DOR0 status is
  normalized in that native oracle because simavr's UART input IRQ has a
  64-byte host FIFO rather than the ATmega328P two-byte receive-buffer overrun
  path; avrts keeps DOR0 covered in focused Bun tests. SPI slave host-output
  bytes are normalized because simavr's SPI input IRQ echoes the injected byte
  instead of the preloaded slave `SPDR`; the oracle still compares the
  firmware-visible receive/SPIF result block.
- Only external speed comparison today: **avr8js**. Native simavr is wired as a
  local accuracy oracle, not a speed peer.
- Latest measured results are in [Recorded fixture evidence](#recorded-fixture-evidence)
  below; the strategy behind them is in [`performance-summary.md`](performance-summary.md).

---

## Part A — Internal workload fixtures

Each fixture must target a **distinct** instruction mix, or it adds noise, not
signal. Add a fixture only with a one-line note on what it stresses that the
others don't. Adding one means: drop a compiled `.ino.hex` in `examples/`, add an
entry to `createBenchmarkCases()` for `bench` and `profile:opcodes`, add a matching
entry to `scripts/benchmark-compare.ts`'s `WORKLOADS` for avr8js comparison, and
wire `bench:result` only when the fixture has a useful final-state oracle.

Priority order (highest signal first):

- [x] **`float-math`** — `float` ops (`sin`/`cos`/`sqrt`/`*`/`/`).
  - Stresses: avr-libc **soft-float** routines (AVR has no FPU) — large, branchy
    helper loops.
  - Measured **0.61x** before the latest split-helper cleanup: cycles are spread
    across many soft-float kernels, so FastBlocks can remove specific hot rows but
    should still be treated as profile-backed cleanup rather than a guaranteed
    table-changing win. The latest `fp-split3-common` profile row is 30,380 hits /
    577,220 simulated cycles (11.5% of the sample).
- [x] **`bitbang-crc`** — software SPI/I2C bit-banging + CRC8/CRC16 over a buffer.
  - Stresses: logic ops (`AND`/`OR`/`EOR`), shifts, and `IN`/`OUT` port toggling.
  - Measured **0.43x** (the worst real fixture): it is **structurally GPIO-hook-
    bound** — every bit-bang goes through the `readData`/`writeData` hook path — so
    it is hook-limited by nature and will not reach parity by dispatch/FastBlock work.
- [x] **`isr-heavy`** — software PWM / frequency counter / servo timing with
  frequent timer or pin-change interrupts.
  - Stresses: ISR prologue/epilogue (`PUSH`/`POP`/`RETI`), frequent interrupt
    dispatch, and the clock-event scheduler under interrupt churn.
  - Reveals: a path the synthetic fixtures barely touch; very common in firmware.
- [x] **`dsp-fixed`** — FIR filter / fixed-point math / PROGMEM-table interpolation.
  - Stresses: `MUL`/MAC loops, `LDD`/`STD` (displacement memory), `LPM`.
  - Reveals: multiply + displacement-memory mix (complements `sensor-format`'s
    divide-heavy mix).
- [x] **`string-heavy`** — `String` class / `sprintf` / parsing.
  - Stresses: `Print::write`, number→string division, `memcpy`, malloc/heap.
  - Reveals: the other half of real I/O code beyond `Serial.print(int)`.

Accept criteria for each new fixture: it lands with (a) a profiled hot-opcode
table showing it exercises a *different* mix, and (b) a recorded `bench:compare`
ratio. If two fixtures profile nearly identically, drop one.

### Different axis (not cycles/sec)

- [x] **`peripheral-bound`** — 1 Mbaud USART interrupts + two 62.5 kHz PWM outputs
  + interrupt-driven ADC sampling, with Idle wake-ups and continuous batches.
  - Stresses peripheral scheduling, ISR entry/return and output delivery together;
    it is not a pure queue microbenchmark because the ISR instructions also cost.
  - [Evidence](evidence/peripheral-bound.md): 0.98x vs avr8js on the measured host,
    raw post-warm-up byte/PWM counts, fast/cycle-exact activity/shutdown tests,
    and unnormalized final-state comparison at five ADC inputs against both peers.
- [ ] **Fidelity benchmark** — for each fixture, assert the **final state matches
  an oracle** (RAM + registers + serial output), not just speed. Catches
  correctness drift the speed numbers miss. (Oracle = avr8js and/or simavr; see
  Part B.)
- [x] **`peripheral-mix` result benchmark** — real compiled Arduino fixture for
  ADC input, Timer1 compare interrupt, PWM on D3/D5, GPIO input, and TWI/I2C
  master write/read. `bun run bench:result` compares avrts against avr8js by
  result SRAM, I2C transcript, and register summary.
- [x] **Startup / construction cost** — isolate `Decoder` build + fixture-setup
  time, so it stops contaminating short-run throughput numbers (the repeated
  short-run noise seen during optimization). `bun run bench:startup` now reports
  per-fixture construction best/average times; a 20-repeat sample on 2026-07-01
  showed best construction times around 56-62 ms across the current fixture set.

---

## Part B — External comparison targets

avr8js is the installed JavaScript peer used by this comparison. Native simavr
supplies an independent accuracy reference. WASM and additional native targets
below remain proposed options, separate from the installed speed harness.

| Target | Runtime | Role | Effort |
|---|---|---|---|
| **avr8js** | JS/TS | **Fair speed competitor** (keep as primary) | done |
| **simavr (WASM)** | C → WASM | **Speed ceiling** in the same browser runtime | medium |
| **simavr (native)** | C | **Accuracy oracle** (final-state cross-check) | medium |
| **simulavr / qemu-avr** | C/C++ | Optional extra accuracy reference | high, low value |

- [x] **avr8js** — already the primary `bench:compare` target. Keep it.
- [ ] **simavr → WASM speed ceiling.** The single most *strategically valuable*
  addition: it answers the one question avr8js can't — **how far is interpreted
  JS from native logic running in the same environment?** That gap is the upside
  ceiling for the JIT/WASM path and directly informs the
  translate-once JIT (the "beat avr8js on real code") decision in `performance-summary.md`.
  - Integration: build a WASM module from simavr, feed it the same `.hex`, run N
    cycles, read back cycles/sec. Wrap behind a `bench:compare --target=simavr-wasm`
    flag alongside the avr8js path.
  - Current decision: out of scope while the translate-once JIT / WASM speed-ceiling
    path is explicitly not being pursued.
- [x] **simavr (native) installed + state-dump harness.** `bun run oracle:simavr`
  builds a small helper against the local simavr library, runs a HEX for a fixed
  cycle budget, and dumps registers/RAM slices as JSON. This proves the native
  oracle surface is usable without making CI depend on MSYS2.
- [x] **simavr normalized avrts smoke comparison.** `bun run oracle:simavr:compare`
  compares a simple firmware run against avrts for normalized core state. Raw
  peripheral I/O byte comparison remains opt-in (`--compare-dump`) because simavr
  and avrts intentionally differ in some input-latch/default-peripheral details.
- [x] **simavr (native) as a full accuracy oracle.** Run the same `.hex` for the same
  cycle budget and diff final RAM / register file / serial output against avrts.
  This is a *correctness* gate, not a speed one — it catches fidelity bugs the
  speed benchmarks are blind to. `bun run oracle:simavr:result` now covers
  `peripheral-mix`, `isr-heavy`, `string-heavy`, `dsp-fixed`, and `peripheral-bound`
  via the native helper, with the documented `peripheral-mix` timer-threshold and PORTD
  PWM-latch normalizations.
- [x] **simavr native peripheral-timing oracle.** `bun run oracle:simavr:timing`
  runs avr-libc fixtures that poll USART `TXC0`/`RXC0`, SPI master `SPIF`,
  SPI slave receive/SPIF, Timer2 async 32.768 kHz drift, and TWI
  `TWINT`/`TWSTO`, then compare calibrated timing bytes, serial output, RX data,
  SPI slave result blocks, Timer2 snapshots, and TWI transcripts against avrts.
  DOR0 and SPI slave host-output bytes are reported but normalized for the
  native simavr limitations described above.
- [ ] **simulavr / qemu-system-avr** — only if a third reference is ever needed to
  settle an accuracy dispute. High setup, low marginal value. Not recommended now.

---

## Part C — Methodology (keep the numbers honest)

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
  Pair every throughput fixture with a final-state oracle check (Part B).

---

## Part D — Recommended phasing

1. **Add `float-math` + `bitbang-crc`** (Part A top two). *Done* — between them they
   cover two big real costs (soft-float helpers, bit-banged GPIO) and confirmed the
   remaining gap is not dispatch/decode but soft-float volume and IO-hook cost.
2. **Skip the simavr-WASM speed ceiling unless the JIT/WASM path is re-opened**
   (Part B). It mainly sizes the native-vs-JS upside for the excluded big path.
3. **Add the simavr-native accuracy oracle** + a fidelity check across all
   fixtures. Locks correctness independent of speed.
4. **Add the remaining workload fixtures** (`isr-heavy`, `dsp-fixed`,
   `string-heavy`, `peripheral-bound`) only as needed to back specific claims.

## Immediate next actions

- [x] Write/compile a `float-math` sketch; wire into `createBenchmarkCases()`;
  record profile + `bench:compare`.
- [x] Write/compile a `bitbang-crc` sketch; same.
- [x] Write/compile an `isr-heavy` sketch; wire into result comparison,
  benchmark/profile harnesses, and `bench:compare`.
- [x] Write/compile a `string-heavy` sketch; wire into result comparison,
  benchmark/profile harnesses, and `bench:compare`.
- [x] Write/compile a `dsp-fixed` sketch; wire into result comparison,
  benchmark/profile harnesses, and `bench:compare`.
- [x] Write/compile a `peripheral-bound` sketch; wire into benchmark/profile,
  startup/revision/external harnesses and both default result-oracle matrices.
  Record profile, throughput and actual activity after warm-up.
- [x] Fix the `peripheral-mix` result mismatch (`bench:result`) so the mixed
  ADC/timer-interrupt/PWM/GPIO/I2C scenario matches avr8js.
- [x] Make `bench:result` run every covered result-oracle scenario by default
  (`peripheral-mix`, `isr-heavy`, `string-heavy`, `dsp-fixed`, `peripheral-bound`) while keeping
  `--case` for focused checks.
- [x] Install/build native simavr locally and add `oracle:simavr` smoke/state-dump
  harness.
- [x] Add `oracle:simavr:compare` normalized smoke comparison against avrts.
- [x] Add `oracle:simavr:result` native simavr result-oracle matrix for
  `peripheral-mix`, `isr-heavy`, `string-heavy`, `dsp-fixed`, and `peripheral-bound`.
- [x] Decide whether the simavr-WASM ceiling is worth the one-time integration —
  not for the current non-JIT track; re-open only if "faster on real Arduino
  programs" becomes an explicit product goal.

## Recorded fixture evidence

### Current 2026-10-06 comparison

The subsequent [peripheral event workload](evidence/peripheral-bound.md) adds
the twelfth fixture and fifth result oracle. A separate isolated five-trial
sample measured 25.02 vs 25.58 Mcycles/s (0.98x), with continuous USART/PWM
activity and exact final-state output at five ADC inputs in both references.

[The execution-only refresh](evidence/benchmark-comparison-refresh.md) uses five
trials, 50 million measured cycles per workload/engine, explicit warm-up and
isolated processes. It records the corrected continuous mixed fixture, matching
TWI environment and [raw JSON samples](evidence/benchmark-comparison-2026-10-06.json).
Seven of ten nontrivial workloads lead avr8js on this host; float-math,
bitbang-crc and delay-blink trail. The synthetic tight-loop is bulk-skipped and
excluded from practical speed claims. Covered result oracles still pass.

The July samples below are historical. Their comparison included construction,
used shorter budgets without explicit warm-up, and did not supply the corrected
mixed-peripheral environment. They are retained for context and must not be
treated as current steady-state rates or source speedup baselines.

### Historical 2026-07-13 sample

`bench:compare --repeats 3 --isolate`, best-of-3, 16 MHz, 2026-07-13 Windows
release-review run; see `performance-summary.md`.

| fixture         | avrts (cyc/s) | avr8js (cyc/s) | ratio | class |
| --------------- | ------------- | -------------- | ----- | ----- |
| tight-loop      | 169,293,251   | 90,897,274     | 1.86x | synthetic - FastBlock idle-skip |
| delay-blink     | 45,182,024    | 48,868,699     | 0.92x | synthetic - micros/subcmp blocks |
| serial-print    | 57,944,948    | 72,576,103     | 0.80x | IO-bound |
| analog-write    | 51,630,224    | 78,689,722     | 0.66x | IO-bound |
| peripheral-mix  | 61,128,506    | 58,776,577     | 1.04x | IO + timed peripherals |
| sensor-format   | 28,466,833    | 52,460,227     | 0.54x | real - formatting + timed serial |
| float-math      | 18,904,213    | 42,006,358     | 0.45x | real - soft-float kernels |
| bitbang-crc     | 15,449,365    | 44,295,729     | 0.35x | real - bit-banged GPIO (hook-bound) |
| isr-heavy       | 35,076,126    | 47,602,545     | 0.74x | real - ISR churn + poll-wait |
| string-heavy    | 25,309,856    | 53,105,786     | 0.48x | real - String/format |
| dsp-fixed       | 25,666,771    | 55,252,831     | 0.46x | real - FIR/MAC; poll-wait + umulhisi3 |

Reading the active sample: performance is host- and workload-dependent.
`tight-loop` and `peripheral-mix` win, while the remaining workloads trail
avr8js. Ten fixtures exceed 16M cycles/s in this matrix; `bitbang-crc` does not.
A focused `--case bitbang-crc --repeats 10 --isolate` run measured 13,112,962
cycles/s versus avr8js at 40,177,004 cycles/s (0.33x), confirming that the
README must not make a blanket realtime claim.

Latest small slice: real USART timing made Arduino `HardwareSerial::write`'s
TX ring-buffer wait (`0x0249..0x024e` in `sensor-format`) dominate the PC
profile. The new `serial-buffer-wait` FastBlock removes that row from the fast
profile; the old non-canonical `__udivmodsi4` candidate is now only tail noise
in the fresh fast profile and should be re-evaluated before any patch.

Previous sample:

`bench:compare --repeats 5 --isolate`, best-of-5, 16 MHz, 2026-07-01 — **after**
Lever A (dispatch), Lever B (poll-wait FastBlock), and the current Lever C
FastBlock cleanup through `fp-split3-common`; see `performance-summary.md`.
These supersede the 2026-06-25 numbers, which were measured in the single-process
regime and under-reported real code ~3x (see Methodology).

| fixture         | avrts (cyc/s) | avr8js (cyc/s) | ratio | class |
| --------------- | ------------- | -------------- | ----- | ----- |
| tight-loop      | 156,007,944   | 90,058,205     | 1.73x | synthetic — FastBlock idle-skip |
| delay-blink     | 142,325,294   | 51,228,206     | 2.78x | synthetic — micros/subcmp blocks |
| serial-print    | 82,362,011    | 77,456,094     | 1.06x | IO-bound near-parity |
| analog-write    | 76,503,836    | 80,070,334     | 0.96x | IO-bound near-parity |
| peripheral-mix  | 78,954,391    | 59,787,301     | 1.32x | IO + poll-wait block |
| sensor-format   | 37,467,553    | 53,152,699     | 0.70x | real — Print/format + helper loops |
| dsp-fixed       | 37,952,709    | 55,141,322     | 0.69x | real — FIR/MAC; poll-wait + umulhisi3 |
| isr-heavy       | 34,108,343    | 47,582,160     | 0.72x | real — ISR churn + poll-wait |
| string-heavy    | 27,782,254    | 52,143,570     | 0.53x | real — String/format |
| float-math      | 27,971,167    | 42,654,801     | 0.66x | real — soft-float kernels |
| bitbang-crc     | 17,463,052    | 42,627,854     | 0.41x | real — bit-banged GPIO (hook-bound) |

Reading it: synthetic/IO fixtures win or hold parity (FastBlocks bulk-skip the idle
loops avr8js simulates); real compiled code trails at ~0.41-0.72x. Most real
fixtures are ~1.4-1.9x slower than avr8js, while `bitbang-crc` is the worst case
at ~2.4x slower. The current levers narrowed the gap, but they did not close it.
`float-math` can still absorb small helper-specific FastBlocks, but its work is
spread across many soft-float kernels; `bitbang-crc` is structurally
GPIO-hook-bound. The arithmetic-bound fixtures would need the translate-once JIT
to cross 1.0x.

Correctness, verified 2026-07-03:

- `bun run bench:result` matches avr8js (result SRAM, serial output, I2C
  transcript, register summary) for `peripheral-mix`, `isr-heavy`, `string-heavy`,
  and `dsp-fixed`.
- `bun run oracle:simavr:result` matches native simavr against avrts for the same
  four fixtures. The `peripheral-mix` check passes with the documented
  timer-threshold and PORTD PWM latch normalizations; timed TWI makes the old
  `timerTicks <= 120` byte engine-dependent, and simavr keeps timer-driven OC0B
  separate from the PORTD latch while avrts/avr8js expose that bit in the latch.

  | fixture | simavr cycles | avrts cycles | simavr result SRAM | avrts result SRAM | serial | TWI | status |
  | --- | ---: | ---: | --- | --- | ---: | --- | --- |
  | `peripheral-mix` | 49,232 | 70,004 | `a7 0c 00 18 01 01 01 70 bd 47 8f 70 00 21 23 4b f8 00 02 01 5c` | `a7 0c 00 18 01 01 00 70 bd 47 8f 70 20 21 23 4b f8 00 02 01 5c` | 0 bytes | starts=24 writes=48 reads=12 stops=12 | PASS with timer-threshold + PORTD bytes normalized |
  | `isr-heavy` | 28,045 | 50,001 | `a7 10 00 20 01 01 01 0f e3 17 07 ee 11 10 01 03 02 00 02 01 5c` | `a7 10 00 20 01 01 01 0f e3 17 07 ee 11 10 01 03 02 00 02 01 5c` | 0 bytes | starts=0 writes=0 reads=0 stops=0 | PASS |
  | `string-heavy` | 766,331 | 770,012 | `a7 08 00 10 00 00 10 01 09 06 0b 72 30 01 00 02 00 04 00 01 5c` | `a7 08 00 10 00 00 10 01 09 06 0b 72 30 01 00 02 00 04 00 01 5c` | 232 bytes | starts=0 writes=0 reads=0 stops=0 | PASS |
  | `dsp-fixed` | 58,052 | 100,007 | `a7 18 00 30 a6 c4 f8 ff ff 00 00 00 00 fe 01 00 02 00 01 08 5c` | `a7 18 00 30 a6 c4 f8 ff ff 00 00 00 00 fe 01 00 02 00 01 08 5c` | 0 bytes | starts=0 writes=0 reads=0 stops=0 | PASS |
- `bun run oracle:simavr:compare` passes the normalized native-state smoke check.
- `bun run check:fast-core`, `bun run typecheck`, and `bun test` passed in that
  historical check; its full test run was 513 pass / 0 fail. Current source,
  browser and package evidence is in [0.1.2 preparation](evidence/release-0.1.2.md).
