# Arduino tone()

Arduino core `tone()` validation fixture.

The sketch emits a continuous 1 kHz square wave on pin 8 with `tone(8, 1000)`.
For a non-timer pin the core toggles the pin from a Timer2 CTC compare-match
interrupt each half-period, so the simulator sees pin 8 flip every 500 us.
`test/tone.test.ts` measures the pin-8 edge interval and recovers the frequency
(within 1 % of 1 kHz), exercising Timer2 CTC + GPIO end to end through the core's
`tone()` implementation. The commanded frequency is echoed to the result block at
SRAM `0x0300`.

Regenerate with `bun run fixtures:arduino` (needs `arduino-cli` and the
`arduino:avr` core).
