#include <avr/io.h>
#include <avr/interrupt.h>

// Analog-comparator native-oracle fixture. The firmware arms the comparator to
// interrupt on the *rising* output edge (ACIS1:0 = 11) and tallies edges in the
// ANALOG_COMP ISR. An external harness (simavr's ACOMP AIN IRQs, or avrts'
// comparator handle) starts AIN0 below AIN1 (ACO low), then drives AIN0 above
// AIN1 to produce one rising edge. The result block at SRAM 0x0300 completes
// (end marker written) only after the ISR has run, so the oracle can measure the
// firmware-visible edge/ACO result across both engines.
//
// Result block: [0]=start, [1]=edges, [2]=ACO live, [3]=ACO in ISR, [4]=end.

#define RESULT ((volatile uint8_t*)0x0300)
#define RESULT_START 0xa7
#define RESULT_END 0x5c

volatile uint8_t edges = 0;
volatile uint8_t aco_in_isr = 0;

ISR(ANALOG_COMP_vect) {
  edges++;
  // Hardware clears ACI on vector entry; just sample the live ACO level.
  aco_in_isr = (ACSR & _BV(ACO)) ? 1 : 0;
}

int main(void) {
  for (uint8_t i = 0; i < 8; i++) RESULT[i] = 0;

  // Interrupt on the rising comparator-output edge; ACI stays clear so enabling
  // ACIE cannot raise a spurious interrupt.
  ACSR = _BV(ACIS1) | _BV(ACIS0);
  ACSR |= _BV(ACIE);
  sei();

  RESULT[0] = RESULT_START; // ready; end marker is withheld until the edge.

  for (;;) {
    RESULT[1] = edges;
    RESULT[2] = (ACSR & _BV(ACO)) ? 1 : 0;
    RESULT[3] = aco_in_isr;
    if (edges > 0) RESULT[4] = RESULT_END; // complete once the ISR has fired.
    __asm__ __volatile__("nop");
  }
}
