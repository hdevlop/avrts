# Arduino Analog-Comparator Interrupt

Arduino analog-comparator interrupt validation fixture.

The sketch arms the on-chip comparator interrupt on the **rising** output edge
(`ACSR.ACIS1:0 = 11`) and counts edges in `ISR(ANALOG_COMP_vect)`, the pattern a
zero-cross detector or over-current trip uses. The result block at SRAM `0x0300`
holds the start marker, the rising-edge tally, the ACO level sampled inside the
ISR, the live ACO level, and the end marker. `test/comparator-interrupt.test.ts`
drives the comparator inputs from the host and asserts only rising output edges
raise the interrupt, exercising ACO evaluation, edge selection, `ACI`, and
interrupt dispatch end to end through real Arduino ISR code.

Regenerate with `bun run fixtures:arduino` (needs `arduino-cli` and the
`arduino:avr` core).
