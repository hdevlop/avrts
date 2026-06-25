# arduino-string-heavy

Result and throughput fixture for Arduino string/formatting workloads.

This compiled Arduino sketch exercises:

- `String` concatenation, replacement, substring, and numeric conversion
- `snprintf` formatting
- `Serial.print` / `Serial.println`
- ADC input on A0 and GPIO input on D2

The firmware writes a deterministic result block to SRAM at data address
`0x0300`. Result comparison tests run the same `.hex` in avrts and avr8js with
the same ADC/GPIO environment and compare the observable final state plus serial
bytes.

The result harness writes `0x42` to data address `0x02ff` before starting the
program; in that mode the sketch halts after the first result block is complete.
Normal benchmark/profile runs leave that byte unset, so the sketch keeps running
the active string/Serial workload after the first result block.

Regenerate committed artifacts with:

```powershell
bun run fixtures:arduino
```
