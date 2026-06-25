#include <Arduino.h>
#include <avr/interrupt.h>

#define MODE_ADDR ((volatile uint8_t*)0x02ff)
#define RESULT_ADDR ((volatile uint8_t*)0x0300)
#define RESULT_HALT_MODE 0x42

volatile uint16_t timerTicks = 0;
volatile uint8_t isrFlags = 0;
volatile uint8_t softPwmPhase = 0;
volatile uint8_t softPwmDuty = 5;

ISR(TIMER1_COMPA_vect) {
  timerTicks++;
  isrFlags |= 0x01;
  if (timerTicks >= 8) {
    isrFlags |= 0x02;
  }

  softPwmPhase = (uint8_t)((softPwmPhase + 1) & 0x0f);
  if (softPwmPhase < softPwmDuty) {
    PORTB |= _BV(PB5);
  } else {
    PORTB &= (uint8_t)~_BV(PB5);
  }

  if (softPwmPhase == 0) {
    isrFlags |= 0x04;
  }
  if ((PIND & _BV(PD2)) != 0) {
    isrFlags |= 0x08;
  }
}

void setup() {
  volatile uint8_t* out = RESULT_ADDR;
  for (uint8_t i = 0; i < 24; i++) {
    out[i] = 0;
  }

  pinMode(2, INPUT);
  pinMode(3, OUTPUT);
  pinMode(5, OUTPUT);
  pinMode(13, OUTPUT);
  analogWrite(3, 32);
  analogWrite(5, 224);

  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1 = 0;
  OCR1A = 47;
  TCCR1B = _BV(WGM12) | _BV(CS11);
  TIMSK1 = _BV(OCIE1A);

  sei();
}

void loop() {
  static uint8_t round = 0;
  static uint8_t resultWritten = 0;
  static uint16_t adcSum = 0;
  static uint8_t inputMix = 0;
  static uint8_t pwmMix = 0;

  if (round >= 16 && resultWritten == 0) {
    cli();
    const uint16_t ticks = timerTicks;
    PORTB = (PORTB & (uint8_t)~_BV(PB5)) | _BV(PB4);

    volatile uint8_t* out = RESULT_ADDR;
    out[0] = 0xa7;
    out[1] = round;
    out[2] = adcSum & 0xff;
    out[3] = adcSum >> 8;
    out[4] = ticks > 0 ? 1 : 0;
    out[5] = ticks >= 16 ? 1 : 0;
    out[6] = ticks <= 400 ? 1 : 0;
    out[7] = isrFlags;
    out[8] = inputMix;
    out[9] = pwmMix;
    out[10] = softPwmDuty;
    out[11] = OCR2B;
    out[12] = OCR0B;
    out[13] = PORTB;
    out[14] = TCCR2A;
    out[15] = TCCR0A;
    out[16] = TIMSK1;
    out[17] = ADCL;
    out[18] = ADCH;
    out[19] = digitalRead(2) ? 1 : 0;
    out[20] = 0x5c;
    resultWritten = 1;
    if (*MODE_ADDR == RESULT_HALT_MODE) {
      while (1) {
      }
    }
    sei();
  }

  const uint16_t sample = analogRead(A0);
  const uint8_t duty = (uint8_t)(sample + round * 17);

  adcSum += sample;
  softPwmDuty = (uint8_t)(((sample >> 6) + round) & 0x0f);
  analogWrite(3, duty);
  analogWrite(5, 255 - duty);
  inputMix = (uint8_t)((inputMix << 1) ^ (digitalRead(2) ? 0x3c : 0xc3) ^ round);
  pwmMix ^= (uint8_t)(OCR2B + OCR0B + TCCR2A + TCCR0A + softPwmDuty);
  round++;

  delayMicroseconds(40);
}
