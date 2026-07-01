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

- Fixtures (in [`scripts/benchmark.ts`](../scripts/benchmark.ts)) — 11 total:
  synthetic `tight-loop`, `delay-blink`, `serial-print` (+ `serial-print-listener`),
  `analog-write`; and real compiled sketches `sensor-format`, `float-math`,
  `bitbang-crc`, `peripheral-mix`, `isr-heavy`, `string-heavy`, `dsp-fixed`.
- Harness: `bun run bench` (floors), `bun run bench:compare` (vs avr8js — pass
  `--isolate` for any real-code claim, see Methodology), `bun run bench:result`
  (final-state oracle vs avr8js for `peripheral-mix`/`isr-heavy`/`string-heavy`/
  `dsp-fixed`), `bun run profile:opcodes` (hot opcode / fast-block profile).
- Only external comparison today: **avr8js**.
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
  - Measured **0.61x**: cycles are spread thin across many soft-float kernels with
    no single dominant loop, so it is the fixture **least improvable** by FastBlock
    work — the clearest case that only the translate-once JIT could move it.
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

- [ ] **`peripheral-bound`** — high-baud USART + timer PWM + ADC sampling at once.
  - The bottleneck here is the **clock-event queue**, not the CPU. The CPU-bound
    fixtures never stress the scheduler under load.
- [ ] **Fidelity benchmark** — for each fixture, assert the **final state matches
  an oracle** (RAM + registers + serial output), not just speed. Catches
  correctness drift the speed numbers miss. (Oracle = avr8js and/or simavr; see
  Part B.)
- [x] **`peripheral-mix` result benchmark** — real compiled Arduino fixture for
  ADC input, Timer1 compare interrupt, PWM on D3/D5, GPIO input, and TWI/I2C
  master write/read. `bun run bench:result` compares avrts against avr8js by
  result SRAM, I2C transcript, and register summary.
- [ ] **Startup / construction cost** — isolate `Decoder` build + fixture-setup
  time, so it stops contaminating short-run throughput numbers (the repeated
  short-run noise seen during optimization).

---

## Part B — External comparison targets

There is **no second mature pure-JS AVR simulator** — avr8js is the only fair
JS-vs-JS peer; the other JS emulators are toys/abandoned and not worth wiring in.
The valuable external references are native simulators used as *ceilings* and
*oracles*, not as fair speed head-to-heads.

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
- [ ] **simavr (native) as an accuracy oracle.** Run the same `.hex` for the same
  cycle budget and diff final RAM / register file / serial output against avrts.
  This is a *correctness* gate, not a speed one — it catches fidelity bugs the
  speed benchmarks are blind to. Integration: shell out to a native `simavr` build
  in a separate (non-CI-blocking) script, or a one-off comparison harness.
- [ ] **simulavr / qemu-system-avr** — only if a third reference is ever needed to
  settle an accuracy dispute. High setup, low marginal value. Not recommended now.

---

## Part C — Methodology (keep the numbers honest)

- **`--isolate` is mandatory for real-code claims.** `bench:compare --isolate` runs
  one firmware per subprocess (fresh heap), which is how the simulator is used in
  production and keeps each fixture's hot methods monomorphic. The single-process
  default co-runs all 11 firmwares and **megamorphically deoptimizes avrts's shared
  hot path ~3x** (avr8js is nearly immune), so it under-reports real-code throughput
  badly. Use the default only for the synthetic/IO-bound fixtures, which are
  insensitive to the artifact. Every real-code ratio below is `--isolate`.
- **Steady-state, not setup.** Use cycle budgets large enough that fixture
  construction/startup is a small fraction (the compare harness already uses
  longer budgets and prints the budget per row). Report the budget.
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
2. **Add the simavr-WASM speed ceiling** (Part B). Gives the native-vs-JS gap that
   sizes the JIT/WASM upside.
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
- [x] Fix the `peripheral-mix` result mismatch (`bench:result`) so the mixed
  ADC/timer-interrupt/PWM/GPIO/I2C scenario matches avr8js.
- [ ] Decide whether the simavr-WASM ceiling is worth the one-time integration —
  it is iff "faster on real Arduino programs" is a real product goal.

## Recorded fixture evidence

`bench:compare --repeats 5 --isolate`, best-of-5, 16 MHz, 2026-07-01 — **after**
Lever A (dispatch) + Lever B (poll-wait FastBlock); see `performance-summary.md`.
A confirming second sample agreed within run-to-run noise (~4%). These supersede
the 2026-06-25 numbers, which were measured in the single-process regime and
under-reported real code ~3x (see Methodology).

| fixture         | avrts (cyc/s) | avr8js (cyc/s) | ratio | class |
| --------------- | ------------- | -------------- | ----- | ----- |
| tight-loop      | 178,413,087   | 92,641,143     | 1.93x | synthetic — FastBlock idle-skip |
| delay-blink     | 144,437,579   | 49,200,768     | 2.94x | synthetic — micros/subcmp blocks |
| serial-print    | 83,300,707    | 76,850,601     | 1.08x | IO-bound near-parity |
| analog-write    | 83,434,846    | 79,690,292     | 1.05x | IO-bound near-parity |
| peripheral-mix  | 84,914,873    | 58,924,811     | 1.44x | IO + poll-wait block |
| sensor-format   | 37,801,810    | 52,817,887     | 0.72x | real — Print/format + helper loops |
| dsp-fixed       | 39,300,421    | 54,653,231     | 0.72x | real — FIR/MAC; poll-wait + umulhisi3 |
| isr-heavy       | 35,382,199    | 47,639,918     | 0.74x | real — ISR churn + poll-wait |
| string-heavy    | 32,485,948    | 52,795,523     | 0.62x | real — String/format |
| float-math      | 25,744,346    | 41,988,509     | 0.61x | real — soft-float kernels |
| bitbang-crc     | 18,528,751    | 43,123,746     | 0.43x | real — bit-banged GPIO (hook-bound) |

Reading it: synthetic/IO fixtures win or hold parity (FastBlocks bulk-skip the idle
loops avr8js simulates); real compiled code trails at ~0.43-0.74x. Most real
fixtures are ~1.35-1.6x slower than avr8js, while `bitbang-crc` is the worst case
at ~2.3x slower. The current levers narrowed the gap, but they did not close it.
`float-math` (no dominant loop, pure soft-float) and `bitbang-crc` (structurally
GPIO-hook-bound) are the least improvable by dispatch/FastBlock work; the
arithmetic-bound fixtures would need the translate-once JIT to cross 1.0x.

Correctness: `bench:result` matches avr8js (result SRAM, serial output, I2C
transcript, register summary) for `peripheral-mix`, `isr-heavy`, `string-heavy`,
and `dsp-fixed`; the generated fast core matches the `tick()`/handler interpreter on
every fixture (457 tests green).
