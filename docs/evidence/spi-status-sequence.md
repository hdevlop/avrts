# SPI status acknowledgement follow-up

Date: 2026-10-05. Baseline: `419061a292eba0f809dff623db60b33c3d927bc1`.
Included in the prepared, unpublished 0.1.1 patch.

## Change

Starting a master byte or a host-clocked slave byte previously cleared SPIF
and WCOL unconditionally. This could lose an unread completion, erase a write
collision or withdraw a pending interrupt before firmware acknowledged it.
Those two clears are removed. The existing SPSR-read/SPDR-access protocol
and interrupt-entry acknowledgement remain responsible for flag clearing.

Reference: [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
section 18.5.2. SPIF requires interrupt entry or a status read with SPIF set
followed by data-register access. Reading WCOL set followed by data-register
access clears both WCOL and SPIF. A status read with neither flag set does not
arm acknowledgement. A colliding SPDR write consumes an earlier acknowledgement
before setting the new collision, so the existing shared clear latch is adequate
for these reachable transitions; its representation and snapshot format are
unchanged.

## Source evidence

`test/spi-status-sequence.test.ts` adds 50 regressions: compiled-firmware
execution plus master/slave status transitions in fast/cycle-exact modes,
both directly and through restore. They cover unread flags and pending IRQs,
unarmed reads, WCOL-only status reads followed by completion, acknowledged
writes followed by fresh collisions, interrupt-entry clearing and aborted-byte
restart. The older fallback-clear test now checks preservation instead.

The compiled [probe](../../examples/spi-status-oracle/README.md) was run against
the clean preceding revision and the final implementation. Both execution modes
produced these same before/after bytes:

| Engine | Result at SRAM `0x0300` |
| --- | --- |
| avrts baseline `419061a` | `a7 00 80 40 00 00 00 5c` |
| avrts candidate | `a7 80 80 40 00 c0 00 5c` |
| local native simavr | `a7 00 00 00 00 00 00 5c` |

Bytes 1 and 5 expose the fixed transfer-start flag loss. No probe bytes were
normalized. The native row is a recorded disagreement, not a passing acceptance
result. Upstream [simavr SPI source](https://github.com/buserror/simavr/blob/master/simavr/sim/avr_spi.c)
clears SPIF on SPDR reads and writes without the preceding status read and
does not implement the WCOL sequence in those handlers. That source explains
the observed native boundary; it does not establish physical silicon acceptance.

## Validation scope

Current full source, browser, package and established native-fixture checks are
in [release evidence](release-0.1.1.md). The new probe remains an independent
diagnostic rather than another passing native timing case. Existing documented
oracle normalizations remain unchanged. This follow-up adds no performance
measurement; the prior Timer2 and timer-boundary tables retain their revision
labels. Wire-bit serialization and physical SPI timing remain outside the byte
model, as recorded in [limitations](../limitations.md).
