# External interrupt edge detection in sleep

Date: 2026-10-06. Baseline: `f5bff1df2eca390d8ba47e63df8cd6c5a66a6cd6`.
Follow-up for the unpublished `@hdevlop/avrts@0.1.2` preparation.

## Problem and reference

INT0/INT1 evaluated rising, falling and toggle edges on every GPIO port-D touch,
including non-idle sleep with clkI/O stopped. A host pin change could therefore
set EIFR, request an interrupt and wake power-down code through an unsupported
source. This affected ADC noise reduction, power-down, power-save, standby and
extended standby, with global I either set or clear.

The [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
sections 8.1.2 and 12, requires clkI/O for INT0/INT1 edge recognition and stops
that clock outside idle sleep. Low-level INT0/INT1 detection and PCINT are
asynchronous and remain available for wake.

## Correction

The external interrupt edge detector now retains its last clocked pin samples
through non-idle sleep. Completed pulses do not reach it while clkI/O is stopped.
At wake start it samples the held levels using the existing logical edge model;
a held change can then set a flag and request an interrupt. Idle still detects
edges while asleep. Low-level requests continue using the live pin levels, and
PCINT retains its asynchronous operation on all banks.

Wake resampling refreshes requests only for newly raised flags. It does not
requeue a flagged request the CPU already selected for acknowledgement. This
prevents duplicate ISR entry on an edge that woke idle sleep. Masked held edges
can set EIFR on resume without queuing a request; late EIMSK enable then requests
the vector. W1C and ISR acknowledgement retain their existing behavior.

The existing `prevPinLevels` snapshot fields retain the last clocked samples,
while GPIO records the current raw levels. Restore preserves both without
creating an edge before wake. Snapshot version 1 remains compatible.

## Regression evidence

The first 192 regressions produced 120 failures before the fix: every non-idle
edge case. The 72 idle/low-level cases passed. The final test file has 354
fast/cycle-exact cases covering both pins, all three edge senses, all six modeled
sleep modes, global I set/clear, direct/restored state, completed/held pulses,
masked flag delivery, W1C, new edges after resume, PCINT on the same pin, mixed
low-level/edge sensing, and no duplicate acknowledged request.

The final file passed with 2,574 assertions. A broader focused run passed 729
tests across external interrupts, sleep/wake, peripheral correctness and the
25-vector matrix before the final no-duplicate assertion was added; the final
file was rerun afterward. Complete checks are in
[0.1.2 preparation](release-0.1.2.md).

`examples/exti-sleep-probe` commits C, HEX and disassembly together, compiled with
`avr-gcc -mmcu=atmega328p -Os -DF_CPU=16000000UL`. Its power-down firmware enables
rising INT0 and asynchronous PCINT0, then executes SLEEP. A host D2 pulse leaves
it asleep. PB0 then wakes it through PCINT, with result bytes:

| D2 signal before PCINT wake | Result bytes |
| --- | --- |
| Held high | `a7 01 01 5c` |
| Returned low before wake | `a7 00 01 5c` |

Both cases pass directly and after restore in both timing modes. This is a
compiled source regression, not a new native GPIO timing comparison.

## Focused performance

Compared the final source against the clean baseline above using
`scripts/benchmark-revision.ts` on Bun 1.3.14. Each workload/revision used a
fresh Bun process, 500,000 warm-up cycles before each 50,000,000-cycle trial,
and the median of nine retained trials after discarding the first. Emulator
construction was excluded. Baseline ran first for each workload; the three
comparisons ran sequentially after validation, without overlapping checks.

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Median change | Samples |
| --- | --- | --- | --- | --- |
| GPIO bit-banging / CRC | 18.67 | 18.76 | +0.5% | [JSON](exti-sleep-performance-bitbang-crc.json) |
| Peripheral mix | 1,049.93 | 1,105.50 | +5.3% | [JSON](exti-sleep-performance-peripheral-mix.json) |
| Interrupt-heavy | 77.44 | 79.04 | +2.1% | [JSON](exti-sleep-performance-isr-heavy.json) |

These focused measurements showed no slowdown on this host. They include JIT
and host variation and do not establish a universal throughput improvement.

## Remaining boundaries

GPIO is still a host-driven logical level model. The complete input synchronizer,
short-pulse filtering, oscillator startup and low-level wake pulse retention
through physical startup have not been calibrated. Sampling a held value at
wake start is the simulator's logical transition convention; this change does
not claim exact first-sample timing or all-source wake arbitration fidelity.
The Timer2 reset/clear handshake limits remain open. See
[limitations](../limitations.md).
