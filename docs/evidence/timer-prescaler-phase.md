# Shared Timer0/Timer1 prescaler follow-up

Date: 2026-10-05. Baseline: `44a5deff28f733041464535fd2e0f1320c20b8cd`.
Included in the prepared, unpublished 0.1.1 patch.

## Change

Timer0 and Timer1 previously retained separate remainders for their currently
selected divisors. CS changes reset those remainders, and stopped timers lost
the phase of the free-running divider. Starting the two counters at different
cycles could produce different clock edges even with equal divisors.

[ATmega328P datasheet section 16.2](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf)
describes one shared prescaler that runs independently of CS. The runtime now
owns one ten-bit divider for both timers. CS selects its /8, /64, /256 or /1024
tap; /1 uses the CPU clock directly and stopped counters leave the divider
running. PRR gates counters while the common divider continues. Non-idle sleep
pauses its clock, idle keeps it running, and GTCCR PSRSYNC/TSM reset or hold it.
PSRASY remains independent.

Phase is computed lazily from CPU cycles. Existing counter remainders and
event scheduling remain on the normal execution path, so the change adds no
per-instruction listener. Control and gate transitions select the current tap.

Snapshots include the full common divider phase before timer gates are reapplied.
Older snapshots lack that phase: restoration preserves each saved next counter
edge and uses the largest saved remainder as a deterministic initial phase for
future tap changes. A historical file with independent timer phases cannot
recover an original common divider that was never recorded. Standalone Timer0
and Timer1 instances retain optional full phases and explicit `tick()` support.

## Regression evidence

`test/timer-prescaler-phase.test.ts` adds 90 tests, including both fast and
cycle-exact execution: all four divider taps, stopped and staggered starts,
changes between taps, /1 phase advancement, full-phase restore while a counter
is stopped or uses a smaller divisor, legacy snapshots, phase wraparound,
GTCCR reset/hold and independent PSRASY, six sleep modes, PRR gates, aligned
compare flags without counter reads, reset sources and standalone ticking.

The existing Timer1 PWM/PRR test now expects the continuously advancing shared
divider rather than a frozen private remainder. Its pending compare buffer
still transfers only at BOTTOM.

A clean-baseline source probe recorded:

| Operation | Baseline counters [Timer0, Timer1] | Candidate |
| --- | --- | --- |
| Start Timer0 /8 at cycle 0, Timer1 /8 at cycle 6, read at 8 | [1, 0] | [1, 1] |
| Run Timer0 /8 to cycle 61, restore, switch to /64, read at 64 | [7, 0] | [8, 0] |
| Keep counters stopped to cycle 7, start both /8, read at 8 | [0, 0] | [1, 1] |

The established four native result cases, five native timing cases and Optiboot
comparison pass with the new divider. These comparisons retain their documented
normalizations; they do not add native or physical acceptance of every new
divider transition. Full source/browser/package evidence is in
[release preparation](release-0.1.1.md).
Focused same-host throughput measurements are in
[performance evidence](timer-prescaler-performance.md).

## Remaining boundaries

This models divider phase within the simulator's timer-clock convention. It
does not add the silicon clock-mux startup pipeline, external T0/T1 clocks,
Timer2's free-running divider taps, asynchronous wake-time synchronization or
physical clock edges. Timer1 overflow and SPI status disagreements with native
simavr remain documented. See [limitations](../limitations.md).
