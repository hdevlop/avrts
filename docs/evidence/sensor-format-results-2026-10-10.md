# Sensor-format result oracle — 2026-10-10

This local development slice completes `sensor-format` result coverage in
[Phase 1](../../AVRTS-REMAINING-WORK-PLAN.md#5-phase-1--complete-benchmark-result-fidelity).
It follows the arithmetic slice on baseline commit
`859b7fef58ac5864618c01d484c6bcf64b077d89`. Changes remain uncommitted.
Emulator library source and public APIs are unchanged by this slice.

## Behavior and proof

Normal firmware keeps sampling, driving PWM and printing periodically. Setting
SRAM `0x02ff` to `0x42` selects a finite 144-sample run; the unsigned little-endian
word at `0x02fc` supplies its starting index. After `Serial.flush()` confirms the
last frame has completed, the fixture captures its full history and output
configuration, stops PWM, writes the 53-byte result at `0x0300`, then halts.
The completion marker is the last byte at `0x0334`.

Both harnesses now use a scenario-specific result length. Earlier fixtures keep
their 21-byte layout. The new `--sensor-start` argument accepts `0..65535`, and
both default `all` selections include the eighth workload. The default budget
is five million CPU cycles; this fixture needs no host-side flush tail.

An independent host specification calculates the integer `map` result,
32-bit accumulation, 16-bit sample-index wrap, all 16 history entries, PWM
endpoint behavior, and exact ASCII/CRLF output. Comparison includes pre-stop
OCR1A/OCR2B and timer configuration, UART TXC0, and the common final register
summary. Duty 0/255 disconnects PWM while retaining the previous OCR value.
The final output latches are deliberately cleared after capturing configuration.
No sensor result fields or registers are normalized.

The [fixture README](../../examples/arduino-sensor-format/README.md) specifies
every result offset and the build procedure. The
[raw capture](sensor-format-results-2026-10-10.json) includes expected bytes,
all three engine outcomes, input arguments, differences, versions, and HEX hash.

| Starting index | Boundary exercised | Serial bytes | avrts cycles | avr8js cycles | simavr cycles |
| --- | --- | --- | --- | --- | --- |
| 0 | Two printed lines, circular history replacement | 60 | 1,110,032 | 1,005,736 | 1,101,585 |
| 128 | Later calibration/formatting window | 61 | 1,120,041 | 1,022,445 | 1,119,910 |
| 65520 | Unsigned index wraps through zero | 29 | 560,017 | 504,636 | 551,031 |
| 112 | Final duty 255, PWM disconnected | 31 | 590,016 | 538,058 | 587,652 |
| 383 | Final duty 0, PWM disconnected | 62 | 1,140,032 | 1,040,135 | 1,139,261 |

All rows pass both peer comparisons and the host specification with zero
differences and zero normalizations. Cycle counts describe execution envelopes;
they are neither throughput measurements nor an assertion of identical engine
timing. avrts checks completion in bounded chunks, while the other harnesses
check after individual instructions. avr8js reports UART bytes when queued;
avrts reports transmitted bytes. Firmware waits for TXC0 before publishing its
result, and avrts tests verify both UART stages are empty at completion.

## Checks

- Focused sensor/arithmetic tests: 29 passed, zero failed, 313 assertions.
- Full `bun run verify`: TypeScript and generated-core checks passed; 2,772 tests,
  zero failures, 17,999 assertions across 76 files (301.40 seconds).
- `bun run bench:result`: all eight default result cases passed.
- `bun run oracle:simavr:result`: all eight default result cases passed.
- Five sensor variants above: both references and independent expectations passed.
- Native timing: all five selected probes passed with existing documented normalizations.
- Native state smoke and Optiboot transcript/flash/application checks passed.

The thirteen new tests also cover continuous execution beyond warmup in both
timing modes, snapshot/restore while the UART shift register and buffer are
occupied, stable results after halt, no late serial bytes, corrupted history,
truncated result/UART output, an insufficient cycle budget, and invalid inputs
rejected by both CLIs. Existing arithmetic regressions remain passing.

Browser/package acceptance and CI were not rerun for this development fixture
and harness change. No package publication was attempted. The earlier release
preparation record retains its original artifact and validation scope.

## Build identity and reproduction

Local HEX-file-byte SHA-256:
`6e49d1087f7d540c8e4b7debed3ffe8b3b6ba7c562a9181663d48c6e8120165c`.
Text checkout newline conversion can alter this digest without altering flash
contents. The source, HEX and disassembly were regenerated together using
Arduino AVR 1.8.8, AVR GCC 7.3.0 and a verified cached Uno core archive. The
former bundled Arduino CLI was unavailable. The
[manual build sequence](arithmetic-results-2026-10-06.md#fixture-build-identity-and-regeneration)
applies with its fixture list set to `@('arduino-sensor-format')`.

```powershell
bun test test/sensor-format-results.test.ts test/arithmetic-results.test.ts
bun run verify
bun run bench:result
bun run oracle:simavr:result
foreach ($taskStart in @(0, 128, 65520, 112, 383)) {
  bun run bench:result --case sensor-format --sensor-start $taskStart
  bun run oracle:simavr:result --case sensor-format --sensor-start $taskStart --json
}
bun run oracle:simavr:timing
bun run oracle:simavr:compare
bun run oracle:simavr:optiboot
```

These checks consume committed firmware artifacts and do not require fixture
compilation. The native checks require the local simavr library/helper toolchain.
Historical sensor-format speed ratios describe the previous firmware image;
this rebuild makes no new performance claim.

Next: add `serial-print` startup-output and TX-completion checks, including
shared `serial-print-listener` byte/text delivery. `analog-write`, `delay-blink`
and `tight-loop` remain later Phase 1 work.
