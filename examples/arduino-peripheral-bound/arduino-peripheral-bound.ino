#include <Arduino.h>
#include <avr/interrupt.h>
#include <avr/sleep.h>

#define MODE_ADDR ((volatile uint8_t*)0x02ff)
#define RESULT_ADDR ((volatile uint8_t*)0x0300)
#define BATCHES_ADDR ((volatile uint16_t*)0x0315)
#define RESULT_HALT_MODE 0x42

volatile uint16_t txSent = 0;
volatile uint16_t txSum = 0;
volatile uint8_t txDone = 0;
volatile uint8_t adcCount = 0;
volatile uint16_t adcSum = 0;
volatile uint16_t adcLast = 0;

ISR(USART_UDRE_vect) {
  const uint8_t byte = (uint8_t)txSent;
  UDR0 = byte;
  txSum += byte;
  if (++txSent == 512) {
    UCSR0B = _BV(TXEN0) | _BV(TXCIE0);
  }
}

ISR(USART_TX_vect) {
  txDone = 1;
  UCSR0B = _BV(TXEN0);
}

ISR(ADC_vect) {
  const uint16_t sample = ADC;
  adcLast = sample;
  adcSum += sample;
  ++adcCount;
  const uint8_t duty = (uint8_t)((sample >> 2) ^ adcCount);
  OCR1A = duty;
  OCR1B = 255 - duty;
  if (adcCount < 32) {
    ADCSRA |= _BV(ADSC);
  } else {
    // Idle entry can start an enabled ADC again. Disable it after the batch
    // so USART wake-ups do not add unrequested conversions while draining TX.
    ADCSRA = _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0);
  }
}

void startBatch() {
  // Called with interrupts disabled; both engines/oracles provide ADC0 input.
  txSent = 1;
  txSum = 0;
  txDone = 0;
  adcCount = 0;
  adcSum = 0;
  adcLast = 0;
  UCSR0A = _BV(TXC0);
  UCSR0B = _BV(TXEN0);
  UDR0 = 0; // Prime the first byte; subsequent bytes are interrupt-driven.
  UCSR0B = _BV(TXEN0) | _BV(UDRIE0);
  ADCSRA = _BV(ADEN) | _BV(ADIE) | _BV(ADSC)
    | _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0);
}

void setup() {
  cli();
  for (uint8_t i = 0; i < 21; ++i) RESULT_ADDR[i] = 0;
  *BATCHES_ADDR = 0;

  // Disable Arduino's millisecond interrupt so this fixture isolates its load.
  TIMSK0 = 0;
  TCCR0B = 0;
  TCCR2B = 0;
  DDRB = _BV(PB1) | _BV(PB2);
  PORTB = 0;
  DDRD = _BV(PD1);
  PORTD = 0;
  TCCR1A = _BV(COM1A1) | _BV(COM1B1) | _BV(WGM10);
  TCCR1B = _BV(WGM12) | _BV(CS10); // 8-bit fast PWM, 62.5 kHz on D9/D10.
  TCNT1 = 0;
  OCR1A = 64;
  OCR1B = 191;
  UBRR0 = 0; // 16 MHz / (16 * (0 + 1)) = 1 Mbaud, normal async mode.
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00); // 8N1.
  ADMUX = _BV(REFS0); // ADC0, AVcc reference.
  ADCSRB = 0;
  DIDR0 = _BV(ADC0D);
  set_sleep_mode(SLEEP_MODE_IDLE);
  startBatch();
  sei();
}

void loop() {
  cli();
  if (!txDone || adcCount != 32) {
    // SEI's following instruction executes before a pending ISR, avoiding a
    // lost wake when the final USART/ADC interrupt arrives at this boundary.
    sleep_enable();
    sei();
    sleep_cpu();
    sleep_disable();
    return;
  }

  ++*BATCHES_ADDR;
  if (*MODE_ADDR == RESULT_HALT_MODE) {
    // Stop PWM and make output latches deterministic for the final-state oracle.
    TCCR1B = 0;
    TCCR1A = _BV(WGM10);
    PORTB = 0;
    volatile uint8_t* out = RESULT_ADDR;
    out[0] = 0xa7;
    out[1] = adcCount;
    out[2] = adcSum & 0xff;
    out[3] = adcSum >> 8;
    out[4] = txSent & 0xff;
    out[5] = txSent >> 8;
    out[6] = txDone;
    out[7] = txSum & 0xff;
    out[8] = txSum >> 8;
    out[9] = adcLast & 0xff;
    out[10] = adcLast >> 8;
    out[11] = OCR1AL;
    out[12] = OCR1BL;
    out[13] = TCCR1A;
    out[14] = TCCR1B;
    out[15] = UCSR0B;
    out[16] = ADCSRA;
    out[17] = ADCL;
    out[18] = ADCH;
    out[19] = (PIND & _BV(PD2)) ? 1 : 0;
    out[20] = 0x5c;
    while (1) {}
  }

  startBatch();
  sei();
}
