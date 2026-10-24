void setup() {
  Serial.begin(9600);
  Serial.println("hello avrts");
  if (*(volatile uint8_t*)0x02ff == 0x42) {
    Serial.flush();
    noInterrupts();
    volatile uint8_t* out = (volatile uint8_t*)0x0300;
    out[0] = 0xa7;
    out[1] = UCSR0A & _BV(TXC0);
    out[2] = UCSR0B;
    out[3] = UCSR0C;
    out[4] = UBRR0L;
    out[5] = UBRR0H;
    for (uint8_t i = 6; i < 19; i++) out[i] = 0;
    out[19] = 0x51;
    out[20] = 0x5c;
    while (1) {}
  }
}

void loop() {
}
