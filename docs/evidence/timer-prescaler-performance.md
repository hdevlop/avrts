# Shared prescaler performance evidence

Date: 2026-10-05. Baseline: `44a5deff28f733041464535fd2e0f1320c20b8cd`.
Candidate: the shared Timer0/Timer1 prescaler follow-up in this commit.

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Change |
| --- | --- | --- | --- |
| Arduino PWM (`analog-write`) | 292.42 | 301.83 | +3.2% |
| Peripheral mix | 1,054.25 | 1,062.24 | +0.8% |
| ISR-heavy | 79.47 | 80.64 | +1.5% |

These focused measurements show no measured regression in the three workloads.
Small differences include host/runtime variation and changes in executed work
from corrected timer phase; they are not proof of a general speed improvement.
The full historical workload matrix was not repeated for this batch.

## Method

`scripts/benchmark-revision.ts` uses a fresh Bun process per revision/workload,
excluding construction and fixture loading from timing. Each trial warms
500,000 simulated cycles and times 50,000,000 cycles. The first of ten trials
is discarded; the table uses the median of the remaining nine. Each focused
run measures baseline first and candidate second. Runs were sequential, after
release checks, with no concurrent build/test/benchmark process from this task.

Host: Intel Core i7-7700K at 4.20 GHz, Windows 10 IoT Enterprise LTSC
10.0.19044, Bun 1.3.14. The baseline was a clean detached worktree of `44a5def`.

Raw samples and elapsed times:

- [Arduino PWM](timer-prescaler-performance-analog-write.json)
- [Peripheral mix](timer-prescaler-performance-peripheral-mix.json)
- [ISR-heavy](timer-prescaler-performance-isr-heavy.json)

These are source execution measurements, separate from package/browser or
native simulator acceptance. See [correctness evidence](timer-prescaler-phase.md)
and [release preparation](release-0.1.1.md).
