# 0.1.6 release evidence

Date: 2026-11-19. Package: `@hdevlop/avrts@0.1.6`.

This release makes the Timer0/1/2 compare pins show each channel's OCnx latch.
0.1.5 drove a pin to its BOTTOM level whenever COM bits were written while the
counter was at 0, so fast PWM enabled before the timer started went high a full
period early. The latch is now low after reset and changes only on compare,
BOTTOM/TOP and force-compare events; COM bits connect the pin to it. See
[the changelog](../../CHANGELOG.md).

## Preparation checks

| Boundary | Result |
| --- | --- |
| Tests | `bun test` passed all 3,031 tests across 89 files (3,026 carried over, 5 new in `test/output-compare-latch.test.ts`) |
| Release gate | `bun run release:check` passed: typecheck, generated-core freshness, all 3,031 tests, demo build, eight Chromium E2E tests, library/declaration build and package smoke |
| Packed archive | `npm pack` produced the 88-file `hdevlop-avrts-0.1.6.tgz` (SHA-1 `d274d1f78951942331c460ec6c4f2048ed303685`) |
| Downstream consumer | KahrabaLab installed the packed archive: its 427 engine tests passed; its Uno RC-load PWM test now sees the first OC0A high at the first overflow (cycle 16,384) instead of at the COM write (cycle 17) |
| Native state | `bun run oracle:simavr:compare` passed |
| Native workloads | `bun run oracle:simavr:result` passed |
| Native timing | `bun run oracle:simavr:timing` passed with the USART TXC normalization recorded for 0.1.5 |
| Native runtime | `bun run oracle:simavr:runtime` passed its functional contracts; existing native deviations remain explicit |
| Native Optiboot | `bun run oracle:simavr:optiboot` passed |
| Timer2 handshake | `bun run evidence:digital-models` passed |

## Behaviour change and its tests

| Change | Evidence |
| --- | --- |
| COM write connects the pin to the latch | `test/output-compare-latch.test.ts`: OC0A stays low after fast PWM is enabled at TCNT0 = 0 and first rises on the TOP -> BOTTOM clock; reconnecting COM mid-pulse restores the latched high level; `analogWrite`-style enabling on a running timer starts low; snapshots carry the latch and reset clears it; Timer1 WGM 5 and Timer2 WGM 3 follow the same first period |
| Updated expectations | 25 existing assertions expected the BOTTOM level (or a steady 0%/100% level) the instant COM was written. They now expect the reset-low latch until the first waveform event, then the same waveform as before. The normal-mode clear-on-match case presets the latch with FOC0B, as the datasheet advises |

Native comparisons retain their stated normalizations and limitations; no
physical-hardware calibration is claimed.

## Final publication receipt

Published on 2026-11-19 as
[`@hdevlop/avrts@0.1.6`](https://www.npmjs.com/package/@hdevlop/avrts/v/0.1.6)
with public access and the `latest` tag, replacing 0.1.5.

The source release commit is
[`675b7df1070d163924ed6ec8136f5bd244f549f9`](https://github.com/hdevlop/avrts/commit/675b7df1070d163924ed6ec8136f5bd244f549f9).
This publication receipt was added in a subsequent documentation commit.

| Boundary | Verified result |
| --- | --- |
| Git source | Release commit pushed to `origin/main`; worktree clean at publication |
| Release CI | [Run 44619499994](https://github.com/hdevlop/avrts/actions/runs/44619499994) passed all four jobs: Ubuntu Node 22, Ubuntu Node 24, Windows Node 22 and browser E2E |
| npm upload | `npm publish --access public` from the clean release commit succeeded; npm's `prepublishOnly` lifecycle (the release gate) ran as part of the command and was not bypassed. No separate dry run preceded the upload; the archive inspected during preparation was compared byte for byte with the published one below |
| Archive identity | The published archive's SHA-1 and SHA-512 equal those of the `npm pack` archive consumer-tested during preparation |
| Public registry | Anonymous version endpoint returned the version; `latest` is 0.1.6; registry SHA-1, SHA-512 integrity and 88-file count match the archive |
| Published consumer | KahrabaLab installed 0.1.6 from the registry (lockfile integrity as below) and passed its 427 engine tests, workspace typecheck, lint, DC stress reference and the 19 Uno browser specs |
| Tag | Annotated `v0.1.6` pushed and verified on origin to identify release source commit `675b7df1070d163924ed6ec8136f5bd244f549f9` |

Artifact: `hdevlop-avrts-0.1.6.tgz`, 88 files, 340,878 packed bytes, 1,790,497 unpacked.

- SHA-1: `d274d1f78951942331c460ec6c4f2048ed303685`
- SHA-256: `5b78a46e930de5fe5b38b2c1bd7513f8a863e1382876b6547ae425af8184c8e4`
- npm integrity: `sha512-x/qERz5pPmuOYiqteGZBIHDe+AiZEKAIFXer/j3BbMU/qdFaaoD5SOb6uXvxl0L035C19erhRBtw9YFZQc7IgQ==`
- Registry tarball: <https://registry.npmjs.org/@hdevlop/avrts/-/avrts-0.1.6.tgz>

This local CLI publication did not generate an OIDC provenance attestation.
Source identity, successful CI and matching archive digests are recorded above.
