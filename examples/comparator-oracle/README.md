# Analog Comparator Native Oracle

Analog-comparator native-oracle fixture (`.c`, avr-libc).

The firmware arms the comparator to interrupt on the **rising** output edge
(`ACSR.ACIS1:0 = 11`) and tallies edges in the `ANALOG_COMP` ISR. An external
harness parks AIN0 below AIN1 (ACO low), then drives AIN0 above AIN1 to produce
one rising edge. The result block at SRAM `0x0300` is
`[start, risingEdges, acoLive, acoInIsr, end]`, and the end marker is withheld
until the ISR has run so the oracle can detect completion.

Run the native comparison with:

```
bun run oracle:simavr:timing -- --timing-case comparator
```

simavr drives the comparator through its `ACOMP_IRQ_AIN0/AIN1` input IRQs
(millivolts); avrts drives the same edge through `avr.comparator.setInput(...)`
at the identical injected cycle. The firmware-visible result block
(`a7 01 01 01 5c`) is compared, not the injection delay. The comparator model is
also covered by `test/phase4-small-peripherals.test.ts`,
`test/comparator-interrupt.test.ts`, and `examples/arduino-comparator-interrupt`.

Regenerate the `.hex`/`.lst` with `bun run fixtures:avr-gcc`.
