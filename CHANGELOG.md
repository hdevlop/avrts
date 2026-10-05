# Changelog

All notable user-facing changes are recorded here. This project follows
Semantic Versioning once a version is published.

## Unreleased

## 0.1.1 - 2026-10-05

### Fixed

- Retain Timer2's full divider phase through clock-select changes, stopped
  counters, clock scaling and restore; align prescaler resets with TOSC edges
  and apply PRTIM2 only in synchronous mode.
- Share Timer0/Timer1's free-running prescaler phase across clock-select changes,
  staggered starts, counter gates and snapshots; retain GTCCR reset/hold and sleep gating.
- Mask reserved timer, interrupt, ADC, address and GPIO bits; prevent unsupported
  UBRR0H bits from changing USART frame time and remove fictitious PC7 levels.
- Ignore ADC data-register writes while retaining read locking; preserve reset
  causes across non-power-on resets and allow only firmware clearing of MCUSR flags.
- Preserve unread SPI completion/collision flags and pending interrupts when
  another master or slave byte starts; retain the required acknowledgement sequence.
- Transfer Timer2 asynchronous writes through separate temporary registers after
  two TOSC edges; expose temporary control/OCR reads and the running TCNT value.
- Retain independent Timer2 busy deadlines and oscillator phase across clock
  changes, sleep and snapshots; suppress compare actions during pending writes.
- Buffer Timer0/Timer2 OCR writes at TOP/BOTTOM, count both phase-correct slopes,
  and support OCRnA-TOP PWM modes, endpoint duties, and OCnA toggle outputs.
- Hold CTC TOP for one clock on all timers and raise ordinary compare flags on
  the following timer clock; preserve counter-write blocking and prescaler phase.
- Respect counter-write TOP/BOTTOM misses and avoid artificial phase-correct
  output edges when a compare value exceeds TOP.
- Model Timer0/Timer2 force-compare strobes without interrupt or CTC side effects,
  and restore active PWM values, direction and pending compare blocking.
- Sample generated SBIC/SBIS I/O before advancing their first cycle, matching
  the interpreter when a peripheral flag changes during that instruction.
- Model Timer1's shared TEMP byte, atomic low-byte commits, latched counter/capture
  reads, and the OCR read exception; preserve incomplete accesses through snapshots.
- Buffer Timer1 OCR updates at each PWM mode's TOP/BOTTOM boundary, retain active
  compare values through clock gating and restore, and report the active PWM duty.
- Hold Timer1 fast-PWM TOP for a full clock, preserve pulses across pending writes,
  and handle constant duty, zero-duty pulses, and supported OC1A toggle modes.
- Restrict ICR1 writes to TOP modes, raise ICF1 at ICR1 TOP, and block the next
  compare clock after a committed TCNT1 write without resetting prescaler phase.
- Synchronize ADC, comparator, SPI, TWI, pin-change, and external interrupt
  requests when flags or masks change; latch external-interrupt edges while masked.
- Preserve ADC busy state across control writes, abort conversions when disabled,
  and use 25 ADC clocks for initialization followed by 13 clocks per conversion.
- Latch ADC channel/reference selection during conversion and protect paired
  result reads with the ADCL/ADCH lock, including across snapshot restore.
- Preserve TWI's TWINT flag when firmware writes zero to it.
- Reassert TWI interrupts until TWINT is cleared, including after snapshot restore.
- Preserve SPI's read-only status flags on SPSR writes and avoid arming their
  read-clear sequence when a restored interrupt is acknowledged.
- Correct ADC auto-trigger enable/busy behavior, add comparator triggers, update
  ADLAR result presentation immediately, and hold sampled inputs across conversions
  and snapshot restore.
- Mask the comparator's ADC mux selection to MUX2..0 to avoid invalid-channel errors.
- Synchronize all USART requests with their masks and live flags, retain RX/UDRE
  requests through ISR entry and PRR, and preserve TXC until explicit acknowledgement.
- Preserve externally driven GPIO inputs across output changes and snapshots,
  and avoid manufacturing peripheral interrupts while restoring GPIO state.
- Abort SPI bytes on disable, mode changes, SS deselection, or master SS faults;
  detect already-low input SS and retain separate receive/transmit register data.
