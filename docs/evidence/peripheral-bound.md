# High-baud USART / PWM / ADC benchmark

Date: 2026-10-06. Emulator source: `e1123e64d836fb4912bb2188fefe0e6dd1e9c8ff`.
This batch adds a fixture, benchmark instrumentation and oracle coverage;
it does not change emulator library code or publish `0.1.2`.

## Workload and acceptance

[The compiled Uno sketch](../../examples/arduino-peripheral-bound/README.md)
transmits at 1 Mbaud, drives two 62.5 kHz PWM outputs and handles ADC interrupts,
with Idle sleep/wake between interrupts. Each batch sends 512 bytes and takes
32 ADC samples; it repeats continuously unless the result runner requests halt.
Source, HEX and disassembly were rebuilt together with Arduino AVR 1.8.8's
GCC 7.3.0, `-Os -flto` and the cached Uno core. Arduino CLI was unavailable.
HEX SHA-256: `56f016122169d965cfb673dd6856537687ad2a8fa7d0a7ce397a2ba17d6eef80`.

The first draft exposed avr8js 0.21.0's UCSRA write/UDRE-enable ordering and
ADC ADIF write handling: it sent no bytes or acknowledged an early ADC event.
The final sketch primes the first byte directly and relies on ISR flag
acknowledgement. It also disables ADC after sample 32: avrts correctly starts
an enabled idle ADC on sleep entry, whereas the two peers do not reproduce
that implicit start here. Clearing only ADIE left extra conversions in avrts.
The final sketch uses explicit conversion starts and shutdown; there is no
new result normalization or peer-library patch.

The result mode writes the same 21 bytes, 512-byte serial transcript and
register summary in avrts, avr8js and native simavr. ADC0 values 0, 123, 512,
777 and 1023 passed both references. Midpoint result:

```text
a7 20 00 40 00 02 01 00 ff 00 02 a0 5f 01 00 08 07 00 02 01 5c
```

Completion cycles were 90,721 (simavr), 98,274 (avr8js) and 100,006 (avrts
polling in 10,000-cycle chunks). These are not identical timing measurements;
the acceptance gate compares completed output and deterministic state.

## Throughput and activity

Host: Intel i7-7700K 4.20 GHz, Windows 10 IoT Enterprise LTSC 10.0.19044.
Both engines ran Bun 1.3.14 / JavaScriptCore, with avr8js 0.21.0.
The run was sequential after oracle checks, without overlapping validation.

```powershell
bun run bench:compare --case peripheral-bound --isolate --repeats 5 --cycles 50000000 --output docs/evidence/peripheral-bound-comparison-2026-10-06.json
```

Each trial constructed a fresh simulator outside the timer and warmed up for
500,000 cycles before the 50,000,000-cycle measured interval. USART byte and
D9/D10 pin counters were attached to both engines; their callbacks are included
in execution time. Only activity after warm-up is reported. avrts trials ran
first and avr8js second; the rates are best of five. [Raw samples](peripheral-bound-comparison-2026-10-06.json)
retain actual cycles, setup/execution times and activity.

| Engine | Best Mcycles/s | Serial bytes per measured interval | PWM edges per measured interval |
| --- | ---: | ---: | ---: |
| avrts | 25.02 | 283,760 | 781,250 |
| avr8js | 25.58 | 261,895 | 781,250 |

Ratio: **0.98x**. This is a host-specific near-parity cycle-rate sample, not
a code optimization or proof of equal work rates. Different USART buffering,
frame completion and interrupt/wake models produce different serial counts.
The same final output in result mode is a separate gate. Neither throughput
nor these counters establish physical edge timing or real-browser UI capacity.

The construction-inclusive internal benchmark measured 13.00 Mcycles/s
(three 5-million-cycle runs); its regression floor is deliberately conservative
at 1 Mcycles/s with a short 1-million-cycle test budget. It catches gross
regressions without treating isolated execution rates as construction-inclusive
rates or making a realtime claim on every machine.

## Profile and validation

The 5-million-cycle fast profile recorded 3,692,224 profile events. Sleep rows
accounted for 2,387,071 simulated cycles (47.7%). USART data-register-empty
ISR rows each executed 28,319 times. The profile's event count describes
instrumented execution steps, not the number of peripheral queue callbacks.
This mix adds sleep/interrupt/output scheduling pressure to the arithmetic
fixtures; it is not a pure scheduler microbenchmark because ISR code also costs.

| Representative PC (word address) | Row | Count | Simulated cycles |
| --- | --- | ---: | ---: |
| `0x01e8` | Sleep | 2,174,767 | 2,387,071 |
| `0x0142` | USART UDRE ISR RETI | 28,319 | 113,276 |
| `0x0026` | USART UDRE vector JMP | 28,319 | 84,957 |
| `0x0111` | USART UDRE ISR PUSH | 28,319 | 56,638 |
| `0x011a` | USART UDRE ISR LDS | 28,319 | 56,638 |
| `0x012f` | USART UDRE ISR ADIW | 28,319 | 56,638 |

Eleven regressions cover independently expected serial/result bytes at five
ADC inputs, ongoing output/ADC batches after warm-up in fast and cycle-exact
modes, exact one-batch shutdown, activity counter boundaries and isolated CLI
activity in both engines. The new workload also has a throughput floor.
Typechecking and all 48 initial focused tests passed. Both default result
runners passed all five fixtures, and native simavr passed the five ADC inputs.
The full release check passed 2,743 source tests, 17,686 assertions across
74 files, all eight browser tests, generated-core/types/build and packed consumers.
Native timing's five cases and Optiboot passed as well. The prepared archive
remained byte-identical after repacking. Release details are recorded in
[release preparation](release-0.1.2.md).

Final-state oracles for the older throughput fixtures remain open in the plan.
WASM and translate-once JIT work remain outside this batch.
