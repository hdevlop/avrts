# timer-external-clock runtime probe

Sets Timer0 and Timer1 to external rising-edge clocks, loads counters 254 and 65534, and drives four long pulses on PD4/PD5 through PORTD. Expected counters are 2/2 and overflow plus both compare flags equal 7/7. This checks counts and flags, not native synchronization latency. Tags are 0x61/0x5c.

All probes write a 21-byte block at SRAM 0x0300, beginning with 0xa7 and
ending with 0x5c. No result-mode switch is needed. The programming and external
clock budgets are 300,000 cycles; Timer1 TOP uses 2,000,000. Firmware is compiled
with local AVR GCC 15.2.0. Ordinary tests consume tracked HEX/listing.

```powershell
./avr-gcc/bin/avr-gcc.exe -mmcu=atmega328p -Os -DF_CPU=16000000UL examples/timer-external-clock/timer-external-clock.c -o examples/timer-external-clock/timer-external-clock.elf
./avr-gcc/bin/avr-objcopy.exe -O ihex -R .eeprom examples/timer-external-clock/timer-external-clock.elf examples/timer-external-clock/timer-external-clock.hex
./avr-gcc/bin/avr-objdump.exe -d examples/timer-external-clock/timer-external-clock.elf
bun run oracle:simavr:runtime
bun test test/runtime-fidelity-results.test.ts
```

`bun run fixtures:avr-gcc` regenerates these probes with the same flags and
writes their listings. [Raw runtime results](../../docs/evidence/runtime-fidelity-2026-10-10.json)
retain SHA-256 identities, both execution modes and the native disagreement.
