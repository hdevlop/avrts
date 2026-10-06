# Execution-only benchmark comparison refresh

Date: 2026-10-06. Emulator source: `0eaab0d23c41a69176a282f8333d80af2f90350b`.
The harness and compiled workload changes are included with this evidence.
This refresh does not change the emulator implementation or publish `0.1.2`.

## Problems corrected

The speed comparison started its timer before constructing each simulator.
Construction cost contaminated short execution budgets, contrary to the
plan's steady-state intent. Timing now starts after construction and an
explicit warm-up. Raw samples separately retain construction milliseconds,
measured execution milliseconds and actual simulated cycles, including any
instruction-boundary overshoot. A deterministic clock test verifies the boundary.

The avr8js speed runner did not instantiate TWI. Its mixed fixture could stall
at the first hardware handshake. Both runners now receive ADC raw 512, D2 high
and the same ACKing slave used by the result comparison. Shared TWI helpers
avoid divergent host protocols. Native/avr8js result tests remain separate
fidelity checks with their existing documented normalizations.

The mixed firmware always halted after twelve rounds; two direct regressions
failed before correction. It now repeats rounds unless SRAM `0x02ff` is `0x42`,
the mode already selected by result runners. Its source, HEX and disassembly
were rebuilt together using Arduino AVR 1.8.8's GCC 7.3.0 and cached Uno core
with the platform's `-Os -flto` compilation/link flags. The local Arduino CLI
was unavailable; the installed compiler and core supplied the equivalent build.
Normal regeneration still uses `bun run fixtures:arduino` when CLI is installed.
The updated HEX SHA-256 is
`f3579586e5359679018d0fe478bca6dea1d45086c654ffa9e720dc4188d48ce7`.

The source-revision harness previously loaded each checkout's own HEX. It now
loads the candidate's firmware for both revisions and records `fixtureRoot`,
so rebuilding a fixture cannot silently change the compared program. A
[shared-fixture check](benchmark-revision-shared-fixture.json) used the clean
`0eaab0d` checkout, whose original mixed HEX halted, and the current checkout.
Both ran the updated continuous HEX. Emulator source was identical; the
132.61 versus 143.72 Mcycles/s medians illustrate host/process variation and
are not evidence of a code speedup. Each process discarded its first trial
and retained nine trials after 500,000 warm-up cycles, timing 50,000,000 cycles.

Older warmed long-run `peripheral-mix` rates in revision evidence describe
the completed tail, not continuous peripheral activity. Older external ratios
also include construction and a different host environment. They are retained
as historical records and are not a source speedup baseline for this refresh.

## Measurement

Host: Intel i7-7700K 4.20 GHz, Windows 10 IoT Enterprise LTSC 10.0.19044.
Both engines ran in Bun 1.3.14 / JavaScriptCore; peer package avr8js 0.21.0.
The full comparison ran sequentially after release and oracle checks, without
overlapping validation or other benchmarks:

```powershell
bun run bench:compare --isolate --repeats 5 --cycles 50000000 --output docs/evidence/benchmark-comparison-2026-10-06.json
```

Each workload used a fresh Bun subprocess. Each trial constructed a fresh
simulator outside the timed interval and ran 500,000 warm-up cycles. The table
uses best-of-five rates, with 50,000,000 requested measured cycles per trial,
avrts trials first and avr8js second. All samples are retained in
[the JSON report](benchmark-comparison-2026-10-06.json). This differs from the
median-based source-revision harness and from construction-inclusive `bun run bench`.

| Workload | avrts Mcycles/s | avr8js Mcycles/s | Cycle-rate ratio |
| --- | ---: | ---: | ---: |
| delay-blink | 48.17 | 51.20 | 0.94x |
| serial-print | 324.15 | 73.86 | 4.39x |
| analog-write | 311.86 | 78.62 | 3.97x |
| sensor-format | 71.80 | 53.21 | 1.35x |
| float-math | 30.61 | 41.93 | 0.73x |
| bitbang-crc | 18.84 | 43.15 | 0.44x |
| peripheral-mix | 144.67 | 46.93 | 3.08x |
| isr-heavy | 78.89 | 46.77 | 1.69x |
| string-heavy | 58.41 | 52.46 | 1.11x |
| dsp-fixed | 64.64 | 54.35 | 1.19x |

The synthetic `tight-loop` is retained in raw JSON but excluded from practical
speed claims: avrts bulk-skips the entire idle window in 0.0027–0.0099 ms, so
its enormous apparent cycle rate is sensitive to timer precision and says
little about instruction execution or peripheral load.

During each mixed-fixture measured interval avrts completed 8,789 TWI STOPs
and avr8js 15,635. Both continue actual bus work after warm-up. Different TWI
latency models explain why equal cycle budgets do not perform equal numbers
of transactions; the rate ratio measures virtual-clock progress, not identical
application work per second. Output fidelity remains checked separately.

On this host seven of the ten nontrivial workloads lead the peer in cycle rate.
All ten measured over 16 Mcycles/s, with bit-banging closest to that threshold.
These results include JIT, GC and host variation, fixed engine order and
best-of-five selection. They do not measure Node, browser workers, UI overhead,
electrical timing or all firmware, and do not imply universal realtime headroom.

## Validation and open work

- Eight harness/fixture regressions passed, including timing boundaries,
  actual-cycle accounting, isolated CLI options, invalid arguments and ongoing
  mixed-fixture bus work in both engines.
- Four avr8js result scenarios and four native simavr result scenarios passed;
  native timing's five cases and Optiboot also passed with existing normalizations.
- `bun run release:check` passed: 2,729 source tests, 17,610 assertions across
  73 files, eight Chromium tests, generated-core/types/build and packed consumers.
- The already prepared `0.1.2` archive remained byte-identical after repacking;
  its metadata is in [release preparation](release-0.1.2.md).

The dedicated high-baud USART/PWM/ADC queue workload and final-state oracles for
the remaining throughput fixtures are still open plan items. This refresh adds
neither a WASM peer nor a JIT. Follow-up optimization should start from fresh
float/bit-bang/delay profiles rather than the old all-real-code-below-parity claim.
