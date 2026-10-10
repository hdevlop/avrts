#include <avr/io.h>
#include <avr/interrupt.h>

int main(void) {
  cli();
  volatile uint8_t *out = (volatile uint8_t *)0x300;
  TCCR1A = _BV(WGM11);
  TCCR1B = _BV(WGM13) | _BV(WGM12);
  ICR1 = 1000;
  TCCR1B = _BV(WGM13) | _BV(WGM12) | _BV(CS12) | _BV(CS10);
  while (!(TIFR1 & _BV(TOV1))) {}
  uint16_t count = TCNT1;
  out[0] = 0xa7;
  out[1] = count;
  out[2] = count >> 8;
  out[3] = TIFR1 & _BV(TOV1);
  for (uint8_t i = 4; i < 19; i++) out[i] = 0;
  out[19] = 0x62;
  out[20] = 0x5c;
  while (1) {}
}
