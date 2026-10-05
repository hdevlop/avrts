# Register ownership performance comparison

Date: 2026-10-05. Baseline: `0efbc61e5704133ba5068381c6a5b7d50aedb0f7`.
Candidate: reserved register masks, ADC data ownership, port-C bit limits and
reset flag accumulation in the prepared, unpublished 0.1.1 patch.

Host: Intel Core i7-7700K, Windows 10 IoT Enterprise LTSC 10.0.19044,
Bun 1.3.14. Both revisions use identical compiled Arduino firmware. The revision
harness starts a fresh Bun process for each revision/workload, excludes
construction, warms up for 500,000 cycles and measures 50,000,000 cycles per
trial. The initial trial is discarded; each row is the median of nine remaining
trials. Focused runs use baseline-first order and ran sequentially without
concurrent tests or builds. Raw samples and elapsed times are retained.

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Change | Raw results |
| --- | ---: | ---: | ---: | --- |
| analog-write | 285.48 | 282.88 | -0.9% | [Samples](register-bits-performance-analog-write.json) |
| peripheral-mix | 1060.38 | 1029.02 | -3.0% | [Samples](register-bits-performance-peripheral-mix.json) |
| bitbang-crc | 18.43 | 18.92 | +2.7% | [Samples](register-bits-performance-bitbang-crc.json) |

The [initial bitbang measurement](register-bits-performance-bitbang-crc-initial.json)
was 18.77 versus 17.94 Mcycles/s (-4.4%) with an additional port-mask table
lookup in the GPIO path. The final implementation uses a direct port-C check.
The repeat does not separate the effect of that small code change from
run-to-run variation; small changes are not significance estimates. The other
two final rows were collected after the same change and were not repeated.

Positive change means higher simulated-cycle throughput. Arduino PWM and
bitbang exercise GPIO/timer paths; peripheral-mix reaches a terminal idle loop
and primarily measures timer scheduling and idle skipping. These three source
workloads do not measure every register write pattern, reset/restore cost, Node,
browser workers or packed bundles, and do not establish a general speed claim.
Correctness evidence is in [the follow-up](register-bit-ownership.md).

Reproduce the final rows with:

```powershell
bun scripts/benchmark-revision.ts --baseline PATH_TO_0EFBC61 --case analog-write --output analog-write.json
bun scripts/benchmark-revision.ts --baseline PATH_TO_0EFBC61 --case peripheral-mix --output peripheral-mix.json
bun scripts/benchmark-revision.ts --baseline PATH_TO_0EFBC61 --case bitbang-crc --output bitbang-crc.json
```
