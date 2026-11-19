# 0.1.5 release evidence

Date: 2026-11-19. Package: `@hdevlop/avrts@0.1.5`.

This release moves three behaviours to the datasheet and adds a host-driven ADC
sample point. USART byte mode paces frames by their start, data, parity and stop
bits (8N1: 10 bit times; 0.1.4 added native simavr's extra idle bit, so serial ran
10% slow). Fast PWM changes its compare output on the clock that leaves OCR, giving
the datasheet duty `(OCR + 1) / (TOP + 1)`. ADC results use `Vin * 1024 / Vref`
truncated, and `useAnalogSampler`/`useAnalogReference` let a circuit-solving host
answer each conversion at its sample point. See [the changelog](../../CHANGELOG.md).

## Preparation checks

| Boundary | Result |
| --- | --- |
| Dependencies | `bun install --frozen-lockfile` passed without dependency changes |
| Release gate | `bun run release:check` passed: typecheck, generated-core freshness, all 3,026 tests across 88 files (3,019 carried over, 7 new datasheet-timing tests), demo build, eight Chromium E2E tests, library/declaration build and package smoke |
| Packed archive | `npm pack` produced the 88-file `hdevlop-avrts-0.1.5.tgz`; package smoke passed |
| Downstream consumer | KahrabaLab (circuit simulator) installed the packed archive: its 427 engine tests, including the Uno firmware/circuit coupling through `useAnalogSampler`, passed |
| Native state | `bun run oracle:simavr:compare` passed |
| Native workloads | `bun run oracle:simavr:result` passed all twelve scenarios |
| Native timing | `bun run oracle:simavr:timing` passed its contracts; USART TXC is compared with native simavr's idle bit removed (simavr 188, avrts 173 cycles at UBRR0 = 0: one 16-cycle bit within the fixture's 5-cycle poll loop) |
| Native Optiboot | Serial transcript, programmed page and uploaded application comparison passed |
| Runtime probes | `bun run oracle:simavr:runtime` passed its functional contracts; programming-duration and Timer1 TOP/BOTTOM native deviations remain explicit |
| Timer2 handshake | `bun run evidence:digital-models` passed both execution modes |

## Behaviour changes and their tests

| Change | Evidence |
| --- | --- |
| 8N1 frames 10 bit times | `test/datasheet-timing-0-1-5.test.ts`: back-to-back TX completions and host RX arrivals 16,640 cycles apart at 9600 baud; USART suites updated from 176 to 160 cycles at UBRR0 = 0 |
| Fast-PWM duty `(OCR + 1) / (TOP + 1)` | Timer0 OCR0A = 64 high for 65 of 256 clocks; Timer0/1/2 boundary, buffering and toggle suites moved one timer clock where they asserted the old edge; the Arduino `analogWrite(5, 191)` golden fixture now reports 75% |
| ADC sampler and references | sampler called at the sample point (13.5 ADC clocks into the first conversion) with channel, cycle and reference; AVcc, AREF and 1.1 V conversions; `undefined` fallback; internal channels not sampled; non-finite values and invalid rails rejected |

Native comparisons retain their stated normalizations and limitations; no
physical-hardware calibration is claimed.

## Final publication receipt

Published on 2026-11-19 as
[`@hdevlop/avrts@0.1.5`](https://www.npmjs.com/package/@hdevlop/avrts/v/0.1.5)
with public access and the `latest` tag, replacing 0.1.4.

The source release commit is
[`6ddae0b23187dab3f4e3ff8613ca2d0b9434e4fe`](https://github.com/hdevlop/avrts/commit/6ddae0b23187dab3f4e3ff8613ca2d0b9434e4fe).
This publication receipt was added in a subsequent documentation commit.

| Boundary | Verified result |
| --- | --- |
| Git source | Release commit pushed to `origin/main`; worktree clean at publication |
| Release CI | [Run 44600928383](https://github.com/hdevlop/avrts/actions/runs/44600928383) passed all four jobs: Ubuntu Node 22, Ubuntu Node 24, Windows Node 22 and browser E2E |
| npm upload | `npm publish --access public` from the clean release commit succeeded; npm's `prepublishOnly` lifecycle (the release gate) ran as part of the command and was not bypassed. Unlike 0.1.4, no separate dry run preceded the upload; the archive inspected during preparation was instead compared byte for byte with the published one below |
| Archive identity | The published archive's SHA-1 and SHA-512 equal those of the `npm pack` archive inspected and consumer-tested during preparation |
| Public registry | Anonymous version endpoint returned HTTP 200; `latest` is 0.1.5; registry SHA-1, SHA-512 integrity and 88-file count match the archive |
| Published consumer | KahrabaLab installed 0.1.5 from the registry (lockfile integrity as below) and passed its 427 engine tests, workspace typecheck and the 19 Uno browser specs |
| Tag | Annotated `v0.1.5` pushed and verified to identify release source commit `6ddae0b23187dab3f4e3ff8613ca2d0b9434e4fe` |

Artifact: `hdevlop-avrts-0.1.5.tgz`, 88 files, 340,315 packed bytes, 1,787,414 unpacked.

- SHA-1: `0f5f3d1abef49d9fc8129835d7e92de83314c15d`
- SHA-256: `b06febb6741ec0ea54bfc6e7f418088d2e0776d78cc07886f9f52c12361e4683`
- npm integrity: `sha512-xMea14YMxdx9x0j57p1rQS7RAjGbZbcVPK3cohYBDv+FbjE3kivKhx4IYoLTn8/VMKRs29hEMNHN3dq60lsIUw==`
- Registry tarball: <https://registry.npmjs.org/@hdevlop/avrts/-/avrts-0.1.5.tgz>

This local CLI publication did not generate an OIDC provenance attestation.
Source identity, successful CI and matching archive digests are recorded above.
