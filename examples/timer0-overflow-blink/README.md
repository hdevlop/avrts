# Timer0 Overflow Blink Fixture

Real avr-gcc ATmega328P firmware used as a golden simulator fixture.

The program configures PB5 / Arduino digital pin 13 as an output, enables
Timer0 overflow interrupts without prescaling, and toggles PB5 in the
`TIMER0_OVF_vect` ISR.

Build from the repository root:

```powershell
.\avr-gcc\bin\avr-gcc.exe -mmcu=atmega328p -DF_CPU=16000000UL -Os -o examples\timer0-overflow-blink\timer0-overflow-blink.elf examples\timer0-overflow-blink\timer0-overflow-blink.c
.\avr-gcc\bin\avr-objcopy.exe -O ihex -R .eeprom examples\timer0-overflow-blink\timer0-overflow-blink.elf examples\timer0-overflow-blink\timer0-overflow-blink.hex
.\avr-gcc\bin\avr-objdump.exe -d examples\timer0-overflow-blink\timer0-overflow-blink.elf > examples\timer0-overflow-blink\timer0-overflow-blink.lst
```

`timer0-overflow-blink.hex` and `.lst` are committed so tests do not need the
toolchain at runtime.
