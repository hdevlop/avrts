# Arduino Timer2 Async RTC

Arduino Timer2 asynchronous-overflow "software RTC" validation fixture.

The sketch clocks Timer2 from the 32.768 kHz watch crystal on TOSC (`ASSR.AS2`)
with prescaler 128, so the timer overflows exactly once per second. The
`TIMER2_OVF` ISR counts seconds and the result block at SRAM `0x0300` holds the
start marker, the 16-bit seconds count, the sub-second `TCNT2` value, and the end
marker. `test/timer2-rtc.test.ts` runs the compiled `.ino.hex` for several
simulated seconds and asserts the clock keeps time, exercising the exact
16 MHz / 32.768 kHz async tick ratio, the overflow flag, and interrupt dispatch
end to end through real Arduino ISR code.

Regenerate with `bun run fixtures:arduino` (needs `arduino-cli` and the
`arduino:avr` core).
