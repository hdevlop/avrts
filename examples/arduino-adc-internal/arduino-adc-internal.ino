#include <Arduino.h>

// Internal-ADC-channel validation fixture, the raw-register form of
// `analogRead(TEMPERATURE)`. Firmware that reads the on-chip temperature sensor
// or the 1.1 V bandgap reference does it by hand through ADMUX/ADCSRA rather
// than the Arduino pin-mapped analogRead(). This sketch samples the temperature
// sensor (MUX = 1000, internal 1.1 V reference) and the bandgap channel
// (MUX = 1110, AVcc reference), publishing both 10-bit results to SRAM 0x0300.

#define RESULT ((volatile uint8_t*)0x0300)

static uint16_t readAdc(uint8_t admux) {
  ADMUX = admux;
  // Start a single conversion and busy-wait for it to finish.
  ADCSRA = _BV(ADEN) | _BV(ADSC);
  while (ADCSRA & _BV(ADSC)) {
  }
  uint8_t low = ADCL;  // read ADCL first to latch the pair.
  uint8_t high = ADCH;
  return (uint16_t)low | ((uint16_t)high << 8);
}

void setup() {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;

  // Temperature sensor: internal 1.1 V reference (REFS1:0 = 11), MUX = 1000.
  uint16_t temperature = readAdc(_BV(REFS1) | _BV(REFS0) | 0x08);
  // Bandgap reference read against AVcc (REFS0), MUX = 1110.
  uint16_t bandgap = readAdc(_BV(REFS0) | 0x0e);

  RESULT[0] = 0xa7;
  RESULT[1] = temperature & 0xff;
  RESULT[2] = (temperature >> 8) & 0xff;
  RESULT[3] = bandgap & 0xff;
  RESULT[4] = (bandgap >> 8) & 0xff;
  RESULT[5] = 0x5c;
}

void loop() {
}
