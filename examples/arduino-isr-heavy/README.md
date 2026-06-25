# arduino-isr-heavy

Result benchmark fixture for interrupt-heavy simulator-readiness checks.

This compiled Arduino sketch exercises:

- Timer1 compare interrupts
- ISR-driven software PWM bookkeeping
- ADC input on A0
- PWM output on D3 and D5
- GPIO input on D2

The firmware writes a deterministic result block to SRAM at data address
`0x0300`. Result comparison tests run the same `.hex` in avrts and avr8js with
the same ADC/GPIO environment and compare the observable final state.

The result harness writes `0x42` to data address `0x02ff` before starting the
program; in that mode the sketch halts after the result block is complete. Normal
benchmark/profile runs leave that byte unset, so the sketch keeps running the
active ISR workload after the first result block.

Regenerate committed artifacts with:

```powershell
bun run fixtures:arduino
```
