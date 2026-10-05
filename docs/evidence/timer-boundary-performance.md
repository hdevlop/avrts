# Timer boundary performance comparison

Date: 2026-10-05. Baseline: `d31a3cb3e2647e27fbb4603064eec41b234e4cae`.
Candidate: Timer0/Timer2 PWM buffering, timer clock boundaries and generated
I/O sampling fixes in the prepared, unpublished 0.1.1 patch.

Host: Intel Core i7-7700K, Windows 10 IoT Enterprise LTSC 10.0.19044,
Bun 1.3.14. Both revisions use the same firmware fixtures. The revision harness
starts a fresh Bun process for each revision/workload, constructs each AVR
outside the measured interval, warms up for 500,000 cycles, then measures
50,000,000 cycles. One initial trial is discarded; results are medians of nine
further trials. Full comparisons alternate revision order between workloads;
focused comparisons use baseline-first order. Runs were sequential, without
concurrent tests or builds. Raw samples and elapsed times are retained.

## Final comparison

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Change |
| --- | ---: | ---: | ---: |
| delay-blink | 48.65 | 48.29 | -0.7% |
| serial-print | 333.03 | 320.92 | -3.6% |
| analog-write | 324.72 | 299.01 | -7.9% |
| sensor-format | 72.93 | 71.38 | -2.1% |
| float-math | 30.29 | 30.79 | +1.6% |
| bitbang-crc | 18.84 | 18.80 | -0.2% |
| peripheral-mix | 1201.34 | 1114.42 | -7.2% |
| isr-heavy | 79.25 | 81.25 | +2.5% |
| string-heavy | 58.35 | 57.07 | -2.2% |
| dsp-fixed | 64.42 | 61.43 | -4.6% |

[Final raw results](timer-boundary-performance-final.json). Positive change
means higher simulated-cycle throughput. These measurements show the remaining
costs and run-to-run variation; small changes are not significance estimates or
a universal speed guarantee. The final PWM/idle decreases were not separately
repeated after this run.

`analog-write` exercises Arduino PWM. `isr-heavy` exercises Timer1 CTC alongside
interrupt work. `peripheral-mix` reaches a terminal idle loop during the window,
so its high throughput mainly measures timer scheduling and idle skipping.
Every PWM mode, dynamic duty/TOP updates, host subscribers, Node, browser workers,
packed bundles and construction cost are outside this performance measurement.
Source tests cover their documented correctness scope separately.

## Regression found and addressed

[The first ten-workload run](timer-boundary-performance-before-optimization.json)
found a 53.6% peripheral-mix decrease and a 10.3% ISR-heavy decrease. Scheduling
both equality and the following compare-flag clock added events even when the
output was disconnected. A narrower guard for masked, latched flags recovered
the idle workload ([focused result](timer-boundary-performance-peripheral-mix-quiet-optimization.json),
-1.5%) but retained the ISR cost ([focused result](timer-boundary-performance-isr-heavy-quiet-optimization.json),
-9.9%).

The final implementation lets disconnected Timer1 CTC outputs advance directly
to the following flag/clear clock and skips redundant B events when its flag is
latched and masked. Flag/mask writes synchronize the lazy counter and re-arm
observable events. The final full comparison above supersedes these intermediate
measurements; none of the raw evidence was discarded. Correctness regressions
cover clearing a flag without a prior counter read and repeated B interrupts.

[The full run immediately after the scheduling fix](timer-boundary-performance-after-scheduling-optimization.json)
measured -2.5% for peripheral-mix and -0.3% for ISR-heavy. The final run above
also includes the subsequent above-TOP pin guard and TCNT-written TOP/BOTTOM
miss fixes. Its measured costs vary from that preceding run; both sets are kept.

```sh
git worktree add --detach ../avrts-timer-boundary-baseline d31a3cb
bun run bench:revision --baseline ../avrts-timer-boundary-baseline --output comparison.json
git worktree remove ../avrts-timer-boundary-baseline
```

This baseline is the preceding Timer1 preparation, distinct from the historical
[Timer1 comparison](timer1-performance.md) and
[0.1.0 comparison](peripheral-performance.md).
