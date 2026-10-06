# Timer2 asynchronous flag and wake synchronization

Date: 2026-10-06. Baseline: `53e977197643f2989fb5d21ebe4af120ee83af92`.
Prepared for `@hdevlop/avrts@0.1.2`.

## Change and timing reference

CPU-visible Timer2 flags previously appeared directly on their timer-domain
event. Compare conditions already waited for the following timer clock, but
there was no CPU synchronizer. Overflow appeared at BOTTOM without the
asynchronous timer-clock stage. These conditions could wake a sleeping CPU
through an immediate ordinary interrupt request.

Reference: [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
sections 17.5 and 17.9, pages 118 and 126-127. Compare equality sets OCF on the
following timer clock. The asynchronous description specifies one timer clock
plus three processor clocks for flag synchronization, while output pins use
the timer clock directly. Wake from power-save/noise reduction begins on the
following timer clock, before the four startup cycles and ISR entry.

The implementation retains compare's existing next-clock stage and adds three
CPU clocks. Overflow waits for the following timer clock before those CPU
stages. The selected divider determines the timer clock. Output compare pins
continue independently of the CPU flag delay. CPU-clock stages run in idle and
pause in non-idle sleep. An enabled condition in noise reduction, power-save
or extended standby starts wake at the timer stage; synchronization completes
during the four CPU startup clocks, followed by normal interrupt entry if I is
set. With I clear, wake still occurs and the live request remains pending.

CPU wake-start listeners resume the synchronizer before startup costs are
billed. Ordinary interrupt wakes retain their existing notification after
entry costs. A timer-domain wake notifies after its four startup clocks, before
CPU interrupt dispatch; both paths retain the original wake-cycle timestamp.
Counter events are settled and rescheduled before invoking wake, preserving
reentrant clock-event accounting.

Snapshots retain pending overflow and remaining CPU stages without changing
snapshot version 1. CLKPR/host changes rescale the oscillator/counter domain;
the CPU stage count does not rescale. PRR, counter stop and TSM leave already
detected CPU stages active. AS2 switches discard incomplete stages under the
existing deterministic clock-switch policy; visible flags survive. Reset clears
the pipeline, and legacy snapshots restore without phantom pending conditions.

## Regression and firmware evidence

`test/timer2-async-signals.test.ts` adds 76 fast/cycle-exact regressions covering
seven dividers, output/flag boundaries, global I, three asynchronous sleep modes,
idle, overflow, masked conditions, external wake, enabling a staged flag,
power-down/standby, snapshots, clock/PRR/GTCCR/stop transitions, W1C and masks,
simultaneous interrupt priority, fractional/coalesced boundaries, reset sources,
AS2 transitions, legacy state and compiled firmware. Earlier async flag tests
now check the additional three CPU clocks explicitly.

A clean-baseline source probe uses 50 CPU cycles per TOSC edge:

| Operation | Baseline | Candidate |
| --- | --- | --- |
| Compare output at cycle 100 | High | High |
| CPU-visible OCF2A edge | Cycle 150 | Cycle 153 |
| Power-save overflow wake begins | Cycle 100 | Cycle 150 |
| Completed overflow ISR entry | Cycle 108 | Cycle 158 |

The candidate's timer-domain wake notification occurs at cycle 154, after
startup and before ISR entry. The firmware then reaches its vector at 158.

The compiled `examples/timer2-sync-probe` fixture polls OCF2A and enters power-save
before a later compare interrupt. Its C, HEX and disassembly are committed
together, using `avr-gcc -mmcu=atmega328p -Os -DF_CPU=16000000UL`.

| Result byte | Native simavr | avrts |
| --- | --- | --- |
| Immediate PSRASY read | 2 | 0 |
| PSRASY after bounded polling | 2 | 0 |
| TCNT2 after polling OCF2A | 3 | 3 |
| Polling TIFR2 | 2 | 2 |
| TCNT2 in the power-save ISR | 7 | 3 |
| ISR TIFR2 after automatic acknowledgement | 0 | 0 |

The ISR read difference retains avrts's documented pre-sleep counter read until
the next TOSC edge. This fixture records the disagreement; it is not added to
the passing normalized native matrix. It does not physically calibrate the new
three-clock stage. Source boundary tests verify the stated model separately.
Complete release/native checks and throughput measurements are recorded in
[0.1.2 preparation](release-0.1.2.md) and
[the focused performance comparison](timer2-signals-performance.md).

## PSRASY investigation and remaining boundaries

Section 17.11.9 requires PSRASY to remain set until an asynchronous prescaler
reset completes, but does not specify the exact transfer/acknowledgement clock
count. The native probe retained bit 1 through bounded polling. An earlier
unbounded probe did not finish within 200,000 simulated cycles, still holding
the bit. This native behavior cannot serve as a silicon reset-latency reference.
avrts retains its existing immediate acknowledgement convention and source-edge
alignment; no guessed reset latency was added.

The asynchronous flag-clear/acknowledgement handshake, repeated wake after
re-entering sleep within a TOSC period, exact clock-mux startup, oscillator
instability and external TOSC wiring remain model limits. Physical hardware
calibration has not been run. See [limitations](../limitations.md).
