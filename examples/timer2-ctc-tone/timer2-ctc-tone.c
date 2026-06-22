/*
 * timer2-ctc-tone - golden fixture for Phase 13 output compare behavior.
 *
 * Real avr-libc firmware. Configures Timer2 in CTC mode and toggles OC2A
 * (PB3 / Arduino D11) on every compare match. This is the timer-output shape
 * used by tone-style square waves.
 */

#include <avr/io.h>

int main(void) {
  DDRB |= (1 << PB3);   /* D11 / OC2A output */
  OCR2A = 4;            /* short period for a compact test fixture */
  TCCR2A = (1 << WGM21) | (1 << COM2A0); /* CTC, toggle OC2A */
  TCCR2B = (1 << CS20); /* no prescale */

  for (;;) {
    /* hardware timer toggles the pin */
  }

  return 0;
}
