#include <Arduino.h>
#include <math.h>

volatile float seed = 0.125f;
volatile float result = 0.0f;
volatile uint32_t iterations = 0;

#define MODE_ADDR ((volatile uint8_t*)0x02ff)
#define RESULT_ADDR ((volatile uint8_t*)0x0300)

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

  if (iterations == 32 && *MODE_ADDR == 0x42) {
    noInterrupts();
    volatile uint8_t* out = RESULT_ADDR;
    out[0] = 0xa7;
    out[1] = 32;
    const volatile uint8_t* resultBytes = (const volatile uint8_t*)&result;
    const volatile uint8_t* seedBytes = (const volatile uint8_t*)&seed;
    for (uint8_t i = 0; i < 4; i++) {
      out[2 + i] = resultBytes[i];
      out[6 + i] = seedBytes[i];
      out[10 + i] = (uint8_t)(iterations >> (8 * i));
    }
    out[14] = PORTB;
    out[15] = DDRB;
    out[16] = result > 0.0f;
    out[17] = seed > 0.0f;
    out[18] = 0;
    out[19] = 0xf1;
    out[20] = 0x5c;
    while (1) {}
  }
}
