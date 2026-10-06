#include <avr/io.h>
#include <avr/interrupt.h>
#include <avr/sleep.h>

#define RESULT ((volatile uint8_t *)0x0300)

ISR(INT0_vect) { RESULT[1]++; }
ISR(PCINT0_vect) { RESULT[2]++; }

int main(void) {
  for (uint8_t i = 0; i < 4; i++) RESULT[i] = 0;
  EICRA = _BV(ISC01) | _BV(ISC00); // Rising INT0 needs clkI/O.
  EIFR = _BV(INTF0);
  EIMSK = _BV(INT0);
  PCMSK0 = _BV(PCINT0); // PB0 provides an asynchronous wake source.
  PCIFR = _BV(PCIF0);
  PCICR = _BV(PCIE0);
  set_sleep_mode(SLEEP_MODE_PWR_DOWN);
  sleep_enable();
  RESULT[0] = 0xa7;
  sei();
  sleep_cpu();
  sleep_disable();
  cli();
  RESULT[3] = 0x5c;
  for (;;) __asm__ __volatile__("nop");
}
