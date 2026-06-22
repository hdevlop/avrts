#include <avr/interrupt.h>
#include <avr/io.h>

ISR(TIMER0_OVF_vect) {
  PINB = _BV(PINB5);
}

int main(void) {
  DDRB |= _BV(DDB5);
  TCCR0B = _BV(CS00);
  TIMSK0 = _BV(TOIE0);
  sei();

  for (;;) {
  }
}
