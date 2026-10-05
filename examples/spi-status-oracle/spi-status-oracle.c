#include <avr/io.h>

#define RESULT ((volatile uint8_t*)0x0300)

// Wait without reading SPSR, so completion does not arm flag acknowledgement.
static void wait_byte(void) {
  __asm__ __volatile__(".rept 96\n\tnop\n\t.endr\n\t");
}

int main(void) {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;
  RESULT[0] = 0xa7;
  DDRB = _BV(DDB2);
  SPCR = _BV(SPE) | _BV(MSTR);
  SPSR = 0;

  SPDR = 0x11;
  wait_byte();
  (void)SPDR; // No prior status read: completion must remain latched.
  SPDR = 0x22;
  RESULT[1] = SPSR; // Starting a byte must preserve unread SPIF.
  (void)SPDR; // Complete the status/data acknowledgement sequence.
  wait_byte();
  (void)SPDR;
  RESULT[2] = SPSR; // The unarmed data read preserved this completion.

  SPDR = 0x33; // Acknowledge SPIF and start a byte.
  SPDR = 0x44; // Write collision.
  RESULT[3] = SPSR; // WCOL-only read arms WCOL and SPIF.
  wait_byte();
  (void)SPDR;
  RESULT[4] = SPSR;

  SPDR = 0x55;
  SPDR = 0x66;
  wait_byte();
  SPDR = 0x77; // No status read: preserve both flags when starting the next byte.
  RESULT[5] = SPSR;
  (void)SPDR;
  RESULT[6] = SPSR;
  RESULT[7] = 0x5c;
  for (;;) {}
}
