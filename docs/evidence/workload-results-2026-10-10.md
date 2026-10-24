# Complete workload result coverage - 2026-10-10

All twelve external workload labels now have result/state checks against
avr8js and native simavr. The internal serial listener label shares the serial
firmware and has separate fast/cycle-exact subscriber tests: thirteen labels
in the union, twelve distinct external fixtures. These observations measure
correctness, not throughput.

[Raw capture](workload-results-2026-10-10.json) records each HEX path/SHA-256,
both references, result bytes, registers, serial/TWI/pin traces, commands,
differences and native normalization disclosures.

| Workload | Independent check and activity |
| --- | --- |
| peripheral-mix | Existing SRAM/ADC/GPIO/TWI result; continuous peripheral work. Existing timer-threshold and PORTD-latch native normalization remain explicit. |
| isr-heavy | ISR-driven arithmetic/state result. |
| string-heavy | Formatting/string result and complete serial bytes. |
| dsp-fixed | Fixed-point DSP result and state. |
| peripheral-bound | Continuous serial/PWM/ADC result; counts distinguish useful work from cycles. |
| float-math | Bounded 32-round compiled AVR floating-point bytes; normal mode remains continuous. |
| bitbang-crc | CRC8/16, received bytes, MOSI sequence and clock edges; four inputs in focused tests. |
| sensor-format | Full 144-sample history, scaling, index wrap, endpoints and flushed serial; five starts in focused tests. |
| serial-print | Exact `hello avrts` CRLF startup line, TXC0 and baud/frame configuration; one-shot startup then idle. |
| analog-write | Five configured channels and actual steady period/high-width GPIO checks; idle foreground with active PWM. |
| delay-blink | Two actual four-second blink periods, high/low order and Timer0 timekeeping; 70-million-cycle budget. |
| tight-loop | Bounded synthetic RJMP PC/SP/SREG/register oracle; excluded from practical speed claims. |

The four new fixture READMEs define layouts, completion, budgets, expected
values and regeneration. SRAM 0x02ff=0x42 selects finite mode; the synthetic
loop uses an observation adapter without a firmware marker. The peer RAM size
is pinned to the chip's 2 KiB, correcting an artificial synthetic SP difference.
New failure tests reject corrupted bytes/configuration, truncated serial,
missing PWM edges, changed duty, wrong blink order and insufficient budgets.

Native simavr exposes the D5 fast-PWM GPIO trace. Its phase-correct GPIO traces
on D3/D9/D10/D11 are empty in this build: the native oracle explicitly records
this unsupported observation, while still checking full SRAM/configuration.
Both JS engines verify all five waveforms. This is a native observation limit,
not four successfully measured native waves. The Timer1 overflow discrepancy
is separately captured by the compiled runtime probe.

```powershell
bun scripts/workload-result-evidence.ts docs/evidence/workload-results-2026-10-10.json
bun run bench:result
bun run oracle:simavr:result
bun test test/remaining-workload-results.test.ts test/arithmetic-results.test.ts test/sensor-format-results.test.ts
```

Historical arithmetic and sensor slice records retain their dated test counts
and eight-case status. The final local acceptance record supersedes those
counts for this candidate; it does not retroactively change earlier evidence.
