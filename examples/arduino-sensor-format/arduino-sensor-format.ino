#include <Arduino.h>
#include <avr/pgmspace.h>

const uint16_t calibration[] PROGMEM = {
  12, 48, 103, 161, 220, 276, 331, 387,
  444, 503, 559, 612, 668, 721, 777, 831,
  884, 932, 978, 1007, 991, 941, 887, 832,
  776, 714, 655, 594, 531, 462, 391, 255,
};

uint16_t sampleIndex = 0;
uint16_t history[16];
uint32_t accumulator = 0;

void setup() {
  Serial.begin(9600);
  pinMode(3, OUTPUT);
  pinMode(9, OUTPUT);
}

void loop() {
  const uint8_t slot = sampleIndex & 31;
  uint16_t raw = pgm_read_word(&calibration[slot]);
  raw = (raw + ((sampleIndex * 37u) & 0x03ffu)) & 0x03ffu;

  const long scaled = map(raw, 0, 1023, -200, 850);
  accumulator += (uint32_t)(scaled + 200) * ((sampleIndex & 7) + 1);
  history[sampleIndex & 15] = (uint16_t)scaled;

  const uint8_t duty = (uint8_t)((accumulator >> 5) ^ (uint16_t)scaled);
  analogWrite(3, duty);
  analogWrite(9, 255 - duty);

  if ((sampleIndex & 0x7f) == 0) {
    Serial.print(F("sample="));
    Serial.print(sampleIndex);
    Serial.print(F(",raw="));
    Serial.print(raw);
    Serial.print(F(",scaled="));
    Serial.println(scaled);
  }

  sampleIndex++;
}
