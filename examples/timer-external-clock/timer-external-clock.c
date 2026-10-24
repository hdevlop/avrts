#include <avr/io.h>
#include <avr/interrupt.h>

int main(void) {
  cli();
  volatile uint8_t *out = (volatile uint8_t *)0x300;
  DDRD = _BV(PD4) | _BV(PD5);
  TCCR0B = 7;
  TCCR1B = 7;
  TCNT0 = 254;
  TCNT1 = 65534;
  for (uint8_t i = 0; i < 4; i++) {
    PORTD = _BV(PD4) | _BV(PD5);
    __asm__ volatile("nop\n\tnop\n\tnop\n\tnop\n\tnop");
    PORTD = 0;
    __asm__ volatile("nop\n\tnop\n\tnop\n\tnop\n\tnop");
  }
  out[0] = 0xa7;
  out[1] = TCNT0;
  out[2] = TCNT1L;
  out[3] = TCNT1H;
  out[4] = TIFR0 & 7;
  out[5] = TIFR1 & 7;
  for (uint8_t i = 6; i < 19; i++) out[i] = 0;
  out[19] = 0x61;
  out[20] = 0x5c;
  while (1) {}
}
