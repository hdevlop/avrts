#include <Arduino.h>
#include <avr/interrupt.h>

// Analog-comparator interrupt validation fixture. Real Arduino sketches that
// watch a threshold crossing (zero-cross detectors, over-current trips) arm the
// on-chip comparator interrupt on a specific output edge. Here ACIS1:0 = 11
// selects the *rising* comparator-output edge (AIN0 crossing above AIN1), so
// only rising transitions count. The ISR tallies edges and samples ACO; the
// result block at SRAM 0x0300 lets a host test read the tally without a UART.

#define RESULT ((volatile uint8_t*)0x0300)

volatile uint8_t risingEdges = 0;
volatile uint8_t acoInIsr = 0;

ISR(ANALOG_COMP_vect) {
  risingEdges++;
  // Hardware clears ACI automatically on vector entry; just sample ACO.
  acoInIsr = (ACSR & _BV(ACO)) ? 1 : 0;
}

static void publishResult(void) {
  RESULT[0] = 0xa7;
  RESULT[1] = risingEdges;
  RESULT[2] = acoInIsr;
  RESULT[3] = (ACSR & _BV(ACO)) ? 1 : 0; // live comparator output.
  RESULT[4] = 0x5c;
}

void setup() {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;

  cli();
  // Interrupt on the rising output edge; leave ACIE and ACI clear for now.
  ACSR = _BV(ACIS1) | _BV(ACIS0);
  // Enable the comparator interrupt (ACI is still clear, so no spurious IRQ).
  ACSR |= _BV(ACIE);
  sei();

  publishResult();
}

void loop() {
  publishResult();
}
