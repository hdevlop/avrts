#include <avr/io.h>

#define RESULT ((volatile uint8_t*)0x0300)
#define RESULT_START 0xa7
#define RESULT_END 0x5c

static void wait_timer1_overflows(uint8_t count) {
  for (uint8_t i = 0; i < count; i++) {
    while ((TIFR1 & _BV(TOV1)) == 0) {
    }
    TIFR1 = _BV(TOV1);
  }
}

int main(void) {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;
  RESULT[0] = RESULT_START;

  ASSR = _BV(AS2);
  TCNT2 = 0;
  OCR2A = 0xfe;
  OCR2B = 0xfd;
  TCCR2A = 0;
  TIFR2 = _BV(OCF2A) | _BV(OCF2B) | _BV(TOV2);
  TCCR2B = _BV(CS20);

  TCCR1A = 0;
  TCNT1 = 0;
  TIFR1 = _BV(TOV1);
  TCCR1B = _BV(CS10);

  wait_timer1_overflows(1);
  RESULT[1] = TCNT2;
  RESULT[2] = TIFR2;
  RESULT[3] = ASSR;

  wait_timer1_overflows(29);
  RESULT[4] = TCNT2;
  RESULT[5] = TIFR2;
  RESULT[6] = ASSR;
  RESULT[7] = RESULT_END;

  for (;;) {
    __asm__ __volatile__("nop");
  }
}
