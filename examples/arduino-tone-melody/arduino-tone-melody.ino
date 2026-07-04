#include <Arduino.h>

// Arduino tone() validation fixture. tone(pin, frequency) drives a square wave
// by toggling the pin from a Timer2 CTC compare-match interrupt (for a non-timer
// pin like 8, the toggle happens in software each half-period). Here a steady
// 1000 Hz tone is emitted on pin 8 so a host test can measure the pin-8 edge
// interval (500 us half-period at 16 MHz) and recover the frequency, exercising
// Timer2 CTC + GPIO end to end through the core's tone() implementation. The
// commanded frequency is echoed to the result block at SRAM 0x0300.

#define RESULT ((volatile uint8_t*)0x0300)
#define TONE_PIN 8
#define TONE_HZ 1000

void setup() {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;

  pinMode(TONE_PIN, OUTPUT);
  tone(TONE_PIN, TONE_HZ); // continuous 1 kHz square wave on pin 8.

  RESULT[0] = 0xa7;
  RESULT[1] = TONE_HZ & 0xff;
  RESULT[2] = (TONE_HZ >> 8) & 0xff;
  RESULT[3] = 0x5c;
}

void loop() {
}
