# 0.1.1 release preparation

Date: 2026-10-05. Package: `@hdevlop/avrts@0.1.1`.

This patch corrects peripheral flags, interrupt requests, conversion state,
clock gating, and snapshot transitions. It also adds Timer1's shared TEMP access
protocol and mode-specific OCR PWM buffering, with correct fast-PWM periods and
pending state through snapshots. The subsequent timer boundary batch adds
Timer0/Timer2 PWM buffers and both slopes, all-timer CTC periods/ordinary flag
delays, force-compare strobes and generated SBIC/SBIS I/O sampling order.
The scope and remaining model boundaries
are in [the correctness review](peripheral-correctness-review.md),
[the Timer1 follow-up](timer1-register-buffering.md),
[the timer boundary follow-up](timer-boundary-correctness.md), and
[the limitations](../limitations.md). Changes are listed in the root changelog.

## Local release evidence

`bun run release:check` completed successfully on the final implementation and
0.1.1 metadata:

| Check | Result |
| --- | --- |
| TypeScript source check | Passed |
| Generated fast-core consistency | Passed |
| Complete Bun source suite | 1,460 passed, zero failed; 9,611 assertions across 62 files |
| Browser build and Chromium integration | Passed; all eight Playwright tests |
| Library and declaration build | Passed |
| Packed Node/Bun imports, types, browser bundle, worker URLs | Passed; 82 packed files |
| Frozen-lockfile install | Passed; no dependency changes |
| Native simavr result fixtures | All four passed |
| Native simavr timing fixtures | All five passed |
| Native simavr Optiboot | Transcript, flash page, and uploaded application matched |
| Whitespace check | `git diff --check` passed |

Native comparisons retain the documented normalizations described in the
correctness review; their results do not prove every silicon timing detail.
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

## Prepared artifact

`npm pack --ignore-scripts --json` produced `hdevlop-avrts-0.1.1.tgz` in the
workspace root after the successful build and package smoke check. It contains
82 files, is 276,266 bytes packed, and 1,482,732 bytes unpacked.

SHA-256:

```text
b1af42778466f69e26fefff285376489ce422bb3a65b79133e7aa0cc74d599e0
```

This artifact is ignored by Git. It can be reproduced with `bun run release:check`
followed by `npm pack --ignore-scripts`; archive hashes may differ if the toolchain
or build output changes. npm publication is a separate step and was not run as
part of preparation. Timer1 fast-PWM overflow phase differs from native simavr;
full asynchronous Timer2 register synchronization and electrical timer inputs
remain outside this preparation, as recorded in the limitations.
