# 0.1.2 release preparation evidence

Date: 2026-10-06. Package: `@hdevlop/avrts@0.1.2`.

Prepared locally; npm publication has not been performed for this version.
The preceding public release is `0.1.1`.

This patch adds Timer2's asynchronous timer/CPU flag synchronizer and separates
timer-domain wake from CPU interrupt dispatch. Compare output remains on its
timer edge, while CPU-visible flags cross three processor clocks after the
timer stage. Overflow gains its missing following-timer-clock stage. Pending
stages pause with the CPU I/O clock, resume before wake startup, and survive
snapshots. A follow-up restarts all modeled peripheral sleep gates at wake
start, retaining PRR and allowing entry clocks to advance timers and in-flight
operations. The scope and timing evidence are in
[the signal review](timer2-async-signals.md) and
[the wake clock review](wake-clock-domains.md).

## Local validation

All components of `bun run release:check` passed with the final implementation
and `0.1.2` metadata. Subsequent edits only recorded documentation and samples.

| Check | Result |
| --- | --- |
| TypeScript source check | Passed |
| Generated fast-core consistency | Passed |
| Complete Bun source suite | 2,095 passed, zero failed; 12,883 assertions across 70 files |
| Browser build and Chromium integration | Passed; all eight Playwright tests |
| Library and declaration build | Passed |
| Packed Node/Bun imports, types, browser bundle, worker URLs | Passed; 83 packed files |
| Native simavr result fixtures | All four passed |
| Native simavr timing fixtures | All five passed |
| Native simavr Optiboot | Transcript, flash page, and uploaded application matched |

The two new test files add 134 regressions across fast and cycle-exact execution:
76 Timer2 signal cases and 58 wake clock cases. Existing asynchronous tests
explicitly cover the CPU synchronizer and resumed clocks during entry.
Native fixtures retain their established normalizations; passing them does not
calibrate every silicon timing detail. The new firmware probe separately records
native simavr disagreements and is not counted among passing native fixtures.

Local output is retained under ignored `logs/release-0.1.2-*` paths. GitHub CI
runs package checks on Ubuntu Node 22/24 and Windows Node 22, plus Chromium on
Ubuntu. Its result is associated with the pushed preparation commit in Actions.

## Performance

[The focused comparison](timer2-signals-performance.md) uses the clean `0.1.1`
documentation head `53e9771` as baseline for the preceding signal batch at
`a60a77c`. Median throughput changed by +4.1%
for Arduino PWM, +1.7% for peripheral mix, +0.8% for ISR-heavy and -2.1% for the
quiet Timer2 RTC repeat. The initial RTC result was -0.8%; both runs are retained.
These four source workloads include measurement variation and do not establish
a universal performance claim. The subsequent wake clock correction is checked
separately with compiled watchdog sleep firmware in
[the wake clock review](wake-clock-domains.md#focused-sleep-performance).
Its quiet median changed from 81.56 to 78.95 Mcycles/s (-3.2%); an earlier
overlapped run measured +1.7%. Both are retained, with the quiet result used for
the final comparison and a possible smaller sleep cost left explicit.

## Prepared archive

`npm pack --ignore-scripts --json` packaged the already validated build as
`hdevlop-avrts-0.1.2.tgz`: 83 files, 288,761 packed bytes and 1,545,211 unpacked
bytes. The ignored archive remains available locally for publication review.

- SHA-256: `35323d29b8ad1149055da730ce900f587079173840bf1e493cd454a3488fcaed`
- SHA-1: `7edfc946790109446b64d1abe6190a8385dd4c30`
- npm integrity: `sha512-ExwSVYFa95G3419MXp/h1gG66LuQ/bLsoBTXbZD5PpBiDTIAM974nZKuTScm8AI/hJ+giWgsRgPaM03V9gzSbw==`

## Remaining boundaries

PSRASY acknowledgement was investigated using the datasheet and a bounded
firmware probe. The datasheet does not specify its exact asynchronous reset
transfer count, and native simavr retained the reset bit through polling.
avrts therefore retains its existing immediate acknowledgement convention;
no unsupported latency was added. Flag-clear acknowledgement/re-entry within
a TOSC period and physical hardware calibration remain open. See
[the investigation](timer2-async-signals.md#psrasy-investigation-and-remaining-boundaries)
and [limitations](../limitations.md).
