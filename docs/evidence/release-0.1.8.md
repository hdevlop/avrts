# 0.1.8 release evidence

Date: 2026-11-20. Package: `@hdevlop/avrts@0.1.8`.

This release makes pin changes cheaper. A write to PORTx, DDRx or PINx no longer
copies the port's subscribers into a new array or recomputes the port's level once
per watched pin; pin watchers share one computed level byte, recomputed after a
nested notification. Listener order and results are unchanged. See
[the changelog](../../CHANGELOG.md) and the
[performance summary](../performance-summary.md#2026-11-20-pin-change-notification).

## Preparation checks

| Boundary | Result |
| --- | --- |
| Tests | `bun test` passed all 3,047 tests across 90 files (3,044 carried over, 3 new in `test/gpio-notify.test.ts`); with the level byte never recomputed, one of them fails |
| Release gate | `bun run release:check` passed: typecheck, generated-core freshness, all 3,047 tests, demo build, eight Chromium E2E tests, library/declaration build and package smoke |
| Result fidelity | `bun run bench:result` matched avr8js on all 12 workloads |
| Speed | `bench:compare --isolate --repeats 5`, three alternating rounds: bitbang-crc +55%, peripheral-mix +20%, peripheral-bound +14%, isr-heavy +12%; the others within their run-to-run spread (table in the performance summary) |
| Packed archive | `npm pack` produced the 88-file `hdevlop-avrts-0.1.8.tgz` (SHA-1 `656f944cfafc98c9bc8b63784a3191ac692347df`) |
| Downstream consumer | KahrabaLab installed the packed archive: its 439 engine tests passed; its live Uno benchmark's ADC-from-DC case ran 8.60x real time against 6.57x on 0.1.7 |
| Native state | `bun run oracle:simavr:compare` passed |
| Native workloads | `bun run oracle:simavr:result` passed |
| Native timing | `bun run oracle:simavr:timing` passed |
| Native runtime | `bun run oracle:simavr:runtime` passed its functional contracts; existing native deviations remain explicit |
| Native Optiboot | `bun run oracle:simavr:optiboot` passed |
| Timer2 handshake | `bun run evidence:digital-models` passed |

Native comparisons retain their stated normalizations and limitations; no
physical-hardware calibration is claimed.

## Final publication receipt

Published on 2026-11-20 as
[`@hdevlop/avrts@0.1.8`](https://www.npmjs.com/package/@hdevlop/avrts/v/0.1.8)
with public access and the `latest` tag, replacing 0.1.7.

The source release commit is
[`34a4cc365035de91928736fba70f7b8191865f91`](https://github.com/hdevlop/avrts/commit/34a4cc365035de91928736fba70f7b8191865f91).
This publication receipt was added in a subsequent documentation commit.

| Boundary | Verified result |
| --- | --- |
| Git source | Release commit pushed to `origin/main`; worktree clean at publication |
| Release CI | [Run 44821038538](https://github.com/hdevlop/avrts/actions/runs/44821038538) passed all four jobs: Ubuntu Node 22, Ubuntu Node 24, Windows Node 22 and browser E2E |
| npm upload | `npm publish --access public` from the clean release commit succeeded; npm's `prepublishOnly` lifecycle (the release gate, 3,047 tests and package smoke) ran as part of the command and was not bypassed |
| Archive identity | The registry tarball, downloaded anonymously, is byte-identical to the `npm pack` archive consumer-tested during preparation |
| Public registry | Anonymous version endpoint returned 0.1.8; `latest` is 0.1.8; registry SHA-1, SHA-512 integrity and 88-file count match the archive |
| Published consumer | KahrabaLab installed 0.1.8 from the registry (lockfile integrity as below) and passed its 439 engine tests, workspace typecheck, lint, DC stress reference and the 19 Uno browser specs |
| Tag | Annotated `v0.1.8` pushed and verified on origin to identify release source commit `34a4cc365035de91928736fba70f7b8191865f91` |

Artifact: `hdevlop-avrts-0.1.8.tgz`, 88 files, 343,933 packed bytes, 1,831,183 unpacked.

- SHA-1: `656f944cfafc98c9bc8b63784a3191ac692347df`
- SHA-256: `87077ad50e3504d33723e1305dc18721f727ef1bb4e2ca3f903463959843a45f`
- npm integrity: `sha512-/dPfwgVbn7ekwWJqmjjvmC+YOHV1otHYXdB9szLWHm8KZpFmYk8hVBWVB6SPQVjiKkd3ws8lhVWcjgbEkKaK3Q==`
- Registry tarball: <https://registry.npmjs.org/@hdevlop/avrts/-/avrts-0.1.8.tgz>

This local CLI publication did not generate an OIDC provenance attestation.
Source identity, successful CI and matching archive digests are recorded above.
