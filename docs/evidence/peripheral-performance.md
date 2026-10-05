# Peripheral patch performance check

Date: 2026-10-05. Baseline: `b017a8cc7c0326be358870192269c368861a3a4f`
(published 0.1.0 source). Candidate: the peripheral fixes at `4c8ce84`, including
the disabled-SPI guard. Both used the same checked-in firmware fixtures. These
measurements precede the Timer1 TEMP/PWM buffering follow-up; its comparison
against `4c8ce84` is recorded in [Timer1 performance evidence](timer1-performance.md).

Host: Intel Core i7-7700K, Windows 10 IoT Enterprise LTSC 10.0.19044,
Bun 1.3.14. This comparison measures source execution in Bun; it does not
measure Node, browser workers, packed bundles, or host UI responsiveness.

## Method

`scripts/benchmark-revision.ts` starts a fresh Bun process for each revision and
workload, alternating which revision runs first across workloads. Each trial
constructs a fresh AVR outside the measured interval, warms it for 500,000
simulated cycles, then times 50,000,000 cycles. One initial trial is discarded;
the table uses the median of nine further trials. Raw throughput and elapsed
time samples are retained in the JSON evidence. Tests and builds did not run
alongside these final measurements.

The synthetic RJMP-only tight loop was excluded: bulk skipping makes its wall
time too small to provide a useful throughput comparison. `peripheral-mix`
reaches its terminal idle loop during this window, so its high cycle throughput
mostly measures timers and idle-loop skipping, rather than active bus work.
Host input, serial subscribers, startup cost, and every peripheral configuration
are outside this measurement. These samples are not a general speed guarantee.

## Final measurements

Source data: [peripheral-performance.json](peripheral-performance.json).
Positive change means higher simulated-cycle throughput.

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Change |
| --- | ---: | ---: | ---: |
| delay-blink | 46.81 | 47.00 | +0.4% |
| serial-print | 330.39 | 327.73 | -0.8% |
| analog-write | 307.70 | 275.25 | -10.5% |
| sensor-format | 67.53 | 66.40 | -1.7% |
| float-math | 29.46 | 28.64 | -2.8% |
| bitbang-crc | 18.37 | 18.35 | -0.1% |
| peripheral-mix | 1165.89 | 1145.19 | -1.8% |
| isr-heavy | 78.80 | 75.87 | -3.7% |
| string-heavy | 54.60 | 56.23 | +3.0% |
| dsp-fixed | 59.85 | 63.75 | +6.5% |

The PWM case's focused repeat measured 304.69 to 294.65 Mcycles/s (-3.3%);
see [peripheral-performance-pwm-repeat.json](peripheral-performance-pwm-repeat.json).
The full sample's 10.5% slowdown did not repeat at that magnitude. A smaller PWM
cost remains possible; the spread prevents a precise claim about its size.

## Finding and correction

An initial short-window run suggested large peripheral/ISR slowdowns. Longer
measurements did not reproduce them. They did show bitbang-crc about 7% slower:
SPI was checking SS on every GPIO port update even while disabled. Returning
early when SPE is clear removes that unnecessary work while retaining enabled
master/slave SS checks. The final bitbang median returned to baseline throughput.
The longer pre-optimization samples are retained in
[peripheral-performance-before-optimization.json](peripheral-performance-before-optimization.json).

## Reproduction

From the candidate checkout:

```sh
git worktree add --detach ../avrts-baseline b017a8cc7c0326be358870192269c368861a3a4f
bun run bench:revision --baseline ../avrts-baseline --output comparison.json
git worktree remove ../avrts-baseline
```

Use `--case analog-write` (or another workload name) for a focused repeat. Keep
heavy host work separate from measurements and retain repeats that disagree.
