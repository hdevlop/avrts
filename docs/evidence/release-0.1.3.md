# 0.1.3 release evidence

Date: 2026-10-24. Package: `@hdevlop/avrts@0.1.3`.

The release includes the previously unpublished 0.1.2 digital models and the
library review fixes for bit writes, synchronous USART edges, programming
deadlines, Timer2 restore, factory OSCCAL configuration, Intel HEX validation,
and erased program memory. See [the changelog](../../CHANGELOG.md).

The source release commit is
[`dea3d60b5dee86371603769b915aa42fbaf44ff8`](https://github.com/hdevlop/avrts/commit/dea3d60b5dee86371603769b915aa42fbaf44ff8).
The publication receipt below was added in a subsequent documentation commit.
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
| Package | Library/declaration build and Node/Bun consumer smoke passed for 0.1.3 |

The native comparisons retain their stated normalizations and limitations.
They do not establish physical-hardware calibration. Electrical noise/current,
wear, power-loss corruption and debugWIRE remain outside the implemented scope.

## Final publication receipt

Published on 2026-10-24 as
[`@hdevlop/avrts@0.1.3`](https://www.npmjs.com/package/@hdevlop/avrts/v/0.1.3)
with public access and the `latest` tag. The previous registry latest was 0.1.1;
the prepared local 0.1.2 candidate was never published.

| Boundary | Verified result |
| --- | --- |
| Git source | Release commit `dea3d60b5dee86371603769b915aa42fbaf44ff8` pushed to `origin/main` |
| Release CI | [Run 40093178836](https://github.com/hdevlop/avrts/actions/runs/40093178836) passed all four jobs: Ubuntu Node 22, Ubuntu Node 24, Windows Node 22, and browser E2E |
| Publication gate | `npm.cmd run prepublishOnly` passed on the clean release commit, preserving the configured `release:check`: 3,005 tests, zero failures across 87 files; eight Chromium tests; library/declarations and package consumer smoke |
| Archive inspection | `npm.cmd pack` ran `prepack`; the 88-file archive contains bundled output and release documentation, with no source/test/script directories |
| npm dry run | Publishing the inspected tarball with `--dry-run --access public` passed |
| npm upload | `npm.cmd publish out/release-0.1.3/hdevlop-avrts-0.1.3.tgz --access public --tag latest` succeeded; registry processing completed before final verification |
| Public registry | Anonymous version endpoint returned HTTP 200; exact version and `latest` are both 0.1.3; registry SHA-1 and SHA-512 integrity match the inspected archive |
| Published consumer | A fresh temporary consumer downloaded the registry package and passed Node/Bun imports, USART wire loopback, erased-flash and OSCCAL reset checks, shared TWI bus, browser bundle/worker assets and URLs, and strict TypeScript declaration checks |
| Tag | Annotated `v0.1.3` identifies the release source commit; the later receipt commit changes documentation only |

The explicit publication gate ran before uploading the same inspected archive;
the `prepublishOnly` script was retained and no publication used `--ignore-scripts`.

Artifact: `hdevlop-avrts-0.1.3.tgz`, 88 files, 331,941 packed bytes.

- SHA-1: `10d0b584bb2e60fd34402e60e028639c24d5d922`
- SHA-256: `fc5a4e0b8f37916d0b213f6c09e2b254fffa333dc5f7dbce41204d681534ed1c`
- npm integrity: `sha512-4GVpJLITqRf3FTs6aKgVGaKWuBFfIaryvaWV2nu7v3F1cF/ij3owmmhIx705WK+1f0K0ilY69jlU/kDOLTYySg==`
- Registry tarball: <https://registry.npmjs.org/@hdevlop/avrts/-/avrts-0.1.3.tgz>

This local CLI publication did not generate an OIDC provenance attestation.
The source commit, successful CI run and matching archive digests are recorded
separately above.
