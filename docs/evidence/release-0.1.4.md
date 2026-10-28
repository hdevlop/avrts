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
physical-hardware calibration is claimed.

## Final publication receipt

Published on 2026-10-28 as
[`@hdevlop/avrts@0.1.4`](https://www.npmjs.com/package/@hdevlop/avrts/v/0.1.4)
with public access and the `latest` tag, replacing 0.1.3.

The source release commit is
[`6dec5e9a9c342a51325febb3d3cc81b76902e04b`](https://github.com/hdevlop/avrts/commit/6dec5e9a9c342a51325febb3d3cc81b76902e04b).
This publication receipt was added in a subsequent documentation commit.

| Boundary | Verified result |
| --- | --- |
| Git source | Release commit pushed to `origin/main`; worktree clean for the publication gate, archive preparation, dry run and upload |
| Release CI | [Run 40776188661](https://github.com/hdevlop/avrts/actions/runs/40776188661) passed all four jobs: Ubuntu Node 22, Ubuntu Node 24, Windows Node 22 and browser E2E |
| Publication gate | `npm.cmd run prepublishOnly` passed on the clean release commit: 3,019 tests, zero failures across 87 files; eight Chromium tests; builds and package smoke |
| Archive inspection | `npm.cmd pack` ran `prepack`; the 88-file archive contains bundled output and release documentation, with no source/test/script directories; exact-archive consumer smoke passed |
| npm dry run | Publishing the inspected tarball with `--dry-run --access public --tag latest` passed |
| npm upload | `npm.cmd publish out/release-0.1.4/hdevlop-avrts-0.1.4.tgz --access public --tag latest` succeeded; registry processing completed before final verification |
| Public registry | Anonymous version endpoint returned HTTP 200; exact version and `latest` are both 0.1.4; registry SHA-1 and SHA-512 integrity match the inspected archive |
| Published consumer | A fresh temporary consumer downloaded the registry package and passed the full Node/Bun, regression/path, browser/worker and strict TypeScript smoke checks described above |
| Tag | Annotated `v0.1.4` pushed and verified to identify release source commit `6dec5e9a9c342a51325febb3d3cc81b76902e04b` |

The explicit publication gate ran before uploading the same inspected archive;
`prepublishOnly` was retained and no publication used `--ignore-scripts`.

Artifact: `hdevlop-avrts-0.1.4.tgz`, 88 files, 333,764 packed bytes.

- SHA-1: `25ee8530dd4f5c76adb353d184e4108590f633b9`
- SHA-256: `75628bcb1f2dccbd170966eb54622cf942ed6c8366eb5d473c5c63f472ae0f75`
- npm integrity: `sha512-g8FzZM0iJTEZwSqg9U/+R6RaMrqhBlIai2WNthtQMThaFE8JFD55dfJXpTKCKrWHzVn/vgZB4J7mJ2kizVGxwg==`
- Registry tarball: <https://registry.npmjs.org/@hdevlop/avrts/-/avrts-0.1.4.tgz>

This local CLI publication did not generate an OIDC provenance attestation.
Source identity, successful CI and matching archive digests are recorded above.
