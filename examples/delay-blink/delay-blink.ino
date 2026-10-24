uint8_t completedPeriods = 0;

void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(1000);
  digitalWrite(13, LOW);
  delay(1000);
  if (*(volatile uint8_t*)0x02ff == 0x42 && ++completedPeriods == 2) {
    noInterrupts();
    volatile uint8_t* out = (volatile uint8_t*)0x0300;
    out[0] = 0xa7;
    out[1] = completedPeriods;
    out[2] = PORTB;
    out[3] = DDRB;
    out[4] = TCCR0A;
    out[5] = TCCR0B;
    for (uint8_t i = 6; i < 19; i++) out[i] = 0;
    out[19] = 0x52;
    out[20] = 0x5c;
    while (1) {}
  }
}
