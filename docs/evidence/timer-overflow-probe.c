#include <avr/io.h>
#define R ((volatile unsigned char *)0x300)
int main(void) {
  TCCR0A = 3; TCCR0B = 5;
  while (!(TIFR0 & 1)) {}
  R[1] = TCNT0; TCCR0B = 0;
  TCCR2A = 3; TCCR2B = 7;
  while (!(TIFR2 & 1)) {}
  R[2] = TCNT2; TCCR2B = 0;
  TCCR1B = (1 << WGM13) | (1 << WGM12); ICR1 = 3;
  TCCR1A = (1 << WGM11); TCCR1B |= 5;
  while (!(TIFR1 & 1)) {}
  R[3] = TCNT1L; TCCR1B = 0;
  R[0] = 0xa7; R[4] = 0x5c;
  for (;;) {}
}
