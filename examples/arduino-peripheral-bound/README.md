# Peripheral event workload

This Uno sketch combines USART0 transmission at 1 Mbaud (8N1), Timer1's two
62.5 kHz hardware PWM outputs on D9/D10, and interrupt-driven ADC0 sampling
with a 128 prescaler (125 kHz ADC clock). It sleeps in Idle between interrupts.
Unlike the arithmetic fixtures, it exercises repeated peripheral scheduling,
interrupt entry/return, output delivery and wake-ups together.

Each batch sends `0..255` twice and accumulates 32 ADC samples. The ADC ISR
updates the two complementary PWM duties. The first serial byte is explicitly
primed; the remaining 511 use the data-register-empty interrupt. Completion
waits for the final transmit-complete interrupt, rather than just the UDR write.
ADC is disabled after sample 32 so later Idle entries cannot start extra samples.
These configurations follow the [ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
sections 9.3, 15.9.3, 19 and 23.4.

Default mode continuously restarts batches; the completed batch count is a
little-endian 16-bit counter at SRAM `0x0315` (wraps after 65,535). Speed runs
keep transmitting, sampling and generating PWM after warm-up. Setting SRAM
`0x02ff=0x42` before execution selects result mode: one batch, PWM shutdown,
a 21-byte result block at `0x0300`, then a halt. Both oracle runners set this mode.

| Result offsets | Meaning |
| --- | --- |
| 0, 20 | Start/end markers `a7`, `5c` |
| 1 | ADC sample count, 32 |
| 2-3 | Sum of the ADC samples, little-endian |
| 4-5, 6 | Queued byte count, 512; transmit-complete flag, 1 |
| 7-8 | Serial byte sum, `0xff00` |
| 9-10 | Last ADC sample |
| 11-12 | Final OCR1A/OCR1B duties |
| 13-16 | TCCR1A, TCCR1B, UCSR0B, ADCSRA after shutdown |
| 17-18, 19 | ADC data registers; D2 input |

```powershell
bun run bench --case peripheral-bound
bun run profile:opcodes --case peripheral-bound --mode fast
bun run bench:compare --case peripheral-bound --isolate --repeats 5 --cycles 50000000
bun run bench:result --case peripheral-bound
bun run oracle:simavr:result --case peripheral-bound
```

Source, committed HEX and disassembly were built together with Arduino AVR
1.8.8's AVR GCC 7.3.0 and cached Uno core (`-Os -flto`); Arduino CLI was
unavailable locally. Normal regeneration uses `bun run fixtures:arduino`.
See [measurement and fidelity evidence](../../docs/evidence/peripheral-bound.md)
for results, raw activity counts, coverage and comparison limitations.
