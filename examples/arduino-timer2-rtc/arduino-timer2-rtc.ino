#include <Arduino.h>
#include <avr/interrupt.h>

// RTC-style sketch: keep wall-clock seconds from a 32.768 kHz watch crystal on
// Timer2's asynchronous TOSC input, the classic "software RTC" every Arduino
// low-power/clock project uses. Prescaler 128 makes Timer2 overflow once per
// second (32768 / 128 / 256 = 1 Hz); the overflow ISR counts seconds. Results
// land in SRAM at 0x0300 so a host test can read the clock without a UART.

#define RESULT ((volatile uint8_t*)0x0300)

volatile uint32_t seconds = 0;

ISR(TIMER2_OVF_vect) {
  seconds++;
}

static void publishResult(void) {
  RESULT[0] = 0xa7;
  RESULT[1] = (uint8_t)(seconds & 0xff);
  RESULT[2] = (uint8_t)((seconds >> 8) & 0xff);
  RESULT[3] = TCNT2; // sub-second asynchronous tick (0..255).
  RESULT[4] = 0x5c;
}

void setup() {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;

  cli();
  // Clock Timer2 from the external 32.768 kHz crystal on TOSC1/TOSC2.
  ASSR = _BV(AS2);
  // Normal mode, prescaler 128 -> one overflow per second.
  TCCR2A = 0;
  TCCR2B = _BV(CS22) | _BV(CS20);
  TCNT2 = 0;
  // Datasheet async init: wait for the update-busy flags to clear before
  // clearing the flag and enabling the overflow interrupt.
  while (ASSR & (_BV(TCN2UB) | _BV(TCR2AUB) | _BV(TCR2BUB))) {
  }
  TIFR2 = _BV(TOV2);
  TIMSK2 = _BV(TOIE2);
  sei();

  publishResult();
}

void loop() {
  publishResult();
}
