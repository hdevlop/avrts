#include <Arduino.h>
#include <Wire.h>

#define RESULT ((volatile uint8_t*)0x0300)
#define SLAVE_ADDR 0x42

volatile uint8_t receiveCount = 0;
volatile uint8_t requestCount = 0;
volatile uint8_t rxBytes = 0;
volatile uint8_t rxXor = 0;
volatile uint8_t lastRx = 0;
volatile uint8_t txLast = 0;

static void publishResult(void) {
  RESULT[0] = 0xa7;
  RESULT[1] = receiveCount;
  RESULT[2] = requestCount;
  RESULT[3] = rxBytes;
  RESULT[4] = rxXor;
  RESULT[5] = lastRx;
  RESULT[6] = txLast;
  RESULT[7] = 0x5c;
}

void onReceiveBytes(int count) {
  receiveCount++;
  while (Wire.available()) {
    const uint8_t value = Wire.read();
    rxBytes++;
    rxXor ^= value;
    lastRx = value;
  }
  RESULT[8] = count;
  publishResult();
}

void onRequestBytes() {
  requestCount++;
  txLast = (uint8_t)(0x90 ^ rxXor ^ requestCount);
  Wire.write(txLast);
  publishResult();
}

void setup() {
  for (uint8_t i = 0; i < 16; i++) RESULT[i] = 0;
  Wire.begin(SLAVE_ADDR);
  Wire.onReceive(onReceiveBytes);
  Wire.onRequest(onRequestBytes);
  publishResult();
}

void loop() {
  publishResult();
}
