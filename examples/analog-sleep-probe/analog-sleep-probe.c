#include <avr/io.h>
#include <avr/interrupt.h>
#include <avr/sleep.h>

#define RESULT ((volatile uint8_t *)0x0300)

ISR(ADC_vect) { RESULT[1] = ADCL; RESULT[2] = ADCH; }
ISR(ANALOG_COMP_vect) { RESULT[3]++; }
ISR(PCINT0_vect) { RESULT[4]++; }

int main(void) {
  for (uint8_t i = 0; i < 7; i++) RESULT[i] = 0;
  RESULT[0] = 0xa7;
  ADMUX = _BV(REFS0);
  ADCSRA = _BV(ADEN) | _BV(ADIE) | _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0);
  set_sleep_mode(SLEEP_MODE_IDLE);
  sleep_enable();
  sei();
  sleep_cpu(); // Sleep entry starts ADC without an ADSC write.
  sleep_disable();
  cli();
  ADCSRA = 0;
  ACSR = _BV(ACIS1) | _BV(ACIS0) | _BV(ACIE) | _BV(ACI);
  PCMSK0 = _BV(PCINT0);
  PCIFR = _BV(PCIF0);
  PCICR = _BV(PCIE0);
  set_sleep_mode(SLEEP_MODE_PWR_DOWN);
  sleep_enable();
  sei();
  sleep_cpu(); // Comparator changes cannot wake this mode; PB0 wakes it.
  sleep_disable();
  cli();
  RESULT[5] = (ACSR & _BV(ACO)) != 0;
  RESULT[6] = 0x5c;
  for (;;) __asm__ __volatile__("nop");
}
