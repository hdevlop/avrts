#include <Arduino.h>
#include <math.h>

volatile float seed = 0.125f;
volatile float result = 0.0f;
volatile uint32_t iterations = 0;

void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  const float phase = seed + (float)(iterations & 31) * 0.03125f;
  const float wave = sinf(phase) + cosf(phase * 0.5f);
  const float root = sqrtf(fabsf(wave) + 0.25f);
  const float mixed = (wave * root) / (1.0f + (float)((iterations & 7) + 1));

  result += mixed;
  seed = mixed + result * 0.0001f;

  if ((iterations & 15) == 0) {
    digitalWrite(13, result > 0.0f ? HIGH : LOW);
  }

  iterations++;
}
