# timer1-top runtime probe

Selects stopped Timer1 mode 14 before writing ICR1=1000 (ICR1 is writable only when it defines TOP), then starts /1024 and polls TOV1. avrts reads counter 1000 at TOP; native simavr reads zero at BOTTOM. That discrepancy is preserved; the standard datasheet defines TOP. Tags are 0x62/0x5c.

All probes write a 21-byte block at SRAM 0x0300, beginning with 0xa7 and
ending with 0x5c. No result-mode switch is needed. The programming and external
clock budgets are 300,000 cycles; Timer1 TOP uses 2,000,000. Firmware is compiled
with local AVR GCC 15.2.0. Ordinary tests consume tracked HEX/listing.

```powershell
./avr-gcc/bin/avr-gcc.exe -mmcu=atmega328p -Os -DF_CPU=16000000UL examples/timer1-top/timer1-top.c -o examples/timer1-top/timer1-top.elf
./avr-gcc/bin/avr-objcopy.exe -O ihex -R .eeprom examples/timer1-top/timer1-top.elf examples/timer1-top/timer1-top.hex
./avr-gcc/bin/avr-objdump.exe -d examples/timer1-top/timer1-top.elf
bun run oracle:simavr:runtime
bun test test/runtime-fidelity-results.test.ts
```

`bun run fixtures:avr-gcc` regenerates these probes with the same flags and
writes their listings. [Raw runtime results](../../docs/evidence/runtime-fidelity-2026-10-10.json)
retain SHA-256 identities, both execution modes and the native disagreement.
