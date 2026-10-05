# 0.1.1 release evidence

Date: 2026-10-05. Package: `@hdevlop/avrts@0.1.1`.

Published publicly to npm on 2026-10-05. The `latest` tag resolves to `0.1.1`.
Publication used the validated archive from source commit
`a1b20d2aa364e8fe24847c03c0c250c3cf0f12d6`, with all four
[CI jobs passing](https://github.com/hdevlop/avrts/actions/runs/37376549794).

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
The Timer2 divider follow-up retains its independent full phase in both clock
domains, keeps reset/release on TOSC edges and bypasses PRTIM2 when AS2 is set.
The power-save read follow-up retains the asynchronous pre-sleep TCNT2 read
until the next TOSC edge after wake, including interrupt entry, clock changes
and snapshots.
The scope and remaining model boundaries
are in [the correctness review](peripheral-correctness-review.md),
[the Timer1 follow-up](timer1-register-buffering.md),
[the timer boundary follow-up](timer-boundary-correctness.md),
[the Timer2 asynchronous follow-up](timer2-async-transfers.md),
[the SPI status follow-up](spi-status-sequence.md),
[the register ownership follow-up](register-bit-ownership.md),
[the shared prescaler follow-up](timer-prescaler-phase.md),
[the Timer2 divider follow-up](timer2-prescaler-phase.md),
[the power-save read follow-up](timer2-wake-read.md), and
[the limitations](../limitations.md). Changes are listed in the root changelog.

## Local release evidence

`bun run release:check` completed successfully on the final implementation and
0.1.1 metadata:

| Check | Result |
| --- | --- |
| TypeScript source check | Passed |
| Generated fast-core consistency | Passed |
| Complete Bun source suite | 1,961 passed, zero failed; 11,936 assertions across 68 files |
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

[The Timer2 divider comparison](timer2-prescaler-performance.md) uses
`bdf2848` as its baseline. Focused throughput changed by +4.5% for Arduino PWM,
-2.4% for peripheral-mix and -1.4% for the Timer2 RTC. These source measurements
retain measured costs and host/runtime variation, without a general speed claim.

[The power-save read comparison](timer2-wake-performance.md) uses
`64aa9d4` as its baseline. Focused throughput changed by -1.5% for Arduino PWM,
-2.0% for peripheral-mix and +0.8% for the Timer2 RTC. These measurements include
host/runtime variation; the RTC exercises ordinary awake reads rather than the
new sleep window. The full historical matrix was not repeated.

## Prepared artifact

`npm pack --ignore-scripts --json` produced `hdevlop-avrts-0.1.1.tgz` in the
workspace root after the successful build and package smoke check. It contains
83 files, is 285,483 bytes packed, and 1,529,779 bytes unpacked.

SHA-256:

```text
ce3db3ceaa16cad137e0373767a6b14f4a7c39293ebfbf141358f2d75b682af9
```

This artifact is ignored by Git. It can be reproduced with `bun run release:check`
followed by `npm pack --ignore-scripts`; archive hashes may differ if the toolchain
or build output changes. npm publication is a separate step and was not run as
part of preparation. Timer1 fast-PWM overflow phase differs from native simavr;
Timer2 asynchronous interrupt/wake pipelines, PSRASY handshake and electrical timer inputs
remain outside this preparation, as recorded in the limitations.

## Publication verification

`npm publish ./hdevlop-avrts-0.1.1.tgz --ignore-scripts --access public --tag latest`
published the exact prepared artifact without rebuilding it. The preceding
release checks and CI validated its source; `--ignore-scripts` preserves that
archive rather than rerunning its build during publication.

The registry initially returned 404 while npm processed the new version.
After propagation, `npm view @hdevlop/avrts@0.1.1 version dist dist-tags --json`
confirmed version `0.1.1`, public availability and `latest: 0.1.1`.
The registry reports 83 files and 1,529,779 unpacked bytes. Its SHA-1 is
`603e50345f8856325fdb29dd18df60d6bd641f57`, matching the prepared archive.
The registry and downloaded package also match the archive's SHA-512 integrity:

```text
sha512-d78lBJ5aHkQnsSuHoa+Cr6Q2uqfpZtnssJLAhujN8K2izOuowVBH69bde4jKGZH7HvxXDVnZm1pCkvPh2xWh1Q==
```

A fresh consumer fetched the published version with `npm pack`, checked that
integrity and installed it in an isolated temporary directory. The established
package smoke checks passed against that registry artifact: root/browser/advanced
imports under Node 24.16.0 and Bun 1.3.14, direct HEX and file loading, TypeScript
declarations, browser bundling, packaged worker assets and their relative URLs.
The temporary consumer was removed after verification; output is retained in
ignored `logs/release-0.1.1-*` files.

Install the published package with `npm install @hdevlop/avrts@0.1.1`.
See [the npm version page](https://www.npmjs.com/package/@hdevlop/avrts/v/0.1.1).
