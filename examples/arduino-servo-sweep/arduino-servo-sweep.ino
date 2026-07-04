#include <Arduino.h>
#include <Servo.h>

// Arduino Servo library validation fixture. The Servo library drives a hobby
// servo by generating a ~1-2 ms pulse every 20 ms on the attached pin, timed by
// Timer1 compare-match interrupts that toggle the pin in software (not hardware
// PWM). Here the servo is parked at an exact 1500 us pulse so a host test can
// measure the pin-9 high time and refresh period, exercising Timer1 CTC + GPIO
// end to end through the real Servo library. The commanded width is echoed to
// the result block at SRAM 0x0300 for reference.

#define RESULT ((volatile uint8_t*)0x0300)

Servo servo;

void setup() {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;

  servo.attach(9);
  servo.writeMicroseconds(1500); // neutral position: exact 1500 us pulse.

  RESULT[0] = 0xa7;
  RESULT[1] = 1500 & 0xff;
  RESULT[2] = (1500 >> 8) & 0xff;
  RESULT[3] = 0x5c;
}

void loop() {
}
