# Analog input and sleep boundary review

Date: 2026-10-06. Baseline: `8fb5eda48575d3d16cbc5135ab3fb017a319b2b6`.
Follow-up for the unpublished `@hdevlop/avrts@0.1.2` preparation.

## Confirmed problems and references

The [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf)
sections 9.3/9.4 specify automatic conversion on entry to idle or ADC
noise-reduction sleep when ADC is enabled. avrts implemented only the latter.
Section 9.10.2 automatically disables the comparator in deeper sleep modes;
the simulator continued generating events and false wakes from host changes.
Table 9-1 and section 9.4 exclude comparator interrupt wake outside idle;
the pending queue previously allowed it, including a pre-sleep flagged request.
Section 22.2 connects the selected ADC input to the comparator through ACME
when ADEN is clear. Host channel setters changed that input without notifying
the comparator, making interrupt/capture events depend on a later ACSR or
output read.

The initial 108-case matrix produced 88 failures and 20 passes. Separate
wake-order checks produced eight held-input failures and eight completed-pulse
passes. Wake-source filtering checks produced 22 failures and ten W1C passes.

## Correction

Idle and noise-reduction entry now share the enabled-ADC conversion path.
ADEN and PRADC retain their gates; a running conversion keeps its sample and
deadline. First and subsequent conversions retain their existing timing.

ADC host setters notify analog input listeners after updating the channel.
The comparator reevaluates only when that channel is its selected ACME input.
Unselected inputs, ADEN, ACME-off and ACD retain their behavior. Events can
request the comparator vector or drive Timer1 capture without a read hook.

Deep sleep retains the last logical comparator output while raw AIN and ADC
inputs can change. Completed pulses produce no event. Wake samples held
inputs using the logical voltage model. Runtime construction registers this
sampling after the sleep clock listener so ADC auto-trigger and Timer1 capture
see resumed clocks. Explicit ACD remains effective after wake.

Comparator requests are withdrawn on non-idle sleep entry, including previously
latched requests. Logical flags can remain set in noise-reduction mode, but
cannot wake the CPU. After an eligible source wakes it, flags regain ordinary
masked delivery. W1C can discard the saved flag before wake. Idle acknowledgement
does not queue the selected interrupt twice.

Snapshot version 1 is unchanged. Saved raw voltages, ADC samples, comparator
output and flags retain their roles. The comparator derives its sleep request
gate from the restored CPU mode and removes an ineligible old pending request.
Input listeners are not fired during restore, avoiding manufactured edges.

## Regression evidence

The final `test/analog-sleep-boundaries.test.ts` passed 272 cases with 2,116
assertions. It exercises both execution modes, direct
and restored state, ADC first/subsequent/in-flight samples, ADEN/PRADC gates,
all eight ACME channels with value/voltage setters, masked delivery, ACD,
idle wake, non-idle saved flags and W1C, completed/held direct and ACME inputs,
Timer1 capture and comparator-to-ADC auto-trigger after wake.

`examples/analog-sleep-probe` includes C, HEX and disassembly built together
with `avr-gcc -mmcu=atmega328p -Os -DF_CPU=16000000UL`. Firmware sleeps in idle
without writing ADSC, reads the conversion in its ADC ISR, and then enters
power-down with comparator and PCINT enabled. A comparator pulse cannot wake
it; PB0 supplies the eligible wake source. With ADC input 123:

| Comparator input before PCINT wake | Result bytes |
| --- | --- |
| Held high | `a7 7b 00 01 01 01 5c` |
| Returned low before wake | `a7 7b 00 00 01 00 5c` |

These results cover both execution modes and snapshot restore. This compiled
source regression does not add a native analog timing comparison. Complete
validation and archive metadata are recorded in
[0.1.2 preparation](release-0.1.2.md).

## Focused performance

Compared final source against the clean baseline above on Intel i7-7700K
4.20 GHz, Windows 10 IoT Enterprise LTSC 10.0.19044 and Bun 1.3.14. Comparisons
ran sequentially after validation with no overlapping checks, baseline first.
Each workload/revision used a fresh Bun process and 500,000 warm-up cycles
before each trial, discarding the first of ten trials and taking the median
of the remaining nine. Construction was excluded.

`scripts/benchmark-revision.ts` ran the ordinary firmware workloads with
50,000,000 cycles per trial. The watchdog sleep probe reused the
[preceding sleep method](wake-clock-domains.md#focused-sleep-performance), with
100,000,000 cycles per trial and the same compiled LowPower WDT fixture;
its helper is retained locally as ignored `logs/benchmark-analog-sleep.ts`.

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Median change | Samples |
| --- | --- | --- | --- | --- |
| Arduino PWM | 301.78 | 309.65 | +2.6% | [JSON](analog-sleep-performance-analog-write.json) |
| Interrupt-heavy | 79.06 | 78.36 | -0.9% | [JSON](analog-sleep-performance-isr-heavy.json) |
| Repeated watchdog sleep/wake | 80.38 | 80.99 | +0.8% | [JSON](analog-sleep-performance-lowpower.json) |

These focused measurements include JIT and host variation. They retain the
small measured interrupt-workload cost and do not establish a universal speed
improvement or rule out costs in other workloads.

## Remaining boundaries

Comparator output retention while powered off and held-level sampling at wake
are deterministic logical conventions. Physical output during shutdown,
power-up settling, bandgap startup, ACO's 1–2-clock synchronization and exact
capture/ADC-trigger pipeline timing have not been calibrated. Noise-reduction
flag timing remains logical even though wake eligibility is now filtered.
ACME requires PRADC clear on hardware; behavior with that gate set remains
unsupported. This change does not complete filtering for all other CPU wake
sources. Existing Timer2 handshake limits remain open. See
[limitations](../limitations.md).
