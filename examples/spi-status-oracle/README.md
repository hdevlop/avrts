# SPI status access probe

This avr-libc fixture records eight bytes at SRAM `0x0300`. Fixed NOP waits
allow a master byte to complete without polling SPSR and accidentally arming
the subsequent SPDR acknowledgement.

The datasheet-based avrts result is `a7 80 80 40 00 c0 00 5c`: an unarmed read
or a new transfer preserves flags, WCOL sets on a rejected write, and the
status/data access sequence clears flags. Both source execution modes check
the committed HEX in `test/spi-status-sequence.test.ts`.

Rebuild C, HEX and disassembly with `bun run fixtures:avr-gcc`, using
`-mmcu=atmega328p -Os -DF_CPU=16000000UL`.

Probe native simavr independently:

```powershell
bun scripts/simavr-oracle.ts --hex examples/spi-status-oracle/spi-status-oracle.hex --cycles 10000 --no-default-dumps --dump result:0x300:8 --json
```

The local native probe returns `a7 00 00 00 00 00 00 5c`, which disagrees with
the specified status/data sequence. This fixture is not a passing native
acceptance case and is separate from `oracle:simavr:timing`. See
[the evidence](../../docs/evidence/spi-status-sequence.md) for the observed
before/after and the upstream simavr implementation boundary.
