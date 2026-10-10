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
uint8_t completedSamples = 0;

#define MODE_ADDR ((volatile uint8_t*)0x02ff)
#define START_ADDR ((volatile uint8_t*)0x02fc)
#define RESULT_ADDR ((volatile uint8_t*)0x0300)

void setup() {
  if (*MODE_ADDR == 0x42) {
    sampleIndex = START_ADDR[0] | ((uint16_t)START_ADDR[1] << 8);
  }
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
  if (*MODE_ADDR == 0x42 && ++completedSamples == 144) {
    // Publish completion only after the last UART frame has left the transmitter.
    Serial.flush();
    noInterrupts();
    volatile uint8_t* out = RESULT_ADDR;
    out[0] = 0xa7;
    out[1] = (uint8_t)sampleIndex;
    out[2] = (uint8_t)(sampleIndex >> 8);
    for (uint8_t i = 0; i < 4; i++) out[3 + i] = (uint8_t)(accumulator >> (8 * i));
    out[7] = duty;
    out[8] = (uint8_t)raw;
    out[9] = (uint8_t)(raw >> 8);
    out[10] = (uint8_t)scaled;
    out[11] = (uint8_t)((uint16_t)scaled >> 8);
    out[12] = OCR2B;
    out[13] = (uint8_t)OCR1A;
    out[14] = (uint8_t)(OCR1A >> 8);
    out[15] = TCCR2A;
    out[16] = TCCR1A;
    out[17] = UCSR0B;
    out[18] = UCSR0A & _BV(TXC0);
    out[19] = 0x53;
    for (uint8_t i = 0; i < 16; i++) {
      out[20 + i * 2] = (uint8_t)history[i];
      out[21 + i * 2] = (uint8_t)(history[i] >> 8);
    }
    // Stop PWM and leave both output latches low for a stable final summary.
    TCCR1A = 0;
    TCCR1B = 0;
    TCCR2A = 0;
    TCCR2B = 0;
    PORTB &= (uint8_t)~_BV(PORTB1);
    PORTD &= (uint8_t)~_BV(PORTD3);
    out[52] = 0x5c;
    while (1) {}
  }
}
