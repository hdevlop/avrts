/*
 * attachInterrupt-int1-blink - golden fixture for Phase 14 external interrupts.
 *
 * Real avr-libc firmware. Mirrors a falling edge on PD3 (Arduino D3 / INT1)
 * to PB5 (Arduino D13): each INT1 interrupt toggles the LED.
 */

#include <avr/io.h>
#include <avr/interrupt.h>

volatile unsigned char hits = 0;

ISR(INT1_vect) {
  hits++;
  if (hits & 1) PORTB |= (1 << PB5);
  else PORTB &= ~(1 << PB5);
}

int main(void) {
  DDRB |= (1 << PB5);  /* pin 13 = output */
  DDRD &= ~(1 << PD3); /* pin 3  = input  */
  EICRA = (1 << ISC11); /* INT1 = falling edge */
  EIMSK = (1 << INT1);  /* enable INT1 */
  sei();

  for (;;) {
    /* idle - toggle happens in the ISR */
  }

  return 0;
}
