#include <Arduino.h>
#include <avr/pgmspace.h>

const uint8_t payload[] PROGMEM = {
  0x31, 0x42, 0x53, 0x64, 0x75, 0x86, 0x97, 0xa8,
  0xb9, 0xca, 0xdb, 0xec, 0xfd, 0x0e, 0x1f, 0x20,
};

volatile uint16_t crc16State = 0xffff;
volatile uint8_t crc8State = 0x5a;
volatile uint8_t wireEcho = 0;
volatile uint32_t rounds = 0;

static uint8_t crc8Update(uint8_t crc, uint8_t value) {
  crc ^= value;
  for (uint8_t bit = 0; bit < 8; bit++) {
    crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
  }
  return crc;
}

static uint16_t crc16Update(uint16_t crc, uint8_t value) {
  crc ^= (uint16_t)value << 8;
  for (uint8_t bit = 0; bit < 8; bit++) {
    crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

static uint8_t bitbangTransfer(uint8_t value) {
  uint8_t echo = 0;
  for (uint8_t mask = 0x80; mask != 0; mask >>= 1) {
    if (value & mask) {
      PORTB |= _BV(PORTB3);
    } else {
      PORTB &= (uint8_t)~_BV(PORTB3);
    }

    PORTB |= _BV(PORTB5);
    echo <<= 1;
    if (PINB & _BV(PINB4)) {
      echo |= 1;
    }
    PORTB &= (uint8_t)~_BV(PORTB5);
  }
  return echo;
}

void setup() {
  DDRB |= _BV(DDB3) | _BV(DDB5);
  DDRB &= (uint8_t)~_BV(DDB4);
  PORTB |= _BV(PORTB4);
}

void loop() {
  const uint8_t index = rounds & 15;
  const uint8_t value = pgm_read_byte(&payload[index]) ^ (uint8_t)rounds;
  const uint8_t echoed = bitbangTransfer(value);

  crc8State = crc8Update(crc8State, value ^ echoed);
  crc16State = crc16Update(crc16State, value);
  wireEcho ^= echoed;
  rounds++;
}
