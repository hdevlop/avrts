#include <avr/io.h>
#include <util/twi.h>

#define RESULT ((volatile uint8_t*)0x0300)
#define RESULT_START 0xa7
#define RESULT_END 0x5c
#define TWI_SLAVE_ADDR 0x50

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

static uint16_t measure_usart_txc(void) {
  UBRR0H = 0;
  UBRR0L = 0;
  UCSR0A = _BV(TXC0);
  UCSR0B = _BV(TXEN0);
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00);

  timer_start();
  UDR0 = 0x55;
  while ((UCSR0A & _BV(TXC0)) == 0) {
  }
  return timer_stop();
}

static uint16_t measure_spi_spif(uint8_t* received, uint8_t* status) {
  SPCR = _BV(SPE) | _BV(MSTR);
  SPSR = 0;

  timer_start();
  SPDR = 0x3c;
  while ((SPSR & _BV(SPIF)) == 0) {
  }
  const uint16_t elapsed = timer_stop();
  *received = SPDR;
  *status = SPSR;
  return elapsed;
}

static uint8_t twi_wait(void) {
  while ((TWCR & _BV(TWINT)) == 0) {
  }
  return TWSR & 0xf8;
}

static uint16_t measure_twi_command(uint8_t command, uint8_t* status) {
  timer_start();
  TWCR = _BV(TWINT) | _BV(TWEN) | command;
  *status = twi_wait();
  return timer_stop();
}

static uint16_t measure_twi_stop(uint8_t* control) {
  timer_start();
  TWCR = _BV(TWINT) | _BV(TWEN) | _BV(TWSTO);
  while ((TWCR & _BV(TWSTO)) != 0) {
  }
  const uint16_t elapsed = timer_stop();
  *control = TWCR;
  return elapsed;
}

int main(void) {
  for (uint8_t i = 0; i < 32; i++) RESULT[i] = 0;
  RESULT[0] = RESULT_START;

  store16(1, measure_usart_txc());

  uint8_t spi_received = 0;
  uint8_t spi_status = 0;
  store16(3, measure_spi_spif(&spi_received, &spi_status));
  RESULT[5] = spi_received;
  RESULT[6] = spi_status;

  TWSR = 0;
  TWBR = 0;
  TWCR = _BV(TWEN);

  uint8_t status = 0;
  store16(7, measure_twi_command(_BV(TWSTA), &status));
  RESULT[9] = status;

  TWDR = (TWI_SLAVE_ADDR << 1) | TW_WRITE;
  store16(10, measure_twi_command(0, &status));
  RESULT[12] = status;

  TWDR = 0xab;
  store16(13, measure_twi_command(0, &status));
  RESULT[15] = status;

  store16(16, measure_twi_command(_BV(TWSTA), &status));
  RESULT[18] = status;

  TWDR = (TWI_SLAVE_ADDR << 1) | TW_READ;
  store16(19, measure_twi_command(0, &status));
  RESULT[21] = status;

  store16(22, measure_twi_command(0, &status));
  RESULT[24] = status;
  RESULT[25] = TWDR;

  uint8_t twcr_after_stop = 0;
  store16(26, measure_twi_stop(&twcr_after_stop));
  RESULT[28] = twcr_after_stop;
  RESULT[29] = RESULT_END;

  for (;;) {
  }
}
