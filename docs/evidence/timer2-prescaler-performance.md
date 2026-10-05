# Timer2 divider performance evidence

Date: 2026-10-05. Baseline: `bdf28482861fd2477c11fa596d14c3b6269c2a86`.
Candidate: the Timer2 independent divider follow-up in this commit.

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Change |
| --- | --- | --- | --- |
| Arduino PWM (`analog-write`) | 304.79 | 318.51 | +4.5% |
| Peripheral mix | 1,114.36 | 1,087.47 | -2.4% |
| Timer2 RTC | 48.16 | 47.51 | -1.4% |

These three focused measurements retain both the measured costs and host/runtime
variation. Corrected timer phase can also alter executed work. They do not
establish a general speed improvement or repeat the full historical matrix.

## Method

`scripts/benchmark-revision.ts` uses a fresh Bun process per revision/workload.
Construction and loading are excluded. Each trial warms 500,000 simulated
cycles and times 50,000,000 cycles; the first of ten trials is discarded and
the table uses the median of the remaining nine. Each focused run measures
baseline before candidate. Runs were sequential after release checks, with no
concurrent test/build/benchmark process from this task.

Host: Intel Core i7-7700K at 4.20 GHz, Windows 10 IoT Enterprise LTSC
10.0.19044, Bun 1.3.14. Baseline was a clean detached worktree of `bdf2848`.

Raw samples and elapsed times:

- [Arduino PWM](timer2-prescaler-performance-analog-write.json)
- [Peripheral mix](timer2-prescaler-performance-peripheral-mix.json)
- [Timer2 RTC](timer2-prescaler-performance-timer2-rtc.json)

These are source execution measurements, separate from package/browser/native
acceptance. See [correctness evidence](timer2-prescaler-phase.md) and
[release preparation](release-0.1.1.md).
