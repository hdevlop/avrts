# Timer2 independent divider follow-up

Date: 2026-10-05. Baseline: `bdf28482861fd2477c11fa596d14c3b6269c2a86`.
Included in the prepared, unpublished 0.1.1 patch.

## Change

Timer2 previously retained only the remainder of its selected divisor. CS
changes reset that remainder; stopped counters discarded the phase of the
independent ten-bit divider. Asynchronous control transfers retained a partial
TOSC period but discarded higher divider bits. Off-edge prescaler resets and
hold release could also move counter clocks away from the TOSC source grid.

The timer now retains the phase of all 1,024 source clocks separately from the
oscillator phase used by temporary register transfers. CS selects the existing
tap in either clock domain; /1 and stopped counters still preserve higher bits.
Clock changes scale the full TOSC divider phase along with pending transfers.
Snapshots retain full divider phase; old snapshots fall back to their saved
remainder, preserving the selected tap's next edge. They cannot reconstruct
unrecorded higher divider bits for a future tap change.

Synchronous PRTIM2 and non-running sleep modes pause the independent divider.
PRTIM2 does not gate asynchronous operation. TSM+PSRASY holds the divider while
TOSC and its register transfers continue; reset/release retains the partial
TOSC period so future counter clocks fall on source edges. PSRSYNC remains
independent. Clock-domain switches retain the existing deterministic policy:
discard unfinished transfers and start a new domain at phase zero.

Reference: [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
sections 17.10 and 17.11.9 (independent prescaler/source/reset) and 9.11.3
(PRTIM2 applies when AS2 is zero). Phase remains lazy; no per-instruction listener
was added. Standalone synchronous `tick()` use is preserved.

## Regression evidence

`test/timer2-prescaler-phase.test.ts` adds 137 tests in fast and cycle-exact
execution. Coverage includes six divider taps in both domains, CS stop/restart,
tap changes in both directions, /1 and stopped full-phase restore, phase wrap,
PSRASY/TSM reset/release, independent PSRSYNC, fractional source periods,
CLKPR scaling while running/stopped/asleep, all six modeled sleep modes,
PRR and AS2 transitions, event-scheduled flags without counter reads,
legacy snapshots, three reset sources and standalone ticking.

The earlier asynchronous PRR test now directly checks continued counting before
writing TCNT2, instead of describing an unsupported gate hidden by that write.

A clean-baseline source probe recorded:

| Operation | Baseline TCNT2 | Candidate TCNT2 |
| --- | --- | --- |
| Sync stopped to cycle 7, start /8, read at 8 | 0 | 1 |
| Sync /1 to cycle 31, restore, switch /32, read at 32 | 31 | 32 |
| TOSC /8 to cycle 290, transfer /32, read at 320 (10 cycles/TOSC) | 3 | 4 |
| Async PSRASY at cycle 25, read at source edge 100 | 0 | 1 |
| Async /8, set PRTIM2 at 30, read at source edge 80 | 0 | 1 |

All established native result, timing and Optiboot comparisons pass, retaining
their documented normalizations. These fixtures do not prove every new divider
transition on native simavr or physical hardware. Complete source/browser/package
checks are in [release preparation](release-0.1.1.md).
Focused same-host throughput measurements are in
[performance evidence](timer2-prescaler-performance.md).

## Remaining boundaries

GTCCR still acknowledges an asynchronous PSRASY strobe immediately; silicon
retains it until its cross-domain reset completes. This follow-up retains source
edge alignment within that existing reset convention and does not add the
handshake, mux startup pipeline, asynchronous interrupt synchronization, stale
wake-time reads, physical oscillator startup or externally supplied TOSC pulses.
See [limitations](../limitations.md). Timer1 overflow and SPI status disagreements
with native simavr remain documented.
