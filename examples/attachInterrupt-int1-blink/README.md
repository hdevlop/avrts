# attachInterrupt-int1-blink

Real avr-libc ATmega328P firmware used as the golden fixture for Phase 14
external interrupt coverage on INT1 / Arduino D3.

Each falling edge on PD3 fires `INT1_vect`; the ISR toggles PB5 / Arduino D13:

```c
ISR(INT1_vect) {
  hits++;
  if (hits & 1) PORTB |= (1 << PB5);
  else PORTB &= ~(1 << PB5);
}
```

The test driver uses `avr.pin(3).setInput(true)` then
`avr.pin(3).setInput(false)` to trigger the falling edge.
