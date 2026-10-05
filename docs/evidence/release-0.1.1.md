# 0.1.1 release preparation

Date: 2026-10-05. Package: `@hdevlop/avrts@0.1.1`.

This patch corrects peripheral flags, interrupt requests, conversion state,
clock gating, and snapshot transitions. It also adds Timer1's shared TEMP access
protocol and mode-specific OCR PWM buffering, with correct fast-PWM periods and
pending state through snapshots. The subsequent timer boundary batch adds
Timer0/Timer2 PWM buffers and both slopes, all-timer CTC periods/ordinary flag
delays, force-compare strobes and generated SBIC/SBIS I/O sampling order.
The Timer2 asynchronous follow-up adds separate temporary-register transfers,
two-edge busy deadlines, and source phase through clock changes and restore.
The SPI status follow-up preserves unread completion/collision flags when a
new master or slave byte starts.
The register ownership follow-up masks reserved bits, protects ADC results and
preserves reset causes across non-power-on resets.
The shared prescaler follow-up retains Timer0/Timer1's free-running phase through
clock-select changes, stopped counters, staggered starts and snapshots.
The scope and remaining model boundaries
are in [the correctness review](peripheral-correctness-review.md),
[the Timer1 follow-up](timer1-register-buffering.md),
[the timer boundary follow-up](timer-boundary-correctness.md),
[the Timer2 asynchronous follow-up](timer2-async-transfers.md),
[the SPI status follow-up](spi-status-sequence.md),
[the register ownership follow-up](register-bit-ownership.md),
[the shared prescaler follow-up](timer-prescaler-phase.md), and
[the limitations](../limitations.md). Changes are listed in the root changelog.

## Local release evidence

`bun run release:check` completed successfully on the final implementation and
0.1.1 metadata:

| Check | Result |
| --- | --- |
| TypeScript source check | Passed |
| Generated fast-core consistency | Passed |
| Complete Bun source suite | 1,746 passed, zero failed; 11,067 assertions across 66 files |
| Browser build and Chromium integration | Passed; all eight Playwright tests |
| Library and declaration build | Passed |
| Packed Node/Bun imports, types, browser bundle, worker URLs | Passed; 83 packed files |
| Frozen-lockfile install | Passed; no dependency changes |
| Native simavr result fixtures | All four passed |
| Native simavr timing fixtures | All five passed |
| Native simavr Optiboot | Transcript, flash page, and uploaded application matched |
| Whitespace check | `git diff --check` passed |

Native comparisons retain the documented normalizations described in the
correctness review; their results do not prove every silicon timing detail.
The new SPI status probe separately records a native simavr disagreement and
is not included among those passing fixtures.
Local command output is retained under ignored `logs/` paths. GitHub CI runs the
package checks on Ubuntu Node 22/24 and Windows Node 22, plus Chromium integration
on Ubuntu; its result is associated with the pushed preparation commit in Actions.

## Performance

[The preceding revision comparison](peripheral-performance.md) checks ten workloads
at `4c8ce84` against the 0.1.0 source. It identified unnecessary SPI SS work on
GPIO updates while SPI was disabled; the guard restored bitbang throughput to baseline. The final PWM
sample was 10.5% slower and its focused repeat 3.3% slower. That variation leaves
a possible smaller PWM cost unresolved; no universal performance claim is made.

[The Timer1 follow-up comparison](timer1-performance.md) uses `4c8ce84` as its
baseline. Median throughput changed by -2.2% for peripheral-mix, -0.1% for
ISR-heavy, and +2.3% for Arduino PWM. These focused source measurements cover
three workloads; they are not a general speed guarantee.

[The timer boundary comparison](timer-boundary-performance.md) measures all ten
workloads against `d31a3cb`. It found and addressed redundant Timer1 CTC events;
the final peripheral-mix change is -7.2% and ISR-heavy is +2.5%. The full table
ranges from -7.9% to +2.5%, retaining the remaining costs and measurement variation.

[The Timer2 asynchronous comparison](timer2-async-performance.md) uses
`f46d2a4` as its baseline. Its three focused workloads changed by +3.4% for
Arduino PWM, -2.5% for peripheral-mix and -1.4% for the Timer2 RTC. These runs
cover source execution on the same host; small differences include measurement
variation, and the preceding ten-workload matrix was not repeated for this batch.

[The register ownership comparison](register-bits-performance.md) uses
`0efbc61` as its baseline. Final focused changes are -0.9% for Arduino PWM,
-3.0% for peripheral-mix and +2.7% for bitbang-crc. The initial bitbang run
measured -4.4%; both measurements are retained, with the final GPIO change and
measurement variation documented separately. This is a three-workload source
comparison rather than a repeat of the full historical matrix.

[The shared prescaler comparison](timer-prescaler-performance.md) uses
`44a5def` as its baseline. Focused throughput changed by +3.2% for Arduino PWM,
+0.8% for peripheral-mix and +1.5% for ISR-heavy. These source measurements
include host/runtime variation and changed timer phase; they do not establish
a general speed improvement.

## Prepared artifact

`npm pack --ignore-scripts --json` produced `hdevlop-avrts-0.1.1.tgz` in the
workspace root after the successful build and package smoke check. It contains
83 files, is 282,980 bytes packed, and 1,518,829 bytes unpacked.

SHA-256:

```text
eb1b26a771daf85adff5cd509ee3abdc83462348a1d387560cdcd255701aa3e3
```

This artifact is ignored by Git. It can be reproduced with `bun run release:check`
followed by `npm pack --ignore-scripts`; archive hashes may differ if the toolchain
or build output changes. npm publication is a separate step and was not run as
part of preparation. Timer1 fast-PWM overflow phase differs from native simavr;
Timer2 wake-time read/interrupt synchronization and electrical timer inputs
remain outside this preparation, as recorded in the limitations.
