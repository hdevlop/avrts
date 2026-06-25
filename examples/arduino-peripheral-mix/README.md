# arduino-peripheral-mix

Result benchmark fixture for simulator-readiness checks, not speed.

This compiled Arduino sketch exercises several peripherals together:

- ADC input on A0
- Timer1 compare interrupt
- PWM output on D3 and D5
- GPIO input on D2
- TWI/I2C master write/read against a virtual slave

The firmware writes a deterministic result block to SRAM at data address
`0x0300`. `bun run bench:result` runs the same `.hex` in avrts and avr8js, feeds
the same ADC/GPIO/I2C environment into both, and compares the result block plus
the I2C transcript.

Regenerate committed artifacts with:

```powershell
bun run fixtures:arduino
```
