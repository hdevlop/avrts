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
physical-hardware calibration is claimed. Publication, registry integrity,
published-consumer acceptance and the release tag are separate gates. Their
receipt will be recorded after actual publication.
