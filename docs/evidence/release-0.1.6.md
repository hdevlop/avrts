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
physical-hardware calibration is claimed. Publication, registry integrity,
published-consumer acceptance and the release tag are separate gates. Their
receipt will be recorded after actual publication.
