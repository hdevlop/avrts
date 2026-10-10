# Serial-print result fixture

Normal mode initializes USART at 9600 baud, prints `hello avrts\r\n` once, then
runs an idle foreground. Steady-cycle measurements after warmup are idle
execution, not sustained serial throughput.

SRAM `0x02ff = 0x42` selects finite mode. After `Serial.flush()` confirms the
last frame completed, a 21-byte block at `0x0300` records:

| Offset | Value |
| --- | --- |
| 0 | `0xa7` |
| 1 | TXC0 masked status, `0x40` |
| 2-5 | UCSR0B `0x98`, UCSR0C `6`, UBRR0L `207`, UBRR0H `0` |
| 6-18 | Zero |
| 19-20 | Tag `0x51`, completion `0x5c` |

The budget is five million cycles. Both peers check all bytes, configuration
and exact startup text. Fast and cycle-exact tests also check byte/text
subscribers, removal and reset without duplicate delivery. The listener case
shares this firmware rather than adding an independent workload.

```powershell
bun run bench:result --case serial-print
bun run oracle:simavr:result --case serial-print
bun test test/remaining-workload-results.test.ts
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
