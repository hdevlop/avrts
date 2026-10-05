# Timer PWM buffers and clock boundaries

Date: 2026-10-05. Follows `d31a3cb`; included in the prepared, unpublished 0.1.1.

Reference: [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
sections 14.5/14.7/14.8, 15.7/15.9/15.11.9 and 17.5/17.7/17.8. Mode tables
14-8 and 17-8 define the 8-bit transfer edges; timing diagrams distinguish
reaching TOP from clearing the counter on the following clock.

## Implementation

Timer0 and Timer2 now have separate CPU-visible OCR buffers and active compare
values. Fast PWM modes 3/7 transfer at BOTTOM; phase-correct modes 1/5 transfer
at TOP. The latter count both slopes, with a 2*TOP period and overflow at BOTTOM.
Modes 5/7 use active OCRnA as TOP. Fast PWM has TOP+1 periods and its 8-bit
overflow flag is asserted on the TOP-to-BOTTOM transition. Snapshot state retains
active values, direction and counter-write compare blocking, with defaults for
older snapshots.

Duty writes wait for the transfer edge without restarting the pulse. Both output
polarities, zero/full-duty behavior, OCnA toggle, reserved OCnB toggle disconnect,
and phase-correct full-to-partial duty transfers have waveform checks. PWM facade
reads and notifications report the active comparator; OCR reads expose the buffer.
Force-compare strobes act on pins in non-PWM modes without setting OCF or clearing
CTC; their bits read as zero.

All three timers hold CTC TOP for one clock, giving TOP+1 periods. Ordinary
compare flags sample the previous counter equality on the next timer clock.
Counter writes block the following compare clock and preserve prescaler remainder;
control writes that retain the CS bits also preserve it. Timer1's dedicated
OCR1A-as-TOP PWM and ICR1 TOP flags remain distinct from ordinary compare flags.
Writing TCNT at a compare-defined TOP also blocks its CTC/variable fast-PWM
clear, so counting continues until MAX wraps. Writing BOTTOM on a falling
slope likewise wraps downward rather than clamping and restarting the period.
Phase-correct compare values above TOP do not create artificial TOP pin edges.

The changed edges exposed a generated instruction bug: SBIC/SBIS advanced their
first cycle before reading I/O, while the interpreter read first. The generator
now samples each skip condition before advancing cycles, and both generated
execution ladders were refreshed. Four regressions toggle an I/O flag during
that first cycle and compare the resulting PC/cycle count with the interpreter.
The existing generated-versus-interpreter Blink fixture remains an acceptance gate.

## Evidence

`test/timer-boundary-correctness.test.ts` adds 235 regressions across fast and
cycle-exact execution. They cover update edges, both slopes/polarities, dynamic
TOP, extrema, toggle, clock stop, PRR, sleep, GTCCR, snapshots, legacy defaults,
force compare, prescaler phase, CTC TOP 0/1/3/MAX, missed TOP, delayed flags and
restored interrupt dispatch. Further cases cover TCNT-written TOP/BOTTOM misses
and above-TOP outputs on all three timers. Deterministic duty/TOP changes compare bulk
advancement with single-clock stepping. Timer2's asynchronous case distinguishes
ASSR busy clearing from a later PWM transfer.

Disconnected Timer1 CTC outputs skip equality-only scheduling events; a masked,
latched B flag also skips its redundant events. Flag/mask writes settle the lazy
counter and re-arm the next observable event. Regressions clear the B flag
without first reading TCNT, enable its mask, acknowledge an interrupt and check
the next period. The final performance measurements are in
[the revision comparison](timer-boundary-performance.md).

Existing fixtures now wait for hardware flag/buffer boundaries. The Arduino
tone test measures the established waveform after setup, excluding its startup
pin change/previously latched flag; the Blink one-second acceptance bounds are
unchanged. Source, browser, package and normalized native results are recorded in
[release evidence](release-0.1.1.md).

## Boundaries

The 8-bit overflow edge agrees with a focused native simavr polling probe and
preserves monotonic Arduino `micros()` / one-second `delay()`. That same probe
finds a Timer1 fast-PWM phase difference: avrts exposes TOV1 while TCNT1 is TOP,
consistent with the datasheet mode description, while native simavr exposes it
at BOTTOM. This batch retains the Timer1 interpretation and records the
disagreement; a normalized general oracle pass is not proof of this edge.

Probe [source](timer-overflow-probe.c) and [results](timer-overflow-probe.json)
are retained. It polls each overflow flag at /1024 and records TCNT shortly
after the flag becomes visible. Native/avrts both record zero for Timer0 and
Timer2, while Timer1 records zero natively and three in avrts with ICR1 TOP=3.
This checks the counter interval containing the flag, not its electrical timing.
Reproduce with the repository's avr-gcc toolchain (use `.exe` on Windows):

```sh
avr-gcc/bin/avr-gcc -mmcu=atmega328p -Os -DF_CPU=16000000UL docs/evidence/timer-overflow-probe.c -o logs/timer-overflow-probe.elf
avr-gcc/bin/avr-objcopy -O ihex -R .eeprom logs/timer-overflow-probe.elf logs/timer-overflow-probe.hex
bun scripts/simavr-oracle.ts --hex logs/timer-overflow-probe.hex --cycles 1000000 --no-default-dumps --dump result:0x300:5 --until-result 0x300:5:0xa7:0x5c --json
bun -e 'import { AVR } from "./src"; const avr = AVR(await Bun.file("logs/timer-overflow-probe.hex").text()); while (avr.cpu.cycles < 1000000 && avr.cpu.data[0x304] !== 0x5c) avr.runCycles(100); console.log(JSON.stringify({cycles:avr.cpu.cycles,result:[...avr.cpu.data.slice(0x300,0x305)]}));'
```

The avrts command checks completion after 100-cycle batches; total cycle counts
are completion envelopes, not an exact instruction-boundary comparison.

At this revision Timer2's separate asynchronous register latch was still an
approximation. The [following batch](timer2-async-transfers.md) adds independent
two-edge write transfers; busy windows and PWM buffering remain distinct.
Reserved WGM modes,
external timer clocks, electrical effects and physical hardware acceptance are
outside this batch. PWM duty is a compare-value/TOP facade description, not a
measurement of every pin pulse. See [limitations](../limitations.md).
