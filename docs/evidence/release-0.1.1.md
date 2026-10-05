# 0.1.1 release preparation

Date: 2026-10-05. Package: `@hdevlop/avrts@0.1.1`.

This patch corrects peripheral flags, interrupt requests, conversion state,
clock gating, and snapshot transitions. The scope and remaining model boundaries
are in [the correctness review](peripheral-correctness-review.md) and
[the limitations](../limitations.md). Changes are listed in the root changelog.

## Local release evidence

`bun run release:check` completed successfully on the final implementation and
0.1.1 metadata:

| Check | Result |
| --- | --- |
| TypeScript source check | Passed |
| Generated fast-core consistency | Passed |
| Complete Bun source suite | 1,107 passed, zero failed; 6,154 assertions across 60 files |
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

[The revision comparison](peripheral-performance.md) checks ten workloads against
the 0.1.0 source. It identified unnecessary SPI SS work on GPIO updates while SPI
was disabled; the guard restored bitbang throughput to baseline. The final PWM
sample was 10.5% slower and its focused repeat 3.3% slower. That variation leaves
a possible smaller PWM cost unresolved; no universal performance claim is made.

## Prepared artifact

`npm pack --ignore-scripts --json` produced `hdevlop-avrts-0.1.1.tgz` in the
workspace root after the successful build and package smoke check. It contains
82 files, is 267,233 bytes packed, and 1,431,931 bytes unpacked.

SHA-256:

```text
5b448df0629bfcff7eb4afdcf1723ff15de445087e869dfbbd9cd6c5640729e8
```

This artifact is ignored by Git. It can be reproduced with `bun run release:check`
followed by `npm pack --ignore-scripts`; archive hashes may differ if the toolchain
or build output changes. npm publication is a separate step and was not run as
part of preparation. Timer1 TEMP accesses and dynamic PWM buffering remain a
subsequent fidelity batch.
