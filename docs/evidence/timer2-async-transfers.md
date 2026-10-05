# Timer2 asynchronous register transfers

Date: 2026-10-05. Follows `f46d2a4`; included in the prepared, unpublished 0.1.1.
Reference: [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
sections 17.9 and 17.11.8.

## Change

The preceding implementation installed asynchronous writes immediately and used
one shared event to clear every busy flag after a rounded TOSC period. A later
write postponed earlier registers' completion. Timer2 now retains separate
temporary values and transfer deadlines for TCNT2, OCR2A/B and TCCR2A/B. Each
destination updates after two simulated rising TOSC edges; its busy flag clears
with that transfer. Source phase advances even while the counter is stopped.

Firmware reads temporary control/OCR values while internal counting and PWM use
the destination registers. TCNT reads the running destination, not its pending
write. An OCR transfer then waits for the PWM TOP/BOTTOM buffer boundary when
applicable. Pending counter/OCR writes suppress their compare actions; other
channels can still compare. Control changes and FOC strobes act at transfer,
and FOC/reserved bits read as zero. Same-edge updates settle the old counter,
install all due registers and then apply their combined mode/control effects.

CLKPR/host clock changes scale source phase and every remaining deadline.
Power-save, noise-reduction and extended standby retain the source; power-down
and standby pause it. GTCCR holds stop the counter while register transfers
continue. The [later divider follow-up](timer2-prescaler-phase.md) also corrects
PRTIM2 to gate only synchronous operation. Snapshots retain phase, pending values and individual
deadlines without changing snapshot version 1. Older snapshots retain their
already-installed destinations and legacy busy-clear window.

## Evidence

`test/timer2-async-transfers.test.ts` adds 70 regressions in fast and cycle-exact
execution. They cover all five registers, staggered writes, busy rewrites,
fractional edges, stopped counters, same-edge write order, temporary reads,
independent channel matches, CTC, PWM's second buffer stage, FOC, clock changes,
five sleep modes, restore/wake, PRR/GTCCR, reset, AS2 switches and legacy state.
Existing timer tests now wait for transfer boundaries; the compiled Arduino RTC
still counts seconds within its unchanged acceptance bounds.

The original native drift fixture began Timer1 milestones before its Timer2
clock-start transfer completed. With this change it produced an initial two-tick
offset (native first/final TCNT 134/186, avrts 132/184), while both intervals
advanced 52 modulo-256 ticks. The fixture now polls initialization and clock-start
busy flags before starting the milestones. Its C, HEX and disassembly were
rebuilt together with the repository's avr-gcc flags. Both engines then produced
the exact result `a7 86 00 20 ba 07 20 5c`; no timer bytes were normalized.
Completion checks use the markers, with the entire result compared separately,
so an unexpected count reports a mismatch rather than an artificial timeout.

Native completion occurred at 1,966,214 cycles, avrts at 1,968,968 cycles. These
are completion envelopes, not proof of transfer timing or physical silicon
acceptance. Source tests check the modeled transfer boundaries independently.
Use `bun run oracle:simavr:timing` to reproduce the native comparison.
Full checks and the refreshed package archive are in
[release evidence](release-0.1.1.md). The focused revision measurements are in
[performance evidence](timer2-async-performance.md).

## Remaining boundaries

Busy writes preserve the first pending value. AS2 switches discard unfinished
transfers and retain destinations. Deep sleep retains oscillator/register state
after wake. These deterministic policies do not reproduce corruption or startup
instability, which silicon leaves unreliable. The
[subsequent read follow-up](timer2-wake-read.md) adds the power-save CPU-domain
TCNT read latch. Three-CPU-cycle asynchronous flag synchronization, crystal drift and
external TOSC/EXCLK wiring remain outside this change. See
[limitations](../limitations.md). The existing Timer1 overflow-phase disagreement
with native simavr remains unchanged.
