#include <Arduino.h>
#include <avr/interrupt.h>
#include <avr/sleep.h>
#include <avr/wdt.h>

// LowPower-library-style validation fixture. The canonical Arduino low-power
// pattern (Rocket Scream's LowPower, Adafruit SleepyDog, etc.) is: arm the
// watchdog for a timeout *interrupt* (not a reset), drop into SLEEP_MODE_PWR_DOWN,
// and let the WDT wake the MCU each period. The loop configures a fresh timeout
// window before each sleep — the exact hand-off this
// sketch exercises end to end. The result block at SRAM 0x0300 counts wakeups so
// a host test can watch the MCU sleep and wake without any I/O pins.

#define RESULT ((volatile uint8_t*)0x0300)

volatile uint8_t wakeups = 0;

ISR(WDT_vect) {
  wakeups++;
}

// Arm the watchdog for interrupt-on-timeout mode with the given WDP prescale
// (0 -> 16 ms). Mirrors LowPower's watchdog setup: the timed WDCE|WDE unlock
// then a single write selecting WDIE and the prescale, which clears WDE so the
// timeout raises an interrupt instead of resetting the chip.
static void watchdogInterrupt(uint8_t wdp) {
  cli();
  wdt_reset();
  WDTCSR = _BV(WDCE) | _BV(WDE);
  WDTCSR = _BV(WDIE) | (wdp & 0x07) | ((wdp & 0x08) ? _BV(WDP3) : 0);
  sei();
}

void setup() {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;
  RESULT[0] = 0xa7; // start marker.
  RESULT[4] = 0x5c; // end marker.
}

void loop() {
  watchdogInterrupt(0); // Start a fresh 16 ms timeout window.

  set_sleep_mode(SLEEP_MODE_PWR_DOWN);
  sleep_enable();
  sleep_cpu(); // MCU halts here until the watchdog interrupt wakes it.
  sleep_disable();

  RESULT[1] = wakeups; // publish the running wake count after each wake.
}
