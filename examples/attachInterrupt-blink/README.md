# attachInterrupt-blink Fixture

Real avr-libc ATmega328P firmware used as the golden fixture for Phase 14
(external interrupts INT0 / INT1). Each rising edge on PD2 (Arduino D2) fires
INT0; the ISR toggles PB5 (Arduino D13).

```c
ISR(INT0_vect) {
  hits++;
  if (hits & 1) PORTB |= (1 << PB5);
  else PORTB &= ~(1 << PB5);
}

int main(void) {
  DDRB |= (1 << PB5);   // pin 13 output
  DDRD &= ~(1 << PD2);  // pin 2  input
  EICRA = (1 << ISC01) | (1 << ISC00); // INT0 = rising edge
  EIMSK = (1 << INT0);                // enable INT0
  sei();
  for (;;) { /* idle */ }
}
```

This is the raw avr-libc equivalent of the Arduino sketch in the spec:

```cpp
attachInterrupt(digitalPinToInterrupt(2), onButton, RISING);
```

It runs as a regression target for `avr.pin(2).setInput(true)` driving a real
compiled firmware.

## Build

```powershell
.\avr-gcc\bin\avr-gcc.exe -mmcu=atmega328p -DF_CPU=16000000UL -Os `
  -o examples\attachInterrupt-blink\attachInterrupt-blink.elf `
  examples\attachInterrupt-blink\attachInterrupt-blink.c
.\avr-gcc\bin\avr-objcopy.exe -O ihex -R .eeprom `
  examples\attachInterrupt-blink\attachInterrupt-blink.elf `
  examples\attachInterrupt-blink\attachInterrupt-blink.hex
.\avr-gcc\bin\avr-objdump.exe -d `
  examples\attachInterrupt-blink\attachInterrupt-blink.elf `
  > examples\attachInterrupt-blink\attachInterrupt-blink.lst
```

The committed `.hex` and `.lst` let tests run without the toolchain.
