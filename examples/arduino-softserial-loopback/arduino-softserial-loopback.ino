#include <Arduino.h>
#include <SoftwareSerial.h>

#define SOFT_RX 8
#define SOFT_TX 9
#define RESULT ((volatile uint8_t*)0x0300)

SoftwareSerial softSerial(SOFT_RX, SOFT_TX);

volatile uint8_t rxCount = 0;
volatile uint8_t rxXor = 0;
volatile uint8_t lastRx = 0;

static void publishResult(void) {
  RESULT[0] = 0xa7;
  RESULT[1] = rxCount;
  RESULT[2] = rxXor;
  RESULT[3] = lastRx;
  RESULT[4] = softSerial.available();
  RESULT[5] = 0x5c;
}

void setup() {
  for (uint8_t i = 0; i < 16; i++) RESULT[i] = 0;
  pinMode(SOFT_RX, INPUT_PULLUP);
  pinMode(SOFT_TX, OUTPUT);
  Serial.begin(9600);
  softSerial.begin(9600);
  publishResult();
}

void loop() {
  if (softSerial.available() > 0) {
    const int value = softSerial.read();
    if (value >= 0) {
      const uint8_t byte = (uint8_t)value;
      rxCount++;
      rxXor ^= byte;
      lastRx = byte;
      softSerial.write(byte);
      Serial.write(byte);
      publishResult();
    }
  }

  publishResult();
}
