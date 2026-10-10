# Delay-blink result fixture

Normal mode repeatedly drives D13 high for `delay(1000)`, then low for
`delay(1000)`, using compiled Arduino Timer0 timekeeping.

SRAM `0x02ff = 0x42` stops after two complete periods (four seconds). GPIO
must emit `high, low, high, low`, with each transition interval 16,000,000
CPU clocks within 32,768 clocks of Arduino millisecond quantization. The result
budget is 70 million cycles, rather than the five-million default used by
shorter fixtures.

The 21-byte block at `0x0300` is `a7`, period count `2`, PORTB `0`, DDRB `32`,
TCCR0A `3`, TCCR0B `3`, thirteen zero bytes, tag `0x52`, completion `0x5c`.
The completion marker is written last after interrupts are disabled.

```powershell
bun run bench:result --case delay-blink
bun run oracle:simavr:result --case delay-blink
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
