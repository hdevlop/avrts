# 0.1.4 release evidence

Date: 2026-10-28. Package: `@hdevlop/avrts@0.1.4`.

This patch restores erased-flash execution after the 0.1.3 regression: empty
runtimes run, and Uno BOOTRST fuses with an application-only HEX wrap through
the erased boot section into the sketch. Erased words remain `0xFFFF` and
execute as one-cycle no-ops under the documented compatibility policy.
Relative firmware paths resolve beside the calling module before falling back
to the working directory; absolute Windows paths and direct file URLs work.
See [the changelog](../../CHANGELOG.md).

## Preparation checks

| Boundary | Result |
| --- | --- |
| Dependencies | `bun install --frozen-lockfile` passed without dependency changes |
| Release gate | `bun run release:check` passed: typecheck, generated-core freshness, all 3,019 tests across 87 files, demo build, eight Chromium E2E tests, library/declaration build and package smoke |
| Packed consumer | 88-file archive passed Node/Bun empty-runtime execution, Uno boot-section wrap into the application, caller-relative paths with a conflicting cwd file, absolute paths, file URLs, USART loopback, oscillator reset, TWI imports, browser/worker assets and strict TypeScript checks |
| Native state | `bun run oracle:simavr:compare` passed |
| Native workloads | `bun run oracle:simavr:result` passed all twelve scenarios |
| Native timing | `bun run oracle:simavr:timing` passed its five documented contracts |
| Native Optiboot | Serial transcript, programmed page and uploaded application comparison passed |
| Runtime probes | `bun run oracle:simavr:runtime` passed all three functional contracts; programming-duration and Timer1 TOP/BOTTOM native deviations remain explicit |
| Timer2 handshake | `bun run evidence:digital-models` passed both execution modes; raw native discrepancies at result offsets 2 and 5 remain recorded |

Native comparisons retain their stated normalizations and limitations; no
physical-hardware calibration is claimed. Publication, registry integrity,
published-consumer acceptance and the release tag are separate gates. Their
receipt will be recorded after actual publication.
