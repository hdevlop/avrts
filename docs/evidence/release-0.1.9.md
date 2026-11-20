# 0.1.9 release evidence

Date: 2026-11-20. Package: `@hdevlop/avrts@0.1.9`.

This release adds `avr.pin(n).settleInput(high)`: a host that samples its circuit
lazily hands the chip a level it learned late as one held all along. The INT0/INT1
detectors (including samples still in the synchronizer) and the pin-change detectors
take it as their last sample, so it raises no flag; the next change is an edge as
usual. Behaviour without the new call is unchanged. See
[the changelog](../../CHANGELOG.md).

## Preparation checks

| Boundary | Result |
| --- | --- |
| Tests | `bun test` passed all 3,052 tests across 91 files (3,047 carried over, 5 new in `test/settle-input.test.ts`); with the detectors not settled, 4 of the 5 fail |
| Release gate | `bun run release:check` passed: typecheck, generated-core freshness, all 3,052 tests, demo build, eight Chromium E2E tests, library/declaration build and package smoke |
| Result fidelity | `bun run bench:result` matched avr8js on all 12 workloads |
| Packed archive | `npm pack` produced the 88-file `hdevlop-avrts-0.1.9.tgz` (SHA-1 `9ae062d0125bb5a46085a26297fc8939911f7a3e`), packed again after the README gained the new call |
| Downstream consumer | KahrabaLab installed that archive: its 448 engine tests passed, including its Arduino sketch suite, where `attachInterrupt` now counts 100 edges per 100 ms of a 1 kHz input from the first window instead of 101 |
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
[`@hdevlop/avrts@0.1.9`](https://www.npmjs.com/package/@hdevlop/avrts/v/0.1.9)
with public access and the `latest` tag, replacing 0.1.8.

The source release commit is
[`b19e65a019c90b7e3f57831b919e7f555a4148ba`](https://github.com/hdevlop/avrts/commit/b19e65a019c90b7e3f57831b919e7f555a4148ba).
This publication receipt was added in a subsequent documentation commit.

| Boundary | Verified result |
| --- | --- |
| Git source | Release commit pushed to `origin/main`; worktree clean at publication |
| Release CI | [Run 44836629346](https://github.com/hdevlop/avrts/actions/runs/44836629346) passed all four jobs: Ubuntu Node 22, Ubuntu Node 24, Windows Node 22 and browser E2E |
| npm upload | `npm publish --access public` from the clean release commit succeeded; npm's `prepublishOnly` lifecycle (the release gate, 3,052 tests and package smoke) ran as part of the command and was not bypassed |
| Archive identity | The registry tarball, downloaded anonymously, is byte-identical to the `npm pack` archive consumer-tested during preparation |
| Public registry | Anonymous version endpoint returned 0.1.9; `latest` is 0.1.9; registry SHA-1, SHA-512 integrity and 88-file count match the archive |
| Published consumer | KahrabaLab installed 0.1.9 from the registry (lockfile integrity as below) and passed its 448 engine tests, workspace typecheck, lint, DC stress reference and the 19 Uno browser specs |
| Tag | Annotated `v0.1.9` pushed and verified on origin to identify release source commit `b19e65a019c90b7e3f57831b919e7f555a4148ba` |

Artifact: `hdevlop-avrts-0.1.9.tgz`, 88 files, 346,003 packed bytes, 1,837,161 unpacked.

- SHA-1: `9ae062d0125bb5a46085a26297fc8939911f7a3e`
- SHA-256: `2a77ae9c11671332a53a37feeda8aacc850d3f55df43a2b91bf3952fcee14586`
- npm integrity: `sha512-u5PUKWCmrzIPs105UEy3sQISKxeyqJOEk+Rmnfknw5s1SVh9qL0bgcolPJpuS4LelAKhmogl6Q6C/DNADgHyvg==`
- Registry tarball: <https://registry.npmjs.org/@hdevlop/avrts/-/avrts-0.1.9.tgz>

This local CLI publication did not generate an OIDC provenance attestation.
Source identity, successful CI and matching archive digests are recorded above.
