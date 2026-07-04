#include <Arduino.h>

#define RESULT ((volatile uint8_t*)0x0300)

volatile uint8_t rxCount = 0;
volatile uint8_t rxXor = 0;
volatile uint8_t lastRx = 0;

static void publishResult(void) {
  RESULT[0] = 0xa7;
  RESULT[1] = rxCount;
  RESULT[2] = rxXor;
  RESULT[3] = lastRx;
  RESULT[4] = Serial.available();
  RESULT[5] = 0x5c;
}

void setup() {
  for (uint8_t i = 0; i < 16; i++) RESULT[i] = 0;
  Serial.begin(9600);
  publishResult();
}

void loop() {
  while (Serial.available() > 0) {
    const int value = Serial.read();
    if (value < 0) break;

    const uint8_t byte = (uint8_t)value;
    rxCount++;
    rxXor ^= byte;
    lastRx = byte;
    Serial.write(byte);
    publishResult();
  }

  publishResult();
}
