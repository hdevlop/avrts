#include <avr/io.h>

#define RESULT ((volatile uint8_t*)0x0300)
#define RESULT_START 0xa7
#define RESULT_END 0x5c
#define SPI_SLAVE_READY 0x51
#define SPI_SLAVE_MARKER_OFFSET 14

static void store16(uint8_t offset, uint16_t value) {
  RESULT[offset] = (uint8_t)value;
  RESULT[offset + 1] = (uint8_t)(value >> 8);
}

static void timer_start(void) {
  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1 = 0;
  TCCR1B = _BV(CS10);
}

static uint16_t timer_stop(void) {
  uint16_t value = TCNT1;
  TCCR1B = 0;
  return value;
}

int main(void) {
  for (uint8_t i = 0; i < 16; i++) RESULT[i] = 0;
  RESULT[0] = RESULT_START;

  DDRB &= (uint8_t)~_BV(DDB2);
  PORTB &= (uint8_t)~_BV(PORTB2);
  SPCR = _BV(SPE);
  SPSR = 0;
  SPDR = 0xa5;

  timer_start();
  RESULT[SPI_SLAVE_MARKER_OFFSET] = SPI_SLAVE_READY;
  while ((SPSR & _BV(SPIF)) == 0) {
  }
  const uint16_t elapsed = timer_stop();
  const uint8_t status = SPSR;
  const uint8_t received = SPDR;
  const uint8_t status_after_read = SPSR;

  store16(1, elapsed);
  RESULT[3] = received;
  RESULT[4] = status;
  RESULT[5] = status_after_read;
  RESULT[6] = SPCR;
  RESULT[7] = SPDR;
  RESULT[15] = RESULT_END;

  for (;;) {
  }
}
