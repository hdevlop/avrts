# Timer2 wake read performance evidence

Date: 2026-10-05. Baseline: `64aa9d4a49ab9dd04eebb504c013acb60626d35d`.
Candidate: the power-save counter read follow-up in this commit.

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Change |
| --- | --- | --- | --- |
| Arduino PWM (`analog-write`) | 306.83 | 302.12 | -1.5% |
| Peripheral mix | 1,108.09 | 1,086.14 | -2.0% |
| Timer2 RTC | 47.04 | 47.42 | +0.8% |

These focused measurements retain measured costs and host/runtime variation.
They do not establish a general performance improvement. The RTC sketch polls
TCNT2 while awake; it exercises the ordinary read path rather than the new
power-save window. The full historical workload matrix was not repeated.

## Method

`scripts/benchmark-revision.ts` uses a fresh Bun process per revision/workload.
Construction and loading are excluded. Each trial warms 500,000 simulated
cycles and times 50,000,000 cycles; the first of ten trials is discarded and
the table uses the median of the remaining nine. Each focused run measures
baseline before candidate. Runs were sequential after release/native checks,
with no concurrent test/build/benchmark process from this task.

Host: Intel Core i7-7700K at 4.20 GHz, Windows 10 IoT Enterprise LTSC
10.0.19044, Bun 1.3.14. Baseline was a clean detached worktree of `64aa9d4`.

Raw samples and elapsed times:

- [Arduino PWM](timer2-wake-performance-analog-write.json)
- [Peripheral mix](timer2-wake-performance-peripheral-mix.json)
- [Timer2 RTC](timer2-wake-performance-timer2-rtc.json)

These are source execution measurements, separate from package/browser/native
acceptance. See [correctness evidence](timer2-wake-read.md) and
[release preparation](release-0.1.1.md).
