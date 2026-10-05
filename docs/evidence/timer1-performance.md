# Timer1 follow-up performance check

Date: 2026-10-05. Baseline: `4c8ce84bdb26539535d9363cf4ceba4b30e5f1c2`.
Candidate: Timer1 shared TEMP, active OCR comparators and PWM buffering in the
prepared 0.1.1 patch. Both revisions used identical firmware fixtures.

Host: Intel Core i7-7700K, Windows 10 IoT Enterprise LTSC 10.0.19044,
Bun 1.3.14. The existing revision harness starts a fresh Bun process for each
revision/workload. Each trial constructs its AVR outside the measured interval,
warms up for 500,000 cycles, and measures 50,000,000 cycles. One initial trial
is discarded; results are the median of nine further trials. These focused
runs used baseline-first order, ran sequentially, and had no concurrent tests
or builds. Raw samples are linked below.

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Change | Samples |
| --- | ---: | ---: | ---: | --- |
| peripheral-mix | 1167.76 | 1142.24 | -2.2% | [JSON](timer1-performance-peripheral-mix.json) |
| isr-heavy | 80.40 | 80.34 | -0.1% | [JSON](timer1-performance-isr-heavy.json) |
| analog-write | 296.54 | 303.50 | +2.3% | [JSON](timer1-performance-analog-write.json) |

Positive change means higher simulated-cycle throughput. These samples show
no large regression in the three measured workloads. They do not establish
a universal speed guarantee or precise significance for small changes.

`analog-write` exercises Arduino PWM, including Timer1 on pins 9/10.
`isr-heavy` exercises Timer1 CTC alongside interrupt work. `peripheral-mix`
reaches a terminal idle loop during the window, so its high throughput mainly
measures timer scheduling and idle skipping. Dynamic Timer1 TOP/duty changes,
every PWM mode, host subscribers, Node, browser workers, packed bundles and
construction cost are outside this performance measurement. Source regressions
cover their documented correctness scope separately.

The [preceding ten-workload comparison](peripheral-performance.md) against
0.1.0 remains historical evidence; this table measures only the Timer1 follow-up.

```sh
git worktree add --detach ../avrts-timer1-baseline 4c8ce84
bun run bench:revision --baseline ../avrts-timer1-baseline --case analog-write --output comparison.json
git worktree remove ../avrts-timer1-baseline
```

Substitute either other workload name to reproduce its focused comparison.
