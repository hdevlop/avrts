# Timer2 asynchronous transfer performance

Date: 2026-10-05. Baseline: `f46d2a42a89692597a6a04a9a0151e9b482ddac8`.
Candidate: Timer2 temporary-register transfers and phase/restore fixes in the
prepared, unpublished 0.1.1 patch.

Host: Intel Core i7-7700K, Windows 10 IoT Enterprise LTSC 10.0.19044,
Bun 1.3.14. Both revisions use identical compiled Arduino fixtures. Each
revision/workload starts in a fresh Bun process; construction is excluded.
Each trial warms up for 500,000 cycles and measures 50,000,000 cycles. The first
trial is discarded, leaving nine trials whose median is reported. These three
focused runs use baseline-first order and ran sequentially without concurrent
tests or builds. Raw samples and elapsed times are retained below.

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Change | Raw results |
| --- | ---: | ---: | ---: | --- |
| analog-write | 298.06 | 308.24 | +3.4% | [Samples](timer2-async-performance-analog-write.json) |
| peripheral-mix | 1117.55 | 1089.41 | -2.5% | [Samples](timer2-async-performance-peripheral-mix.json) |
| timer2-rtc | 48.95 | 48.27 | -1.4% | [Samples](timer2-async-performance-timer2-rtc.json) |

Positive change means higher simulated-cycle throughput. The PWM workload
exercises ordinary timer output. Peripheral-mix reaches a terminal idle loop,
so its high throughput primarily measures timer scheduling and idle skipping.
Timer2 RTC repeatedly reads the asynchronous counter and exercises its source
clock path. Small differences include run-to-run variation; these measurements
are not significance estimates, and no focused repeat was performed.

This comparison covers three workloads rather than the preceding ten-workload
matrix. Dynamic asynchronous writes, every timer mode, construction, Node,
browser workers and packed bundles are outside these performance measurements.
Correctness evidence is recorded separately in
[the asynchronous transfer follow-up](timer2-async-transfers.md).

Reproduce each row with:

```powershell
bun scripts/benchmark-revision.ts --baseline PATH_TO_F46D2A4 --case analog-write --output analog-write.json
bun scripts/benchmark-revision.ts --baseline PATH_TO_F46D2A4 --case peripheral-mix --output peripheral-mix.json
bun scripts/benchmark-revision.ts --baseline PATH_TO_F46D2A4 --case timer2-rtc --output timer2-rtc.json
```
