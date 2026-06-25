#include <Arduino.h>
#include <stdio.h>

#define MODE_ADDR ((volatile uint8_t*)0x02ff)
#define RESULT_ADDR ((volatile uint8_t*)0x0300)
#define RESULT_HALT_MODE 0x42

static uint8_t hashBytes(const char* text) {
  uint8_t hash = 0x5a;
  while (*text != 0) {
    hash = (uint8_t)((hash << 3) ^ (hash >> 2) ^ (uint8_t)*text++);
  }
  return hash;
}

void setup() {
  volatile uint8_t* out = RESULT_ADDR;
  for (uint8_t i = 0; i < 24; i++) {
    out[i] = 0;
  }

  pinMode(2, INPUT);
  Serial.begin(115200);
}

void loop() {
  static uint8_t round = 0;
  static uint8_t resultWritten = 0;
  static uint16_t adcSum = 0;
  static uint8_t textHash = 0;
  static uint8_t parseMix = 0;
  static uint8_t lengthMix = 0;

  const uint16_t sample = analogRead(A0);
  const uint8_t input = digitalRead(2) ? 1 : 0;
  char buffer[32];

  String label = String(F("S")) + round + (input ? F(":HI:") : F(":LO:"));
  label += String(sample);
  label.replace(":", "-");
  String tail = label.substring(label.length() > 6 ? label.length() - 6 : 0);
  snprintf(buffer, sizeof(buffer), "r%02u/%04u/%s", round, sample, input ? "up" : "dn");

  textHash ^= hashBytes(label.c_str());
  textHash ^= hashBytes(tail.c_str());
  textHash ^= hashBytes(buffer);
  parseMix ^= (uint8_t)(String(sample).toInt() + label.length() + tail.length());
  lengthMix += (uint8_t)(label.length() ^ strlen(buffer));
  adcSum += sample;

  Serial.print(F("msg "));
  Serial.print(round);
  Serial.print(' ');
  Serial.print(label);
  Serial.print(' ');
  Serial.println(buffer);

  round++;

  if (round >= 8 && resultWritten == 0) {
    volatile uint8_t* out = RESULT_ADDR;
    out[0] = 0xa7;
    out[1] = round;
    out[2] = adcSum & 0xff;
    out[3] = adcSum >> 8;
    out[4] = textHash;
    out[5] = parseMix;
    out[6] = lengthMix;
    out[7] = input;
    out[8] = label.length();
    out[9] = tail.length();
    out[10] = strlen(buffer);
    out[11] = buffer[0];
    out[12] = buffer[1];
    out[13] = Serial ? 1 : 0;
    out[14] = ADCL;
    out[15] = ADCH;
    out[16] = PORTD;
    out[17] = PIND;
    out[18] = DDRD;
    out[19] = digitalRead(2) ? 1 : 0;
    out[20] = 0x5c;
    resultWritten = 1;
    if (*MODE_ADDR == RESULT_HALT_MODE) {
      while (1) {
      }
    }
  }

  delayMicroseconds(30);
}
