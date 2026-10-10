# Expanded digital implementation acceptance - 2026-10-10

This record supersedes the earlier wire-model deferral in
[calibration scope](calibration-scope-2026-10-10.md) and the artifact in
[the earlier candidate record](release-candidate-2026-10-10.md). It does not
replace their historical evidence.

Source commit: `5d351936458901768b2d8a6fefa24fff5b53070a` on local branch
`codex/digital-model-candidate`. The isolated worktree is
`C:/Users/hdevlop/AppData/Local/Temp/avrts-digital-model-candidate-20261010`.
The user's main worktree and staging are preserved. The
[source identity receipt](digital-models-source-identity-2026-10-10.json)
compares 366 source, test, script, firmware, configuration and packed-documentation
inputs; only Windows checkout CRLF/LF differences are normalized.

## Implemented contracts

- Optional USART RXD/TXD/XCK signaling: asynchronous 5-9 bit frames, sampled
  start/parity/stop errors, synchronous USART and MSPIM, external/generated XCK.
- Optional SPI master/slave GPIO shifts: all CPOL/CPHA combinations, both bit
  orders, SS selection, direction/output ownership and collision acknowledgement.
- Optional TWI open-drain master/slave operation: START/repeated START/STOP,
  bit-level ACK/NACK, clock stretching, arbitration and `createTwiBus()` for
  multiple AVR endpoints. The caller advances endpoint CPUs.
- Configurable automatic Timer2 TOSC frequency and explicit EXCLK rising edges;
  asynchronous register transfers, PSRASY and flag-clear acknowledgement.
- Logical DIDR input-read suppression, optional interrupt input synchronization,
  comparator propagation/settling and a host-provided OSCCAL frequency curve.

[Wire/clock documentation](../wire-models.md) describes the APIs, modes, pin
directions and clock policies. Legacy byte APIs remain the default. No oscillator
calibration curve or physical propagation measurement is invented.

## Review fixes and regression boundaries

Regression tests run in both execution modes and cover partial-transfer
snapshots, power/sleep gating, reset, alternate-function pin ownership and mode
changes. Fixes include SPI slave MISO release while SS is high; latched in-flight
SPI data and DORD; avoiding phantom USART/SPI edges on restore; deferring a gated
USART TX start; resuming TWI after external stretching without polling; preserving
slave address detection after lost arbitration; and avoiding a receiver STOP
status after slave transmission.

Timer2 regressions cover source switching with pending writes, stopped-clock
PSRASY acknowledgement, repeated sleep before flag-clear acknowledgement and
manual source snapshots without serialized Infinity. Comparator/interrupt tests
cover short excursions, delayed samples and snapshot continuation. OSCCAL tests
cover validation, copied curves, CLKPR and internal-RC-only application.

## Independent evidence and retained tradeoffs

[Compiled Timer2 handshake evidence](digital-models-probe-2026-10-10.json)
keeps the native result raw. AVRts in both modes returns
`a7 02 00 03 02 03 00 5c`; native simavr differs at offsets 2 and 5. Its PSRASY
does not acknowledge and its wake-read policy differs. Peer agreement is not
substituted for the independently specified digital policy. The candidate rerun
uses the identical compiled fixture and retains the same differences.

Existing state, five timing, three runtime and Optiboot comparisons, plus all
twelve workloads against both peers, remain separate gates. Native programming
durations, Timer1 TOP behavior and unavailable phase-correct PWM GPIO traces
retain the qualifications in the earlier evidence.

The focused performance comparison uses Bun 1.3.14 on the recorded Windows/i7
host, identical candidate firmware, nine trials, 50 million cycles per trial,
500,000 warmup cycles and no pin/serial observers. Construction is excluded.
[Bit-banging samples](digital-models-performance-bitbang-2026-10-10.json) measure
17.94 to 17.28 million cycles/s, about 3.6% slower than the previous candidate.
[Peripheral-bound samples](digital-models-performance-peripheral-2026-10-10.json)
measure 22.94 to 23.11 million cycles/s, about 0.7% faster and within ordinary
variation. These are narrow host-specific comparisons, not broad runtime or
silicon speed claims. Inactive wire listeners are detached in default byte mode.

## Final acceptance

| Boundary | Result |
| --- | --- |
| Source | TypeScript/generated checks; 2,973 passed, four compiler cases skipped, zero failed; 18,917 assertions, 84 files, 342.53 seconds |
| Compiler supplement | All six compiler tests passed with installed AVR GCC 7.3.0, including all four previously skipped cases; zero skips/failures |
| Browser | Eight Chromium tests passed, 4.1 seconds |
| Workload results | Twelve cases pass against avr8js and twelve against native simavr |
| Native | State, five timing probes, three runtime probes and Optiboot pass their stated contracts |
| Package | Build/declarations and 88-file consumer smoke passed |
| Retained archive | Exact Node/Bun imports and USART wire loopback, TWI bus, browser bundle, worker assets/URLs and TypeScript checks passed |
| npm dry run | Passed on the retained tarball; file list, SHA-1 and SHA-512 integrity match |
| Source identity | 366 inputs match the frozen candidate with only CRLF/LF normalization |

[Machine-readable acceptance](digital-models-local-acceptance-2026-10-10.json)
contains package metadata, the complete file list, command/log identities and
separate external gate statuses. The full suite retains its normal optional
compiler skips when no local toolchain is configured; the focused supplement
used `AVR_GCC_BIN` to execute those cases without changing source.

Artifact: `out/digital-models-release-2026-10-10/hdevlop-avrts-0.1.2.tgz`.
Packed/unpacked bytes: 330,600 / 1,754,250.
SHA-256: `e4278407517db58f11c762d6901cd1a5d2708c96b4d6196b76514e1e40fc5000`.
The archive was built/packed with the candidate clean at the source commit
above. A later local documentation commit records acceptance without changing
source, build configuration or packed README/changelog. No lifecycle checks
were removed; packing ran `prepack`, and the dry run targets the already checked
archive without an `--ignore-scripts` flag.

Physical timing calibration requires identified hardware and captured
measurements and remains unrun. Electrical noise/leakage/current, memory wear,
power-loss corruption and debugWIRE remain documented exclusions. Git push,
exact-commit CI, npm publication and published-consumer verification have not
been performed.
