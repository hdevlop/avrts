# Arduino Internal ADC Channels

Arduino internal-ADC-channel validation fixture — the raw-register form of
`analogRead(TEMPERATURE)`.

The sketch reads the on-chip temperature sensor (`ADMUX` MUX = 1000, internal
1.1 V reference) and the bandgap channel (MUX = 1110, AVcc reference) by hand
through `ADMUX`/`ADCSRA`, busy-waiting on `ADSC`. The result block at SRAM
`0x0300` holds the start marker, the 10-bit temperature result, the 10-bit
bandgap result, and the end marker. `test/adc-internal.test.ts` supplies a
temperature sample from the host with `avr.analog(8).setValue(...)` and asserts
both internal channels read back correctly (bandgap reads `round(1.1/5 * 1023) =
225` against AVcc), exercising the internal-ADC channel model end to end.

Regenerate with `bun run fixtures:arduino` (needs `arduino-cli` and the
`arduino:avr` core).
