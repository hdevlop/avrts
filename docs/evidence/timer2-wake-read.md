# Timer2 power-save counter read synchronization

Date: 2026-10-05. Baseline: `64aa9d4a49ab9dd04eebb504c013acb60626d35d`.
Included in the prepared, unpublished 0.1.1 patch.

## Change

TCNT2 reads previously exposed the running destination immediately after an
asynchronous power-save wake. The CPU read now retains its visible pre-sleep
value until the first rising TOSC edge after wake begins. The timer, comparator
outputs and destination counter continue independently during that window.
Counter stop, selected divider taps, PRTIM2 and GTCCR do not stop the source
edge that refreshes the read.

Wake callbacks still run after interrupt-entry costs are billed. They now
receive the cycle at which wake began, so a TOSC edge during those costs already
refreshes the first firmware read. Existing callbacks can ignore the argument.
The latch and remaining deadline survive snapshots and host/CLKPR clock changes.
Reset and clock-domain switches discard the latch. Re-entering power-save before
refresh captures the still-visible value. Expired windows cannot be resurrected
by snapshot restore. Version-1 snapshots remain compatible; older files without
the new optional fields retain their preceding read behavior because they cannot
reconstruct an unrecorded pre-sleep value.

Reference: [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
section 17.9, pages 126-127, describing power-save counter read synchronization
and the recommended register-write/busy-wait procedure.

## Regression evidence

`test/timer2-wake-read.test.ts` adds 78 tests across fast and cycle-exact execution.
They cover wake with global I set/clear, edges during interrupt entry, exact and
fractional source boundaries, stopped and prescaled counters, PRR/GTCCR, sleeping
and awake snapshots, host/CLKPR changes in both states, same-edge TCNT transfers,
the documented busy-wait sequence, an LDS in a Timer2 compare ISR with continued
OC2B output and flag activity, repeated sleep, expiry, AS2 switches, three reset
sources, other sleep modes, synchronous operation and legacy snapshots.

A source probe against the clean baseline records the following at 100 CPU
cycles per TOSC edge. TCNT2 starts at 40, advances to 41 before power-save entry
at cycle 150, and continues asynchronously during sleep.

| Read | Baseline TCNT2 | Candidate TCNT2 |
| --- | --- | --- |
| Early wake, cycle 355 | 43 | 41 |
| First post-wake TOSC edge, cycle 400 | 44 | 44 |
| Edge during wake entry, first read at cycle 403 | 44 | 44 |
| Restore while asleep, then early wake at cycle 355 | 43 | 41 |

Complete source/browser/package and established native fixture results are
recorded in [release preparation](release-0.1.1.md). The native fixtures do not
independently validate the new read window on native simavr or physical hardware.
Focused same-host source measurements are in [performance evidence](timer2-wake-performance.md).

## Remaining boundaries

This change models the documented power-save read latch. Host TCNT2 reads while
the CPU remains asleep continue to inspect the running destination. Other sleep
modes retain their preceding read behavior. Asynchronous interrupt-flag and
timer-wake pipelines are added by the [0.1.2 follow-up](timer2-async-signals.md).
The PSRASY acknowledgement handshake, exact mux startup,
oscillator startup instability and external TOSC/EXCLK wiring remain outside
this change. Physical calibration has not been run. See
[limitations](../limitations.md). Timer1 overflow and SPI status disagreements
with native simavr remain documented.
