#include <Arduino.h>
#include <avr/pgmspace.h>

#define MODE_ADDR ((volatile uint8_t*)0x02ff)
#define RESULT_ADDR ((volatile uint8_t*)0x0300)
#define RESULT_HALT_MODE 0x42
#define TAP_COUNT 16

const int16_t kCoeffs[TAP_COUNT] PROGMEM = {
  3, -7, 12, -18, 25, -31, 42, -55,
  55, -42, 31, -25, 18, -12, 7, -3,
};

const uint8_t kWave[32] PROGMEM = {
  128, 152, 176, 198, 218, 234, 246, 253,
  255, 253, 246, 234, 218, 198, 176, 152,
  128, 104, 80, 58, 38, 22, 10, 3,
  0, 3, 10, 22, 38, 58, 80, 104,
};

int16_t samples[TAP_COUNT];
int16_t scratch[8];

static uint8_t mix32(uint32_t value, uint8_t seed) {
  seed ^= (uint8_t)value;
  seed ^= (uint8_t)(value >> 8);
  seed ^= (uint8_t)(value >> 16);
  seed ^= (uint8_t)(value >> 24);
  return (uint8_t)((seed << 1) | (seed >> 7));
}

void setup() {
  volatile uint8_t* out = RESULT_ADDR;
  for (uint8_t i = 0; i < 24; i++) {
    out[i] = 0;
  }

  pinMode(2, INPUT);
  pinMode(3, OUTPUT);
  for (uint8_t i = 0; i < TAP_COUNT; i++) {
    samples[i] = (int16_t)pgm_read_byte(&kWave[i]) - 128;
  }
  for (uint8_t i = 0; i < 8; i++) {
    scratch[i] = 0;
  }
}

void loop() {
  static uint8_t round = 0;
  static uint8_t resultWritten = 0;
  static uint16_t adcSum = 0;
  static int32_t accMix = 0;
  static uint8_t hash = 0xa5;
  static uint8_t index = 0;

  const uint16_t raw = analogRead(A0);
  const int16_t centered = (int16_t)raw - 512 + (digitalRead(2) ? 17 : -17);
  samples[index] = centered;

  int32_t acc = 0;
  uint8_t sampleIndex = index;
  for (uint8_t tap = 0; tap < TAP_COUNT; tap++) {
    const int16_t coeff = pgm_read_word(&kCoeffs[tap]);
    acc += (int32_t)samples[sampleIndex] * coeff;
    sampleIndex = (uint8_t)((sampleIndex + TAP_COUNT - 1) & (TAP_COUNT - 1));
  }

  const int16_t filtered = (int16_t)(acc >> 5);
  scratch[round & 7] = filtered;
  scratch[(round + 3) & 7] = (int16_t)(scratch[(round + 3) & 7] + (filtered >> 3));

  int32_t energy = 0;
  for (uint8_t i = 0; i < 8; i++) {
    energy += (int32_t)scratch[i] * scratch[i];
  }

  analogWrite(3, (uint8_t)(filtered >> 3));
  adcSum += raw;
  accMix += acc ^ energy;
  hash = mix32((uint32_t)acc, hash);
  hash = mix32((uint32_t)energy, hash);
  hash ^= pgm_read_byte(&kWave[(round + index) & 31]);

  index = (uint8_t)((index + 1) & (TAP_COUNT - 1));
  round++;

  if (round >= 24 && resultWritten == 0) {
    volatile uint8_t* out = RESULT_ADDR;
    out[0] = 0xa7;
    out[1] = round;
    out[2] = adcSum & 0xff;
    out[3] = adcSum >> 8;
    out[4] = hash;
    out[5] = accMix & 0xff;
    out[6] = (accMix >> 8) & 0xff;
    out[7] = (accMix >> 16) & 0xff;
    out[8] = (accMix >> 24) & 0xff;
    out[9] = (uint8_t)filtered;
    out[10] = (uint8_t)(filtered >> 8);
    out[11] = (uint8_t)energy;
    out[12] = (uint8_t)(energy >> 8);
    out[13] = OCR2B;
    out[14] = TCCR2A;
    out[15] = ADCL;
    out[16] = ADCH;
    out[17] = PORTD;
    out[18] = digitalRead(2) ? 1 : 0;
    out[19] = index;
    out[20] = 0x5c;
    resultWritten = 1;
    if (*MODE_ADDR == RESULT_HALT_MODE) {
      while (1) {
      }
    }
  }
}
