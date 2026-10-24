# programming-timing runtime probe

Runs from a 256-word boot section at byte 0x7e00. It waits for EEPROM address 7 to become 0x5a, erases flash page 0x0200, fills word 0x5aa5 and writes it. A Timer1 /8 counter measures programming. The result records EEPE immediately after start, EEPROM ticks, EEPROM readback, SELFPRGEN after erase, erase ticks, SELFPRGEN after write and flash readback. Expected EEPROM 6800..6810 ticks and erase 8200..8210 ticks. Tags are 0x60/0x5c. Native simavr completes immediately in this build: its data agreement is retained separately from timing failure.

All probes write a 21-byte block at SRAM 0x0300, beginning with 0xa7 and
ending with 0x5c. No result-mode switch is needed. The programming and external
clock budgets are 300,000 cycles; Timer1 TOP uses 2,000,000. Firmware is compiled
with local AVR GCC 15.2.0. Ordinary tests consume tracked HEX/listing.

```powershell
./avr-gcc/bin/avr-gcc.exe -mmcu=atmega328p -Os -DF_CPU=16000000UL -nostartfiles -Wl,--section-start=.bootloader=0x7e00 examples/programming-timing/programming-timing.c -o examples/programming-timing/programming-timing.elf
./avr-gcc/bin/avr-objcopy.exe -O ihex -R .eeprom examples/programming-timing/programming-timing.elf examples/programming-timing/programming-timing.hex
./avr-gcc/bin/avr-objdump.exe -d examples/programming-timing/programming-timing.elf
bun run oracle:simavr:runtime
bun test test/runtime-fidelity-results.test.ts
```

`bun run fixtures:avr-gcc` regenerates these probes with the same flags and
writes their listings. [Raw runtime results](../../docs/evidence/runtime-fidelity-2026-10-10.json)
retain SHA-256 identities, both execution modes and the native disagreement.
