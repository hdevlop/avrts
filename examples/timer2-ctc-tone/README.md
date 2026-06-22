# timer2-ctc-tone

Real avr-libc ATmega328P firmware used as the golden fixture for Phase 13 output
compare behavior.

The program configures Timer2 in CTC mode and toggles OC2A, which maps to PB3 /
Arduino D11:

```c
DDRB |= (1 << PB3);
OCR2A = 4;
TCCR2A = (1 << WGM21) | (1 << COM2A0);
TCCR2B = (1 << CS20);
```

The simulator test watches `avr.pin(11).onChange(...)`. No UI code needs direct
timer knowledge to see the square-wave edges.
