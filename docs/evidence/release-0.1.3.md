# 0.1.3 release evidence

Date: 2026-10-24. Package: `@hdevlop/avrts@0.1.3`.

The release includes the previously unpublished 0.1.2 digital models and the
library review fixes for bit writes, synchronous USART edges, programming
deadlines, Timer2 restore, factory OSCCAL configuration, Intel HEX validation,
and erased program memory. See [the changelog](../../CHANGELOG.md).

The source release commit is the commit containing this preparation record.
The earlier October 6/10 evidence remains historical; its artifact digests and
test counts are not claims about the 0.1.3 package.

## Preparation checks

| Boundary | Result |
| --- | --- |
| Dependencies | `bun install --frozen-lockfile` passed without dependency changes |
| Source | Typecheck and generated-core freshness passed |
| Unit suite | All 3,005 tests across 87 files passed in two disjoint file groups plus the corrected clock-fixture rerun; no outstanding failures |
| Original probes | SBI/CBI expected GPIO/flag values; zero mismatches at 258 EEPROM restore points and 105 powered-reset points; Timer2 PSRASY clears after restore into a sleeping target |
| Browser | Demo build and all eight Chromium tests passed |
| Native state | `bun run oracle:simavr:compare` passed |
| Native workloads | `bun run oracle:simavr:result` passed all twelve scenarios |
| Native timing | `bun run oracle:simavr:timing` passed its five documented probe contracts |
| Native Optiboot | Serial transcript, programmed page and uploaded application comparison passed |
| Runtime probes | `bun run oracle:simavr:runtime` passed its three functional contracts; programming-duration and Timer1 TOP/BOTTOM native deviations remain explicit |
| Package | Library/declaration build and Node/Bun consumer smoke passed during the library review; repeated by the publication lifecycle for 0.1.3 |

The native comparisons retain their stated normalizations and limitations.
They do not establish physical-hardware calibration. Electrical noise/current,
wear, power-loss corruption and debugWIRE remain outside the implemented scope.

## Publication

At preparation, the registry latest version was 0.1.1 and npm authenticated as
`hdevlop`. Version 0.1.3 was selected as the next version of the local 0.1.2
candidate. Git push, exact-release-commit CI, the final publication lifecycle,
registry integrity and a fresh published consumer must be verified separately.
Their final receipts will be appended after those operations complete.
