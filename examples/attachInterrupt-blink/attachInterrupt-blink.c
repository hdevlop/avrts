/*
 * attachInterrupt-blink — golden fixture for Phase 14 external interrupts.
 *
 * Real avr-libc firmware (no Arduino core). Mirrors a rising edge on PD2 (D2)
 * to PB5 (D13): each INT0 interrupt toggles the LED.
 *
 *   INT0 is configured for rising-edge trigger via EICRA (ISC01:ISC00 = 11),
 *   enabled via EIMSK (INT0 = 1), then the firmware loops forever in main().
 *
 * The test driver calls `avr.pin(2).setInput(true)` after enabling and verifies
 * pin 13 toggles on the rising edge.
 */

#include <avr/io.h>
#include <avr/interrupt.h>

volatile unsigned char hits = 0;

ISR(INT0_vect) {
  hits++;
  if (hits & 1) PORTB |= (1 << PB5);
  else PORTB &= ~(1 << PB5);
}

int main(void) {
  DDRB |= (1 << PB5);   /* pin 13 = output */
  DDRD &= ~(1 << PD2);  /* pin 2  = input  */
  EICRA = (1 << ISC01) | (1 << ISC00); /* INT0 = rising edge */
  EIMSK = (1 << INT0);                /* enable INT0 */
  sei();
  for (;;) {
    /* idle — toggle happens in the ISR */
  }
  return 0;
}
