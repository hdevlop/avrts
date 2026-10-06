# Peripheral correctness review

Date: 2026-10-04. This review extends the earlier targeted fixes into a pass over
the modeled peripheral state transitions. Existing workspace edits were retained.
It is evidence about this implementation and its tests, not proof that no further
bugs exist or that every silicon behavior is implemented.

Hardware register rules were checked against the primary
[ATmega328P datasheet](https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf),
especially EEPROM, watchdog, input capture, SPI, USART, TWI, ADC, and SPM.

## Coverage

| Area | Cases checked |
| --- | --- |
| Every peripheral interrupt | All 25 vectors; latched events with global I clear; late enable; mask cancellation; flag clearing; hardware acknowledgement; level requests; direct and restored execution in fast and cycle-exact modes |
| GPIO and external interrupts | Raw input persistence while pins are outputs; masked edges; edge/level selection; restoring listeners without creating hardware edges; wake with global I clear |
| Timers | Counter/compare/overflow flags and masks; Timer1 capture and four-sample filtering; ICR1 as TOP; capture state through PRR/restore; PWM duty bounds; async Timer2 clock ratios and busy windows |
| ADC/comparator | Busy/start/abort state; first and later conversion timing; sampling and result locking; ADLAR/mux/reference changes; trigger edges independent of ISR flag clearing; PRR/sleep/restore |
| USART | RX FIFO and status ownership; request cancellation on flags/masks; persistent RX/UDRE; TXC clearing rules; in-flight TX/RX clock gating and restore |
| SPI | Status access and ISR clear sequences; separate receive/transmit data; collisions; disable/mode/SS aborts; SS input faults; PRR/sleep/restore |
| TWI | Hardware-owned status and collision flags; TWINT clear/preserve semantics; master/slave operation timing; persistent IRQ; PRR/restore |
| EEPROM/SPM | Ready levels and enable/disable/ISR behavior; SPM suppresses EEPROM ready; EEPROM protected-write expiry and programming modes; SPM command/page/lock behavior and restore |
| Watchdog/clock/sleep | Protected configuration window; interrupt/reset modes; flag writes preserve elapsed time; clock changes preserve remaining wall time; independent PRR/sleep gates and restored deadlines |

The interrupt matrix is in `test/peripheral-interrupt-matrix.test.ts`. Transition
regressions are in `test/peripheral-state-transitions.test.ts`; the earlier
register-level regressions remain in `test/peripheral-correctness.test.ts`.

## Fixes from this broader pass

- USART now queues requests independently of global I, withdraws stale requests,
  maintains RX/UDRE levels through acknowledgement, and preserves TXC on UDR writes.
  Ready requests no longer require an instruction-by-instruction interrupt poll.
- GPIO injection and snapshots retain raw external levels; restore notifications
  synchronize hardware edge detectors without creating PCINT or capture events.
- SPI aborts incomplete bytes on disable, mode changes, SS deselection, and master
  faults. Already-low input SS and DDR changes are checked. Slave SS remains an
  external input for host transfers. Transmit preloads preserve unread receive data.
- TWI status writes preserve hardware status. A TWDR write while TWINT is zero is
  rejected and sets TWWC; software cannot directly overwrite TWWC.
- EEPROM/SPM ready requests persist until their enables/conditions change. EEPROM
  ready is suppressed during SPM commands. EEMPE expires after four cycles, invalid
  writes stay idle, and EEPROM erase-only/write-only modes preserve bit semantics.
- Watchdog protection applies to WDE/WDP changes. WDIF/control-mask writes no
  longer restart a running timeout; clock changes preserve time remaining.
- ADC receives hardware flag edges before ISR acknowledgement and uses the
  external-trigger synchronization/sample delay instead of polling alone.
- Timer1 filters both input directions, rejects short glitches, preserves filtering
  across PRR/restore, disables capture while ICR1 is TOP, and clears restored ICF1
  requests on ISR entry. PWM duty stays in range when OCR exceeds TOP.
- Sleep gates ADC/SPI/USART as well as timers. Async Timer2 keeps running in ADC
  noise-reduction sleep. Enabled requests wake sleeping code with global I clear.
- Async Timer2 receives the runtime clock rate and preserves fractional phase and
  update-busy deadlines through CLKPR changes and snapshot restore.

## Validation

