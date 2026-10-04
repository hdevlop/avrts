# Arduino LowPower Watchdog Sleep

Arduino `LowPower`-library-style watchdog-sleep validation fixture.

The sketch reproduces the canonical low-power pattern (Rocket Scream LowPower,
Adafruit SleepyDog): arm the watchdog for a timeout **interrupt** (not a reset),
enter `SLEEP_MODE_PWR_DOWN`, and let the WDT wake the MCU each 16 ms period. The
`WDT_vect` ISR counts wakeups; the loop explicitly reconfigures the watchdog
before each sleep. Interrupt-only mode preserves `WDIE` across timeouts. The
result block at SRAM `0x0300` holds the
start marker, the running wake count, and the end marker.
`test/lowpower-wdt.test.ts` runs the compiled `.ino.hex` across several watchdog
periods and asserts the MCU sleeps, wakes once per 16 ms, and returns to
power-down — exercising SLEEP entry, WDT-clocked timeout during power-down,
`WDT_vect` dispatch, and snapshot/restore of the sleeping state end to end.

Regenerate with `bun run fixtures:arduino` (needs `arduino-cli` and the
`arduino:avr` core).
