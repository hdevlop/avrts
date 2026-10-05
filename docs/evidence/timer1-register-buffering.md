# Timer1 byte access and PWM buffering

Date: 2026-10-05. This batch follows the peripheral review at `4c8ce84` and is
included in the prepared, unpublished 0.1.1 patch.

Reference: [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
sections 15.3, 15.6, 15.7 and 15.9; WGM table 15-5.

## Implemented behavior

Timer1 now shares one high-byte TEMP latch among TCNT1, ICR1, OCR1A and OCR1B.
High writes stage that latch; a low write commits the pair. TCNT/ICR low reads
latch high, while OCR reads leave TEMP untouched. An intervening access can
therefore corrupt a staged pair, matching the reason firmware masks interrupts
around shared 16-bit accesses.

CPU-visible OCR buffers and active comparators are distinct. Their transfer
points are:

| WGM modes | OCR transfer |
| --- | --- |
| 0, 4, 12; reserved 13 approximation | Immediately on the low-byte commit |
| 1, 2, 3, 10, 11 | TOP |
| 5, 6, 7, 8, 9, 14, 15 | BOTTOM |

ICR1 stays unbuffered and accepts writes only in TOP modes. Lowering it below
TCNT can miss TOP until MAX wraps. ICR TOP raises ICF1. Fast PWM holds TOP for
one clock, giving TOP+1 periods. TCNT commits preserve prescaler phase and block
the following compare clock.

Pending duty writes do not restart a pulse. Endpoint duties and supported OC1A
toggle modes have waveform regressions. PWM facade reads/notifications describe
the active comparator; direct OCR reads show the CPU buffer. Clock gating does
not promote queued values.

## Regression evidence

`test/timer1-register-buffering.test.ts` covers 114 cases across fast and
cycle-exact execution. It checks all four word-access paths and all sixteen WGM
settings, latch interference, rollover, fixed-resolution masks, both output
polarities, TOP changes on both slopes, readback versus active duty, and
zero/full/toggle outputs.

Snapshots retain TEMP, active comparators, direction, prescaler remainder and
the one-clock compare block. The tests resume incomplete reads/writes and pending
buffers, including through PRR, sleep and GTCCR prescaler reset. Older snapshots
fall back to their saved register words when the new optional fields are absent;
reset clears the new private state.

Existing tests that wrote ICR1 before selecting a TOP mode now initialize it in
a stopped CTC configuration. Counter snapshots read low before high. Fast PWM
tests now distinguish reaching TOP from the following BOTTOM. Arduino-style PWM
tests wait for the buffer transfer before checking the reported duty.

Complete source, Chromium, native and packed-package results are recorded in
[release evidence](release-0.1.1.md). Native result/timing/Optiboot checks retain
their existing normalizations; they do not directly prove these new Timer1
rules against physical hardware. The new cases are datasheet-derived source
regressions.

## Remaining boundaries

The [subsequent timer boundary batch](timer-boundary-correctness.md) adds CTC
TOP+1 periods, delayed ordinary compare flags and Timer0/Timer2 PWM buffers.
`docs/limitations.md` retains external T0/T1 wiring, reserved WGM modes, the
Timer2 asynchronous register latch, and Timer1 fast-PWM overflow phase relative
to simavr as boundaries. This batch does not claim complete timer silicon fidelity.
