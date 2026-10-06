#include <avr/io.h>
#include <avr/interrupt.h>
#include <avr/sleep.h>

#define RESULT ((volatile uint8_t *)0x0300)

ISR(TIMER2_COMPA_vect) {
  RESULT[5] = TCNT2;
  RESULT[6] = TIFR2;
}

int main(void) {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;
  ASSR = _BV(AS2);
  TCNT2 = 0;
  OCR2A = 2;
  OCR2B = 250;
  TCCR2A = 0;
  TCCR2B = _BV(CS21); // /8; distinguish timer clocks from raw TOSC clocks.
  while (ASSR & 0x1f) {}
  GTCCR = _BV(PSRASY);
  RESULT[1] = GTCCR; // Immediate acknowledgement sample.
  // Bound this probe: native simavr can retain a plain GTCCR storage bit.
  uint8_t polls = 0;
  while ((GTCCR & _BV(PSRASY)) && ++polls) {}
  RESULT[2] = GTCCR;
  GTCCR = 0;
  TIFR2 = 7;
  while (!(TIFR2 & _BV(OCF2A))) {}
  RESULT[3] = TCNT2; // CPU-visible flag must follow the counter match.
  RESULT[4] = TIFR2;

  // Use a later match to wake from power-save and sample the synchronized read.
  OCR2A = 6;
  while (ASSR & _BV(OCR2AUB)) {}
  TIFR2 = 7;
  TIMSK2 = _BV(OCIE2A);
  set_sleep_mode(SLEEP_MODE_PWR_SAVE);
  sleep_enable();
  sei();
  sleep_cpu();
  sleep_disable();
  cli();
  RESULT[0] = 0xa7;
  RESULT[7] = 0x5c;
  for (;;) __asm__ __volatile__("nop");
}
