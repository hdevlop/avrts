#include <Arduino.h>
#include <avr/interrupt.h>
#include <util/twi.h>

#define RESULT_ADDR ((volatile uint8_t*)0x0300)
#define MIX_SLAVE_ADDR 0x50

volatile uint16_t timerTicks = 0;
volatile uint8_t timerEdges = 0;

ISR(TIMER1_COMPA_vect) {
  timerTicks++;
  if ((timerTicks & 1) == 0) {
    PIND = _BV(PD7);
    timerEdges++;
  }
}

static uint8_t twiWait() {
  while ((TWCR & _BV(TWINT)) == 0) {
  }
  return TWSR & 0xf8;
}

static uint8_t twiStart() {
  TWCR = _BV(TWINT) | _BV(TWSTA) | _BV(TWEN);
  return twiWait();
}

static uint8_t twiWriteByte(uint8_t value) {
  TWDR = value;
  TWCR = _BV(TWINT) | _BV(TWEN);
  return twiWait();
}

static uint8_t twiReadNack(uint8_t* value) {
  TWCR = _BV(TWINT) | _BV(TWEN);
  const uint8_t status = twiWait();
  *value = TWDR;
  return status;
}

static void twiStop() {
  TWCR = _BV(TWINT) | _BV(TWEN) | _BV(TWSTO);
}

static uint8_t twiExchange(uint8_t round, uint8_t sampleLow, uint8_t tickLow, uint8_t duty) {
  uint8_t response = 0;
  uint8_t status = 0;

  status ^= twiStart();
  status ^= twiWriteByte((MIX_SLAVE_ADDR << 1) | TW_WRITE);
  status ^= twiWriteByte(round);
  status ^= twiWriteByte(sampleLow);
  status ^= twiWriteByte(tickLow);
  status ^= twiWriteByte(duty);
  status ^= twiStart();
  status ^= twiWriteByte((MIX_SLAVE_ADDR << 1) | TW_READ);
  status ^= twiReadNack(&response);
  twiStop();

  return response ^ status;
}

void setup() {
  volatile uint8_t* out = RESULT_ADDR;
  for (uint8_t i = 0; i < 24; i++) {
    out[i] = 0;
  }

  pinMode(2, INPUT);
  pinMode(7, OUTPUT);
  pinMode(3, OUTPUT);
  pinMode(5, OUTPUT);
  analogWrite(3, 64);
  analogWrite(5, 192);

  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1 = 0;
  OCR1A = 63;
  TCCR1B = _BV(WGM12) | _BV(CS11);
  TIMSK1 = _BV(OCIE1A);

  TWSR = 0;
  TWBR = 12;
  TWCR = _BV(TWEN);

  sei();
}

void loop() {
  static uint8_t round = 0;
  static uint16_t adcSum = 0;
  static uint8_t twiMix = 0;
  static uint8_t inputMix = 0;
  static uint8_t pwmMix = 0;

  if (round >= 12) {
    cli();
    TIMSK1 = 0;
    const uint16_t ticks = timerTicks;
    volatile uint8_t* out = RESULT_ADDR;
    out[0] = 0xa7;
    out[1] = round;
    out[2] = adcSum & 0xff;
    out[3] = adcSum >> 8;
    out[4] = ticks & 0xff;
    out[5] = ticks >> 8;
    out[6] = timerEdges;
    out[7] = twiMix;
    out[8] = inputMix;
    out[9] = pwmMix;
    out[10] = OCR2B;
    out[11] = OCR0B;
    out[12] = PORTD;
    out[13] = TCCR2A;
    out[14] = TCCR0A;
    out[15] = TWDR;
    out[16] = TWSR & 0xf8;
    out[17] = ADCL;
    out[18] = ADCH;
    out[19] = PIND;
    out[20] = 0x5c;
    while (1) {
    }
  }

  const uint16_t sample = analogRead(A0);
  const uint16_t ticks = timerTicks;
  const uint8_t duty = (uint8_t)(sample + (round * 13) + (ticks & 0xff));

  adcSum += sample;
  analogWrite(3, duty);
  analogWrite(5, 255 - duty);
  inputMix = (uint8_t)((inputMix << 1) ^ (digitalRead(2) ? 0x5a : 0xa5) ^ round);
  pwmMix ^= (uint8_t)(OCR2B + OCR0B + TCCR2A + TCCR0A);
  twiMix ^= twiExchange(round, sample & 0xff, ticks & 0xff, duty);
  round++;

  delayMicroseconds(50);
}
