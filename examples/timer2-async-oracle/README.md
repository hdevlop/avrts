# Timer2 Async Oracle Fixture

Small avr-libc fixture for the native simavr timing oracle. Firmware switches
Timer2 to asynchronous `TOSC` mode, waits for Timer1 overflow milestones, then
stores firmware-read `TCNT2`, `TIFR2`, and `ASSR` snapshots into SRAM at
`0x0300`.

Initialization polls each register's ASSR busy flag before starting the timer,
then waits for the clock-start transfer before beginning the Timer1 milestones.
This separates startup transfer latency from the steady clock-rate comparison.
The complete result block is compared without normalizing timer count bytes.

This fixture is a drift check: the expected async clock is 32.768 kHz, so at
16 MHz one Timer2 tick averages 488.28125 CPU cycles. The oracle compares the
stored Timer2 snapshots from native simavr and avrts after a long run.

Regenerate with `bun run fixtures:avr-gcc` or compile this file with the same
`avr-gcc -mmcu=atmega328p -Os -DF_CPU=16000000UL` flags used by the fixture
script.
