# Arduino EEPROM Library

Arduino `EEPROM` library validation fixture.

The sketch stores a short record with `EEPROM.write`, `EEPROM.update`, and a
16-bit `EEPROM.put`, then reads it back through `EEPROM.read` and `EEPROM.get`.
Each byte drives the EECR/EEDR/EEAR register protocol and busy-waits on `EEPE`,
so writes take real simulated time to commit. The read-back bytes land in the
result block at SRAM `0x0300`. `test/eeprom-store.test.ts` confirms both the SRAM
copy and the persisted EEPROM cells (via `avr.eeprom.read`), exercising the full
firmware EEPROM path end to end through compiled EEPROM library code.

Regenerate with `bun run fixtures:arduino` (needs `arduino-cli` and the
`arduino:avr` core).
