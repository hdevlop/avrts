void setup() {
  analogWrite(5, 191);
  analogWrite(9, 64);
  analogWrite(10, 192);
  analogWrite(11, 51);
  analogWrite(3, 128);
  if (*(volatile uint8_t*)0x02ff == 0x42) {
    // Observe live hardware PWM for more than eight full phase-correct periods.
    delay(20);
    noInterrupts();
    volatile uint8_t* out = (volatile uint8_t*)0x0300;
    out[0] = 0xa7;
    out[1] = OCR0B;
    out[2] = (uint8_t)OCR1A;
    out[3] = (uint8_t)OCR1B;
    out[4] = OCR2A;
    out[5] = OCR2B;
    out[6] = TCCR0A;
    out[7] = TCCR0B;
    out[8] = TCCR1A;
    out[9] = TCCR1B;
    out[10] = TCCR2A;
    out[11] = TCCR2B;
    out[12] = DDRB;
    out[13] = DDRD;
    for (uint8_t i = 14; i < 19; i++) out[i] = 0;
    out[19] = 0x54;
    TCCR0A = 0; TCCR0B = 0;
    TCCR1A = 0; TCCR1B = 0;
    TCCR2A = 0; TCCR2B = 0;
    PORTB &= (uint8_t)~(_BV(PORTB1) | _BV(PORTB2) | _BV(PORTB3));
    PORTD &= (uint8_t)~(_BV(PORTD3) | _BV(PORTD5));
    out[20] = 0x5c;
    while (1) {}
  }
}

void loop() {
}
