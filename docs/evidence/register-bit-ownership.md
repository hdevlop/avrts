# Register bit ownership follow-up

Date: 2026-10-05. Baseline: `0efbc61e5704133ba5068381c6a5b7d50aedb0f7`.
Included in the prepared, unpublished 0.1.1 patch.

## Change

Firmware writes previously retained reserved bits in several timer, interrupt,
ADC, addressing and GPIO registers. UBRR0H's unsupported bits also entered the
USART frame calculation, multiplying frame time. The owning peripheral hooks
now mask these bits before applying their normal behavior.

Reference: [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
register summary and sections 10.9.1, 13.4 and 23.9.3. MCUSR writes can clear
reset flags with zero but cannot set flags. Non-power-on resets accumulate
previous causes; power-on clears other causes and sets PORF. ADCL/ADCH writes
are ignored without altering result read locking. PC7 is absent from port C;
its writes, toggles, host inputs and peripheral overrides cannot produce a level
or pin-change request.

The EEPROM high-address mask derives from the modeled 1,024-byte capacity
(`EEPROM_SIZE`), retaining both high address bits and access to byte 1,023.
The automotive PDF's section 7.6.1 contains a conflicting 9-bit description
alongside the 1K capacity; this implementation retains the ATmega328P's full
10-bit EEPROM address space rather than reducing it to 512 bytes.

## Scope

The regression table checks these CPU-visible masks, including timer controls
already corrected in previous batches:

| Registers | Readable mask |
| --- | --- |
| TCCR0A, TCCR1A, TCCR2A | `f3` |
| TCCR0B, TCCR2B | `0f` (FOC strobes read zero) |
| TCCR1B | `df` |
| TCCR1C | `00` (FOC strobes read zero) |
| TIMSK0, TIMSK2, PCICR | `07` |
| TIMSK1 | `27` |
| PCMSK1, DDRC, PORTC | `7f` |
| EICRA, UBRR0H, SMCR | `0f` |
| EIMSK, DIDR1, EEARH | `03` |
| ADCSRB | `47` |
| ADMUX | `ef` |
| DIDR0 | `3f` |
| TWAMR | `fe` |

Timer and pin interrupt flag writes also mask unsupported flags while preserving
their write-one-to-clear protocol. DIDR0/1 now have bit-mask hooks and are
classified accordingly in the register matrix; their digital-buffer electrical
effect remains outside the simulator.

## Evidence

`test/register-bit-ownership.test.ts` adds 76 regressions in fast/cycle-exact
execution. The mask table checks writes and snapshot/restore. Behavioral cases
check UART completion, EEPROM boundaries, valid GPIO toggles/interrupts, reset
cause accumulation and clearing, ADC data ownership in both alignments, result
locking through restore, and flag acknowledgement. Earlier reset tests now
expect the documented accumulation instead of replacement.

A source probe against the clean baseline and candidate recorded:

| Operation | Baseline | Candidate |
| --- | --- | --- |
| TCCR0A write `0c` | `0c` | `00` |
| TIMSK1 write `ff` | `ff` | `27` |
| UBRR0H write `f0` | `f0` | `00` |
| ADCSRB write `ff` | `ff` | `47` |
| EEARH write `ff` | `ff` | `03` |
| ADCL write `ff` after reset | `ff` | `00` |
| PORTC write `80` | `80` | `00` |
| MCUSR clear, then write `ff` | `ff` | `00` |
| Power-on followed by external reset | `02` | `03` |

Full source/browser/package checks and established native comparisons are in
[release evidence](release-0.1.1.md). These register contracts are validated
against the datasheet, not new physical-hardware or native-simavr acceptance.
The existing SPI status and Timer1 overflow disagreements remain documented.
Focused source performance measurements are in
[performance evidence](register-bits-performance.md).

## Remaining boundaries

Direct host mutation of `cpu.data` bypasses firmware register protocols. Valid
register values survive snapshots; older snapshots containing invalid reserved
bits are corrected by their next firmware write, while GPIO restore also masks
its port-C state. This change does not add external timer clocks, asynchronous
wake synchronization, EEPROM programming latency, or electrical input buffers.
See [limitations](../limitations.md).
The review also identified the independent timer-divider remainder model:
clock-select changes and staggered starts do not share the free-running
Timer0/Timer1 prescaler phase. That timing change remains separate from this
register ownership batch and is now explicitly recorded in the limitations.
