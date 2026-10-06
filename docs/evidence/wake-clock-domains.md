# Peripheral clocks during wake entry

Date: 2026-10-06. Baseline: `a60a77c36da1f6afee6a4dff38b202218246420b`.
Follow-up for the unpublished `@hdevlop/avrts@0.1.2` preparation.

## Problem and correction

CPU wake-start made the CPU awake before billing startup/interrupt cycles, but
`SleepControl` resumed the gated peripherals from the later wake-complete hook.
This discarded the four wake clocks and, with global I set, four additional
interrupt-dispatch clocks. Timer2's asynchronous synchronizer already resumed
at wake start, so it and the synchronous I/O peripherals used inconsistent
restart boundaries.

`SleepControl` now releases sleep gates from `onWakeStart`, before entry costs.
Existing PRR gates remain independent. The ordinary wake-complete notification
and its original wake timestamp remain as before. Timer-domain Timer2 wakes
still notify after four startup clocks, followed by separate interrupt dispatch.

For a timer at count five before non-idle sleep, a synthetic INT0 wake with I
set previously left the count at five after entry. It now reads thirteen.
With I clear it reads nine and retains the pending request. Idle continues to
clock throughout sleep and entry. Stopped counters' shared divider also advances
during entry, retaining the appropriate next tap when firmware starts counting.

Reference: [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
sections 8.1, 9.1 and 17.9. Sleep disables selected clock domains, and wake has
four halted CPU clocks before interrupt handling. Restarting the I/O domains
before those modeled entry clocks is the implementation's interpretation of
that transition. Physical hardware has not calibrated the exact startup edge;
oscillator startup delays remain outside this fix.

## Regression evidence

The first 24 timer-boundary regressions passed in idle and failed in all twenty
non-idle cases before the correction: expected thirteen/nine, received five.
`test/wake-clock-domains.test.ts` now has 58 fast/cycle-exact cases covering:

- All six modeled sleep modes, global I set/clear, and direct/restored execution.
- Timer0/Timer1/synchronous Timer2 clocks during wake and interrupt entry.
- SPI, USART TX and ADC operations completing within entry, with requests retained.
- PRR retaining a paused operation's remaining clocks across wake and restore.
- Shared prescaler phase with stopped counters and wake without ISR dispatch.
- Timer2 asynchronous wake restarting Timer0/Timer1 while preserving PRTIM0.

The focused final run passed 367 tests with 1,769 assertions across this file,
`phase7-sleep-wake.test.ts`, `timer-prescaler-phase.test.ts`,
`timer2-prescaler-phase.test.ts` and `timer2-async-transfers.test.ts`. Two earlier
Phase 7 assertions now include the previously lost eight entry clocks. Timer2
sleep/CLKPR and paused-transfer boundaries likewise subtract entry clocks from
the remaining resumed deadline. The first full source run found twenty old
Timer2 expectations using the preceding after-entry restart convention; they
now assert the earlier first edge and, when applicable, counting during entry.
The broader initial focused run also passed peripheral transition and Timer2 flag
and counter-read coverage; its only failures were those two old assertions.

Full source/browser/package and native validation is recorded in
[0.1.2 preparation](release-0.1.2.md). That release suite also runs the compiled
LowPower-style watchdog sleep and Timer2 polling/power-save firmware fixtures.

## Focused sleep performance

The compiled `arduino-lowpower-wdt` firmware compares the clean baseline above
with this correction on the same Intel Core i7-7700K/Windows 10 LTSC host,
using Bun 1.3.14. Each revision runs in a fresh process, baseline first. Each
trial constructs a new emulator outside timing, warms 500,000 cycles, then
times 100 million simulated cycles. The first of ten trials is discarded and
the remaining nine produce the median. Local runner/output is retained in
ignored `logs/benchmark-wake-clocks.ts` and `logs/wake-clocks-performance-*`.

| Run | Baseline Mcycles/s | Candidate Mcycles/s | Change | Samples |
| --- | ---: | ---: | ---: | --- |
| Quiet measurement | 81.56 | 78.95 | -3.2% | [JSON](wake-clocks-performance-lowpower.json) |
| Earlier overlapped measurement | 77.76 | 79.09 | +1.7% | [JSON](wake-clocks-performance-lowpower-overlapped.json) |

An initial five-billion-cycle trial budget was stopped before yielding a
complete comparison. The first shortened comparison overlapped that process,
so it is retained separately and the final result uses a quiet run after the
process was stopped. The -3.2% result retains a possible small sleep-workload
cost alongside host/JIT variation. This one workload does not establish a
general performance claim; the earlier four-workload signal comparison remains
historical evidence for its own source revision.

## Remaining timing boundaries

This correction does not add a guessed Timer2 flag-clear or PSRASY handshake.
The datasheet confirms possible immediate repeated wake after sleeping again
within a TOSC cycle, but does not specify the complete clear pipeline. That
behavior and exact reset latency remain documented model limits, as does
physical calibration. See [the Timer2 investigation](timer2-async-signals.md)
and [limitations](../limitations.md).
