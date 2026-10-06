# arduino-peripheral-mix

Mixed-peripheral fixture for result checks and continuous throughput runs.

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

Result runners write `0x42` to SRAM `0x02ff` before execution, so firmware stops
after the first twelve exchanges. Other runs reset the round accumulators and
continue ADC, timer, PWM, GPIO and TWI work. The speed comparison supplies the
same virtual slave, ADC value and GPIO input to both engines. Before this mode
split, long runs measured the halted tail rather than repeated peripheral work.

Regenerate committed artifacts with:

```powershell
bun run fixtures:arduino
```
