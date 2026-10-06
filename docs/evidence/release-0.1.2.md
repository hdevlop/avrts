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
[the wake clock review](wake-clock-domains.md). A second follow-up stops
clocked INT0/INT1 edge detection during non-idle sleep and samples held levels
when I/O clocks resume, while retaining asynchronous low-level and PCINT wake.
See [the external interrupt review](external-interrupt-sleep.md). A third
follow-up starts ADC conversion on idle entry, delivers live ACME input changes,
and restricts comparator events/wake by sleep mode while resuming clocks before
held-input sampling. See [the analog sleep review](analog-sleep-boundaries.md).

## Local validation

All components of `bun run release:check` passed with the final library/fixture
implementation and `0.1.2` metadata. Later comparison display formatting passed
focused tests and typechecking; CI checks the final pushed commit.

| Check | Result |
| --- | --- |
| TypeScript source check | Passed |
| Generated fast-core consistency | Passed |
| Complete Bun source suite | 2,729 passed, zero failed; 17,610 assertions across 73 files |
| Browser build and Chromium integration | Passed; all eight Playwright tests |
| Library and declaration build | Passed |
| Packed Node/Bun imports, types, browser bundle, worker URLs | Passed; 83 packed files |
| Native simavr result fixtures | All four passed |
| Native simavr timing fixtures | All five passed |
| Native simavr Optiboot | Transcript, flash page, and uploaded application matched |

The five new test files add 768 regressions, including fast and cycle-exact execution:
76 Timer2 signal cases, 58 wake clock cases and 354 external interrupt sleep
cases, plus 272 analog input/sleep cases and eight benchmark harness/fixture
cases. Existing asynchronous tests explicitly cover the CPU synchronizer and
resumed clocks during entry. The external interrupt cases also run compiled
power-down firmware directly and after restore with held/completed pin pulses.
The analog probe additionally validates ADC conversion without an ADSC write
on idle sleep entry and comparator delivery after an eligible PCINT wake.
Native fixtures retain their established normalizations; passing them does not
calibrate every silicon timing detail. The Timer2 firmware probe separately
records native simavr disagreements. Neither that probe nor the new external
interrupt/analog source regressions are counted among passing native fixtures.

Local output is retained under ignored `logs/release-0.1.2-*` and
`logs/benchmark-*` paths. GitHub CI
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

The final external interrupt follow-up was compared against the clean wake
clock head `f5bff1d`. Median changes were +0.5% for GPIO bit-banging, +5.3% for
peripheral mix and +2.1% for interrupt-heavy firmware. These are focused host
measurements, with method and raw samples in
[the external interrupt review](external-interrupt-sleep.md#focused-performance).

The subsequent analog follow-up was compared against that external-interrupt
head `8fb5eda`: Arduino PWM +2.6%, interrupt-heavy -0.9% and repeated watchdog
sleep/wake +0.8%. The small measured interrupt-workload cost is retained; these
host results do not establish universal performance. Method and samples are in
[the analog sleep review](analog-sleep-boundaries.md#focused-performance).

The subsequent [external benchmark refresh](benchmark-comparison-refresh.md)
corrects construction-inclusive timing, missing avr8js TWI, the mixed
fixture's completed tail and differing firmware images in revision comparisons.
Earlier mixed-fixture long-run rates above remain
historical tail measurements. The new execution-only comparison records all
eleven workloads and their raw samples; it is not an emulator optimization.
The fixture/harness changes do not alter the packed library or archive digest.

## Prepared archive

`npm pack --ignore-scripts --json` packaged the already validated build as
`hdevlop-avrts-0.1.2.tgz`: 83 files, 290,373 packed bytes and 1,551,845 unpacked
bytes. The ignored archive remains available locally for publication review.

- SHA-256: `9fb92e3872b191b848f4164ab994febba8221facdcad2dd83cbc79e7dbcd7884`
- SHA-1: `3bfe7016351e0c426fbde5b751075eb01ecb5bbc`
- npm integrity: `sha512-slJwmqmkVNH5OwXjSTHH1g/aXQI/qJEoDAZV4FCB5QYZPPD7BaAp8crweBLI6oDYPbsyd+8UAb2WehbS8TYFoQ==`

## Remaining boundaries

PSRASY acknowledgement was investigated using the datasheet and a bounded
firmware probe. The datasheet does not specify its exact asynchronous reset
transfer count, and native simavr retained the reset bit through polling.
avrts therefore retains its existing immediate acknowledgement convention;
no unsupported latency was added. Flag-clear acknowledgement/re-entry within
a TOSC period, external input synchronizer/short-pulse/startup filtering,
comparator power-up/synchronizer timing and physical hardware calibration remain
open. See
[the investigation](timer2-async-signals.md#psrasy-investigation-and-remaining-boundaries)
and [limitations](../limitations.md).