- Skip SPI SS checks on GPIO updates while SPI is disabled.
- Protect TWI status bits and reject TWDR writes while TWINT is clear, maintaining
  the hardware-owned TWWC collision flag.
- Implement persistent EEPROM/SPM ready interrupts, EEPROM write-enable expiry
  and erase-only/write-only modes, and ready suppression during SPM commands.
- Enforce the watchdog configuration window and preserve elapsed timeout time
  through flag writes, clock changes, and snapshot restore.
- Deliver ADC hardware trigger edges before ISR acknowledgement and apply
  external-trigger synchronization and sample-and-hold timing.
- Filter Timer1 input capture using four stable samples, pause filtering with
  its clock, disable capture when ICR1 is TOP, and acknowledge restored captures.
- Gate ADC/SPI/USART clocks during sleep, keep asynchronous Timer2 active in ADC
  noise-reduction mode, and resume code on enabled wake requests with global I clear.
- Propagate runtime clock changes to asynchronous Timer2, preserving fractional
  phase and update-busy deadlines through clock changes and snapshot restore.
- Keep PWM duty reports within zero to one when an OCR value exceeds dynamic TOP.

## 0.1.0 - 2026-10-04

### Added

- First public release, under the MIT License.
- Function-first `AVR(...)` package facade for ATmega328P simulation.
- Timed CPU, interrupt, GPIO, timer, ADC, EEPROM, watchdog, USART, SPI, TWI,
  sleep/wake, fuse, lock-bit, self-programming, and Optiboot behavior.
- Browser worker runtime, snapshots, debugger/watchpoints, circuit adapters,
  and explicit `avrts/browser` and `avrts/advanced` package subpaths.
- Native simavr state, timing, peripheral, and Optiboot oracle checks.
- Reproducible JavaScript/declaration builds and packed Node/Bun/browser
  consumer smoke tests.
- Versioned snapshots: `avr.snapshot()` stamps `version`
  (`AVR_SNAPSHOT_VERSION` in `avrts/advanced`); `restore()` rejects newer
  formats and other chips with a clear error, and still accepts unversioned
  snapshots.

### Fixed

- `SEI` and `RETI` permit the following instruction before pending interrupts,
  including in the generated and profiled CPU cores.
- Clearing timer interrupt flags or disabling their masks withdraws pending
  Timer0/Timer1/Timer2 requests; CPU reset also clears its interrupt queue.
- Snapshots synchronize timer counters before capturing CPU registers.
- Interrupt-only watchdog mode keeps firing without rearming `WDIE`; `WDIF`
  latches until acknowledgement or a write-one-to-clear operation. Combined
  interrupt/reset mode clears `WDIE` when its interrupt is acknowledged.
- Worker snapshots restore running/paused state and speed using a single
  worker-owned execution loop.
- Intel HEX records with high extended linear addresses are rejected before
  signed arithmetic can bypass flash bounds checking.
- The program counter wraps at the flash boundary like the chip's 14-bit PC.
  Real Arduino Uno fuses (BOOTRST programmed) with an application-only HEX now
  slide through the empty boot section into the sketch instead of crashing.
- `createAVRWorkerRuntime()` without a `worker` option now finds the packaged
  `browser-worker.js`; the package smoke test verifies the URL resolves.
- `avr.start()` replays at most 100 ms of host time per frame after a stall or
  backgrounded tab, instead of blocking on the whole missed interval.
- `status().timeMs` and pin-event times no longer rescale past time when the
  firmware changes the CLKPR clock prescaler.
- `watchData` observes stack writes (PUSH, calls, interrupt entry), and its last
  unsubscribe removes the CPU hook.
- `AVR("name")` with neither HEX text nor a path-like string explains how to
  pass a path instead of reporting a HEX syntax error.
- Published types are built under `strict`, exclude `@internal` members and
  internal-only modules, and no longer ship declaration maps to unpublished
  sources.

### Known limitations

- Electrical analog behavior, debugWIRE, exact power consumption, flash wear,
  and other documented non-goals remain out of scope. See
  `docs/limitations.md` in the repository.
