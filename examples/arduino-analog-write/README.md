# Analog-write result fixture

Normal mode continuously drives PWM on D5/D9/D10/D11/D3 with compare values
191/64/192/51/128. The foreground is idle; hardware timers supply the work.

SRAM `0x02ff = 0x42` observes 20 ms of active PWM before publishing a 21-byte
block at `0x0300`. It stops timers and clears output latches after capturing
configuration, then writes completion last.

| Offset | Value |
| --- | --- |
| 0 | `0xa7` |
| 1-5 | OCR0B/OCR1A/OCR1B/OCR2A/OCR2B: `191,64,192,51,128` |
| 6-11 | TCCR0A/B, TCCR1A/B, TCCR2A/B: `23,3,161,3,161,4` |
| 12-13 | DDRB `14`, DDRD `40` |
| 14-18 | Zero |
| 19-20 | Tag `0x54`, completion `0x5c` |

The budget is five million cycles. Actual GPIO traces check periods and high
widths after startup: D5 period 16,384 clocks/high width 12,288; phase-correct
D3/D9/D10/D11 period 32,640/high width `2 * OCR * 64`. Period tolerance is four
CPU clocks; high-width tolerance is 128 clocks for sampled instruction boundaries.
At least four stable periods per pin are required. Endpoint duties remain
covered by the sensor-format fixture and timer unit tests.

avrts and avr8js validate all five waves. This native simavr build exposes D5's
fast-PWM GPIO trace but no phase-correct GPIO edges on the other four pins.
The native oracle declares that limitation explicitly and still compares SRAM
and configuration; it cannot prove those four physical waveforms.

```powershell
bun run bench:result --case analog-write
bun run oracle:simavr:result --case analog-write
```

## Regeneration

The tracked source, HEX and listing were rebuilt with Arduino AVR 1.8.8 / AVR
GCC 7.3.0 and the cached Uno core archive. The former bundled Arduino CLI is
unavailable on this host. With an installed CLI/core, `bun run fixtures:arduino`
is the normal regeneration command. For this host, use the complete manual
[build sequence](../../docs/evidence/arithmetic-results-2026-10-06.md#fixture-build-identity-and-regeneration),
selecting this fixture in its loop. Serial and PWM sketches without an explicit
include require `-include Arduino.h`, matching Arduino preprocessing. Consumers
and tests use committed HEX; they need no compiler.
