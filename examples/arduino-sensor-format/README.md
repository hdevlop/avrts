# Arduino sensor-format fixture

This continuous Uno workload reads a calibration table from flash, applies
Arduino's integer `map`, accumulates weighted samples, updates a 16-slot circular
history, drives D3/D9 PWM, and formats a serial line every 128 samples.

The committed HEX and listing are consumed directly by tests and benchmarks.
They do not require a compiler at runtime. Ordinary execution stays continuous.

## Finite result mode

Set SRAM `0x02ff` to `0x42` before execution to select the 144-sample result mode.
The little-endian word at `0x02fc..0x02fd` supplies the starting sample index;
zero is the default. These reserved bytes and `0x0300..0x0334` are outside this
fixture's linked globals and below its stack. No runtime feature depends on them.

The fixture waits for `Serial.flush()` (including TXC0), disables interrupts,
captures the PWM settings, stops Timer1/Timer2 and clears both output latches.
It writes the final marker last, then halts without changing the result.

| Result offset | Meaning |
| --- | --- |
| 0 | Start marker `0xa7` |
| 1-2 | Next sample index, unsigned 16-bit little-endian |
| 3-6 | Accumulator, unsigned 32-bit little-endian |
| 7 | Last computed duty |
| 8-9 | Last raw sample, unsigned 16-bit |
| 10-11 | Last scaled sample, signed 16-bit representation |
| 12 | OCR2B before stopping PWM |
| 13-14 | OCR1A before stopping PWM, unsigned 16-bit |
| 15-16 | TCCR2A / TCCR1A before stopping PWM |
| 17-18 | UCSR0B / UCSR0A masked to TXC0 after flushing |
| 19 | Scenario tag `0x53` |
| 20-51 | All 16 history entries, unsigned 16-bit little-endian |
| 52 | Completion marker `0x5c` |

Both result CLIs use a five-million-cycle default budget and compare all 53
bytes, exact serial bytes, and the common register summary. A host specification
independently computes integer scaling, unsigned wrapping, history, Arduino's
PWM endpoint rules and CRLF formatting. No sensor fields are normalized.

```powershell
bun run bench:result --case sensor-format
bun run oracle:simavr:result --case sensor-format
bun run bench:result --case sensor-format --sensor-start 65520
bun run oracle:simavr:result --case sensor-format --sensor-start 65520
bun test test/sensor-format-results.test.ts
```

`--sensor-start` accepts integers from 0 through 65535. Recorded cases start at
0, 128, 65520 (16-bit wrap), 112 (final duty 255), and 383 (final duty 0).
The endpoint cases check that PWM disconnects while OCR retains its prior duty.
Fast and cycle-exact tests also verify continuous activity and snapshot/resume
while both UART transmit stages are occupied. See the
[dated evidence](../../docs/evidence/sensor-format-results-2026-10-10.md).

## Regenerating the fixture

With Arduino CLI and the Uno core installed, run:

```powershell
bun run fixtures:arduino
```

The October 10 local rebuild used installed Arduino AVR 1.8.8 / AVR GCC 7.3.0
and a verified cached Uno core archive because the former bundled CLI was
unavailable. The complete manual command sequence is in the
[arithmetic build record](../../docs/evidence/arithmetic-results-2026-10-06.md#fixture-build-identity-and-regeneration);
set its fixture list to `@('arduino-sensor-format')`. Archive paths are specific
to that host. Source, HEX and listing must be rebuilt together, and any changed
expected bytes must be reviewed against the independent specifications and
reference engines. Historical speed measurements describe preceding HEX images;
this result-mode rebuild does not establish a new throughput measurement.