| Check | Result |
| --- | --- |
| Complete source suite | 1,107 passed, zero failed across 60 files; 6,154 assertions |
| TypeScript and generated-core consistency | Passed as part of `bun run verify` |
| Native simavr result cases | All four passed: peripheral-mix, isr-heavy, string-heavy, dsp-fixed |
| Native simavr timing cases | All five passed: serial/SPI/TWI polling, TWI slave, SPI slave, Timer2 async, comparator |
| Native simavr Optiboot | Serial transcript, programmed flash page, and uploaded application matched |
| Chromium integration | All eight Playwright tests passed |
| Library/declaration build and packed consumers | `build:lib` and `package:smoke` passed |
| Patch whitespace | `git diff --check` passed |

This broader pass added 254 source regressions to the earlier 853-test baseline.
`bun run verify` passed with the final implementation and fixture updates.

The final 2026-10-05 patch preparation reran these source/browser/package and
native checks with 0.1.1 metadata. See [release evidence](release-0.1.1.md) and
[the performance comparison](peripheral-performance.md).

The timing fixture now sets PB2/SS to output before enabling SPI master mode. Its
C source, HEX, and disassembly were rebuilt together with the existing avr-gcc
flags; native and avrts SPI polling both measured 43 cycles after this change.

Native comparisons retain their existing documented normalizations (including
USART RX/overrun host injection, TWI/SPI slave byte timing, and PWM port latch
differences). A passing normalized oracle is not bit-for-bit silicon timing proof.

## Model boundaries

Timer1's TEMP byte-access protocol and OCR buffering were added in the
[2026-10-05 follow-up](timer1-register-buffering.md). The counts above describe
the preceding review; current release checks are in [release evidence](release-0.1.1.md).

See `docs/limitations.md`. Remaining deliberate approximations include
Timer1 fast-PWM overflow phase relative to the native oracle, Timer2's cross-domain
reset/clear acknowledgement handshakes, external T0/T1 clocks,
byte serial/bus wiring, floating GPIO/pull-ups, immediate
EEPROM operations, analog settling, and full oscillator/wake-source timing. The
regression matrix does not claim these details have passed physical hardware acceptance.

The [power-save read follow-up](timer2-wake-read.md) adds Timer2's stale CPU-domain
counter read until the next TOSC edge after wake, including snapshots and clock changes.

The [0.1.2 signal follow-up](timer2-async-signals.md) adds the Timer2 flag
synchronizer and separates timer-domain wake from CPU-visible flags. It records
the native PSRASY probe disagreement and the remaining uncalibrated handshake.

The [wake clock follow-up](wake-clock-domains.md) restarts peripheral clocks
before wake startup and interrupt entry, retaining PRR and pending operation
deadlines. It keeps the uncalibrated Timer2 acknowledgement limits explicit.

The [external interrupt sleep follow-up](external-interrupt-sleep.md) gates
INT0/INT1 edge sensing with clkI/O, retaining asynchronous low-level and PCINT
wake and resampling held levels at resume. Completed asleep pulses do not wake
non-idle code; input synchronizer/startup filtering remains a model boundary.

The [timer boundary follow-up](timer-boundary-correctness.md) adds Timer0/Timer2
PWM buffers and both slopes, CTC TOP+1 periods, and the ordinary compare-flag
delay. It also fixes an I/O sampling-order mismatch in generated SBIC/SBIS.

The [Timer2 asynchronous follow-up](timer2-async-transfers.md) models separate
two-edge write transfers, temporary-register reads and independent busy flags.

The [SPI status follow-up](spi-status-sequence.md) removes transfer-start clears
of unread completion/collision flags and records a native simavr disagreement
for the status/data acknowledgement sequence.

The [register bit ownership follow-up](register-bit-ownership.md) masks reserved
control/address bits, protects ADC results, removes fictitious PC7 levels and
preserves reset causes until firmware clears them.

The [shared prescaler follow-up](timer-prescaler-phase.md) retains Timer0/Timer1's
free-running divider through stopped counters, CS changes and staggered starts,
and restores the common phase with sleep and GTCCR gates.

The [Timer2 divider follow-up](timer2-prescaler-phase.md) retains all divider bits
through CS changes, stopped counters and restore in both clock domains, aligns
prescaler reset/release with TOSC edges and bypasses PRTIM2 in asynchronous mode.
