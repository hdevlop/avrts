#include <avr/io.h>
#include <avr/boot.h>
#include <avr/interrupt.h>

// A sparse reset entry reaches code in the smallest supported boot section.
__asm__(".section .text\n.global __vectors\n__vectors: jmp main\n.previous");

__attribute__((section(".bootloader"))) int main(void) {
  cli();
  volatile uint8_t *out = (volatile uint8_t *)0x300;
  TCCR1B = _BV(CS11); // Eight CPU clocks per tick; durations fit in 16 bits.
  EEAR = 7;
  EEDR = 0x5a;
  uint16_t before = TCNT1;
  EECR = _BV(EEMPE);
  EECR = _BV(EEPE);
  out[1] = EECR & _BV(EEPE);
  while (EECR & _BV(EEPE)) {}
  uint16_t elapsed = TCNT1 - before;
  out[2] = elapsed; out[3] = elapsed >> 8;
  EECR = _BV(EERE);
  out[4] = EEDR;

  before = TCNT1;
  boot_page_erase(0x200);
  out[5] = SPMCSR & _BV(SPMEN);
  boot_spm_busy_wait();
  elapsed = TCNT1 - before;
  out[6] = elapsed; out[7] = elapsed >> 8;
  boot_rww_enable();
  boot_page_fill(0x200, 0x5aa5);
  boot_page_write(0x200);
  out[8] = SPMCSR & _BV(SPMEN);
  boot_spm_busy_wait();
  boot_rww_enable();
  uint16_t word;
  __asm__ volatile("lpm %A0,Z+\n\tlpm %B0,Z" : "=&r"(word) : "z"((uint16_t)0x200));
  out[9] = word; out[10] = word >> 8;
  out[0] = 0xa7;
  for (uint8_t i = 11; i < 19; i++) out[i] = 0;
  out[19] = 0x60;
  out[20] = 0x5c;
  while (1) {}
}
