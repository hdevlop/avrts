# Benchmark Plan (internal workloads + external simulators)

Companion to [`performance-plan.md`](performance-plan.md). That doc says *what* to
optimize and why; this doc says *what to measure it against* — both the internal
workload fixtures avrts runs and the external simulators to compare with.

## Why this exists

The four original fixtures are synthetic (busy-wait / delay loops) and are
**bulk-skipped** by FastBlocks, so they flatter the engine. `sensor-format` (a real
sketch) already showed the wins don't generalize. The point of this plan is to
**stop guessing**: add fixtures whose instruction mixes are *distinct* (each one
reveals something the others can't), and add external references so "fast" and
"correct" are both measured against something real.

## Current state

- Fixtures (in [`scripts/benchmark.ts`](../scripts/benchmark.ts)): `tight-loop`,
  `delay-blink`, `serial-print`, `serial-print-listener`, `analog-write` (all
  synthetic), plus `sensor-format`, `float-math`, and `bitbang-crc` (real).
- Harness: `bun run bench` (floors), `bun run bench:compare` (vs avr8js),
  `bun run profile:opcodes` (hot opcode / fast-block profile).
- Only external comparison today: **avr8js**.

---

## Part A — Internal workload fixtures

Each fixture must target a **distinct** instruction mix, or it adds noise, not
signal. Add a fixture only with a one-line note on what it stresses that the
others don't. (Adding one is cheap: drop a compiled `.ino.hex` in `examples/`, add
an entry to `createBenchmarkCases()`; it flows into `bench`, `bench:compare`, and
`profile:opcodes` automatically — same as `sensor-format`.)

Priority order (highest signal first):

- [x] **`float-math`** — `float` ops (`sin`/`cos`/`sqrt`/`*`/`/`).
  - Stresses: avr-libc **soft-float** routines (AVR has no FPU) — large, branchy
    helper loops, the single biggest un-measured real-world cost.
  - Reveals: likely the **worst** avr8js gap; the strongest evidence for/against
    the full-monolithic-core investment.
- [x] **`bitbang-crc`** — software SPI/I2C bit-banging + CRC8/CRC16 over a buffer.
  - Stresses: **logic ops (`AND`/`OR`/`EOR`)** — *not inlined yet* — plus shifts
    and `IN`/`OUT` port toggling.
  - Reveals: directly measures the megamorphic `handler()` fallback cost on
    common ops the generated core doesn't yet cover.
- [x] **`isr-heavy`** — software PWM / frequency counter / servo timing with
  frequent timer or pin-change interrupts.
  - Stresses: ISR prologue/epilogue (`PUSH`/`POP`/`RETI`), frequent interrupt
    dispatch, and the clock-event scheduler under interrupt churn.
  - Reveals: a path the synthetic fixtures barely touch; very common in firmware.
- [ ] **`dsp-fixed`** — FIR filter / fixed-point math / PROGMEM-table interpolation.
  - Stresses: `MUL`/MAC loops, `LDD`/`STD` (displacement memory), `LPM`.
  - Reveals: multiply + displacement-memory mix (complements `sensor-format`'s
    divide-heavy mix).
- [ ] **`string-heavy`** — `String` class / `sprintf` / parsing.
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
  "full monolithic core (match) vs JIT (beat)" decision in `performance-plan.md`.
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

1. **Add `float-math` + `bitbang-crc`** (Part A top two). Between them they cover
   the two biggest un-measured real costs — soft-float helpers and un-inlined
   logic ops — and they decide whether the full monolithic core is worth it.
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
- [x] Fix the `peripheral-mix` result mismatch (`bench:result`) so the mixed
  ADC/timer-interrupt/PWM/GPIO/I2C scenario matches avr8js.
- [ ] Decide whether the simavr-WASM ceiling is worth the one-time integration —
  it is iff "faster on real Arduino programs" is a real product goal.

## Recorded fixture evidence

Captured locally on 2026-06-25 with `semantic-direct` `__udivmodsi4`.

- `float-math`: `profile:opcodes -- --case float-math --mode fast --top 12`
  sampled 5,000,001 cycles and showed soft-float helper loops dominated by
  branch/shift/return rows (`BRNE`, `ROR`, `SBCI`, `LSR`, `RET`). `bench:compare
  -- --repeats 5`: avrts **22,339,989/s**, avr8js **38,425,625/s**, ratio
  **0.58x**.
- `bitbang-crc`: `profile:opcodes -- --case bitbang-crc --mode fast --top 12`
  sampled 5,000,000 cycles and showed direct port/CRC loop rows (`CBI`, `SBI`,
  `SBIW`, `SBIC`, `BRNE`, `AND`). `bench:compare -- --repeats 5`: avrts
  **15,166,797/s**, avr8js **39,977,453/s**, ratio **0.38x**.
- `isr-heavy`: `bench:result -- --case isr-heavy --analog 512 --d2 high`
  matched avr8js result SRAM, empty I2C transcript, and register summary.
  `profile:opcodes -- --case isr-heavy --mode fast --top 12` sampled
  5,000,001 cycles and showed interrupt/delay-loop pressure (`LDS`, `SBRC`,
  `RJMP`, `SBIW`, `BRNE`, `RETI`, `PUSH`). `bench:compare -- --case isr-heavy
  --repeats 3`: avrts **19,600,487/s**, avr8js **41,494,912/s**, ratio
  **0.47x**.
