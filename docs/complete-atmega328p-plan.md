

# Complete ATmega328P Plan

Status: draft roadmap. Goal is to close the gap between "validated Arduino-class
simulator" (current state, see `real-peripheral-timing-plan.md`) and "complete
ATmega328P", with every phase gated on external-oracle validation, not just
internal tests.

Definition of "complete" used here: every AVR-visible behavior of the chip —
registers, flags, interrupts, timing, reset sources, memories, and the boot
process — is either modeled faithfully or listed in a machine-checked
limitations table. Electrical/analog behavior stays out of scope permanently.

## Current Evidence

- [x] Full instruction set with coverage harness; cycle-accurate CPU.
- [x] Timers 0/1/2 with PWM, ADC, EEPROM, watchdog, EXTI/PCINT, GPIO, sleep.
- [x] Timed USART TX/RX, SPI master/slave, and TWI master/slave. TWI slave,
  SPI slave receive/SPIF, and USART RXC polling/data now have native simavr
  oracle rows.
- [x] Snapshot/restore, debugger, browser runtime, compile integration.
- [x] Known gaps (confirmed by grep/tests, 2026-07): USART RX Arduino
  validation, timer2 async Arduino validation, comparator oracle row, and full
  Optiboot flow.

## Permanent Non-Goals

- [ ] debugWIRE and on-chip debug hardware.
- [ ] Electrical/analog fidelity: rise times, drive strength, bus contention,
  capacitance, noise, temperature effects.
- [ ] Exact power/current consumption figures (sleep *behavior* is in scope;
  microamps are not).

## Design Rules (carried over + new)

- [ ] Every timed behavior is scheduled with `addClockEvent`; write hooks never
  complete an operation instantly.
- [ ] Every phase adds simavr oracle coverage before it is called done; avr8js
  parity is added where avr8js models the feature.
- [ ] Host-facing APIs follow the established handle pattern (`avr.serial`,
  `avr.spi`, `avr.twi`); slave-mode APIs extend those handles rather than
  adding new top-level objects.
- [ ] Snapshot/restore support ships in the same phase as the feature, storing
  remaining cycles, with optional fields for backward compatibility.
- [ ] Fast blocks are never special-cased for a peripheral; the existing
  event/listener guards remain the only mechanism.

## Phase 0 - Register & Vector Coverage Matrix (grounds the "100%" claim)

Status: DONE (2026-07-04). `test/register-matrix.test.ts` + `docs/limitations.md`.
Baseline after Phase 4 + Phase 5 timer slice + Phase 6 SPM slice: 81/87 named
registers modeled, 6 storage, 0 unmodeled; 26/26 vectors modeled.

- [x] Generate a table of every ATmega328P IO/extended-IO register (0x20-0xFF)
  and all 26 interrupt vectors from the datasheet register summary.
- [x] Write a fidelity test that asserts each register is either (a) claimed by
  a peripheral hook/model, (b) plain read/write storage where hardware is
  plain storage (GPIOR0-2, ...), or (c) present in a checked-in
  `docs/limitations.md` table with a reason.
- [x] The test fails when a new register becomes modeled but stays listed as a
  limitation, or vice versa — the matrix can never silently rot. (Hooked ⇒
  must be "modeled"; storage/unmodeled/reserved ⇒ must have no hooks;
  limitations tables ⇔ matrix sets, both directions.)
- [x] Publish the matrix in README as the honest completeness statement.

## Phase 1 - USART Completion (RX pacing, errors, modes)

Status: DONE (2026-07-04, Codex completion). Core behavior lives in
`src/peripherals/usart.ts` + `test/usart-rx.test.ts` (15 tests), with native
simavr RXC polling/data coverage in `oracle:simavr:timing` and Arduino
validation in `test/phase9-golden.test.ts` via
`examples/arduino-serial-echo` and `examples/arduino-softserial-loopback`.
DOR0 overflow remains Bun-test-validated because native simavr's
UART input IRQ uses a 64-byte host FIFO and does not reproduce the silicon
two-byte receive-buffer overrun path.

- [x] Pace host-injected RX by frame time: bytes queue on the "wire", RXC0 sets
  one frame after the byte starts arriving, using the Phase-1 frame formula
  from the peripheral timing plan (keeping the simavr-calibrated +1 idle bit).
- [x] Model the 2-level receive FIFO + shift register; overflow sets DOR0
  (sticky until the next UDR0 read; the lost frame is dropped).
- [x] Add FE0 (host `usart.inject({framingError})`), UPE0 (injected, surfaced
  only when UPM parity mode is enabled), and MPCM0 address filtering (frames
  with a clear ninth bit are dropped).
- [x] 9-bit data (RXB80 mirrors the FIFO head; TXB80 sampled per UDR0 write).
- [x] Synchronous mode (UMSEL=01) timing: 2 clocks per bit; the XCK pin itself
  is not wired to GPIO (documented in limitations.md).
- [x] MSPIM mode (UMSEL=11): 8-bit exchange per frame via
  `usart.respondWith(...)`, responder byte enters the RX FIFO at completion.
- [x] Keep `serial.write()` semantics: still queues instantly from the host's
  view, but delivery to firmware is paced (documented behavior change;
  frames queued before RXEN0 wait on the wire and shift once enabled).
- [x] Snapshot/restore: RX wire/shift/FIFO frames with remaining cycles;
  legacy snapshots restore bytes as immediately readable.
- [x] Oracle: timing fixture covers RX polling/data (elapsed cycles until
  RXC0, received byte/status) against native simavr. DOR0 overflow is covered
  by `test/usart-rx.test.ts`; native simavr cannot directly oracle that path
  through its UART input IRQ FIFO.
- [x] Arduino validation: `Serial.available()`-paced echo sketch, and
  `SoftwareSerial` TX/RX loopback as a pin-timing stress test
  (`bun test test/phase9-golden.test.ts`, 8/8 passing on 2026-07-04).

## Phase 2 - TWI Slave Mode (biggest Arduino-class gap)

Status: DONE (2026-07-03, Codex parallel slice). Implemented and externally
validated `avr.twi.master()` in `src/peripherals/twi.ts`: TWAR/TWAMR/TWGCE
matching, delayed slave receive/transmit statuses, repeated-start/STOP status,
arbitration-loss injection, and snapshot/restore for pending host-driven slave
operations. Validation is covered by `test/twi-slave.test.ts`, the real Arduino
`examples/arduino-wire-slave` fixture, and the native simavr
`oracle:simavr:timing` TWI-slave case.

- [x] TWAR address match + TWAMR mask + general call (TWGCE).
- [x] Slave status codes 0x60-0xC8 through the existing scheduled-operation
  state machine (SR: 0x60/0x68/0x70/0x78/0x80/0x88/0x90/0x98/0xA0;
  ST: 0xA8/0xB0/0xB8/0xC0/0xC8).
- [x] Host API: `avr.twi.master()` handle that lets the host act as an external
  master (start/write/read/stop against the simulated slave), mirroring how
  `connect()` lets the host act as a slave today.
- [x] TWEA-controlled ACK/NACK, repeated start into and out of slave mode.
- [x] Arbitration: model the single-bus case honestly — status 0x38 reachable
  only via a host-API injection hook; true multi-master wire modeling stays a
  documented limitation.
- [x] Snapshot/restore of in-progress slave transactions.
- [x] Arduino validation: `Wire.onReceive`/`Wire.onRequest` sketches driven by
  the host-master API — this is the headline feature of the phase.
- [x] Oracle: simavr TWI slave fixture (simavr can drive its TWI as master
  against our firmware slave via its i2c parts); compare the Wire slave result
  block and external-master transcript through `bun run oracle:simavr:timing`.

## Phase 3 - SPI Slave Mode

Status: core implemented (2026-07-03, Codex parallel slice) in
`src/peripherals/spi.ts` + `test/spi-slave.test.ts` (7 tests), with native
simavr slave receive/SPIF oracle coverage added on 2026-07-04. Native simavr's
SPI input IRQ exposes a transaction-level model and echoes the injected byte
instead of the preloaded slave `SPDR`, so the oracle validates the
firmware-visible receive/SPIF result block and normalizes the host-output byte.

Evidence, 2026-07-04, `bun run oracle:simavr:timing -- --timing-case spi-slave`:

| Engine | Completed | Cycles | Result bytes |
|---|---:|---:|---|
| simavr | yes | 215 | `a7 28 00 3c 80 00 40 3c 00 00 00 00 00 00 51 5c` |
| avrts | yes | 1,001 | `a7 28 00 3c 80 00 40 3c 00 00 00 00 00 00 51 5c` |

Normalized: host-output byte only (`simavr=3c`, `avrts=a5`) because native
simavr echoes the SPI input IRQ byte instead of shifting out the preloaded
slave `SPDR`.

- [x] SPE + !MSTR: transfers clocked by a host-side master API
  (`avr.spi.master().transfer(byte)` returning the slave's SPDR byte).
- [x] SS pin behavior: slave selected/deselected by the SS GPIO level; in
  master mode, SS driven low as input forces MSTR clear + SPIF (per
  datasheet), verified by test.
- [x] SPIF read-clear sequence (read SPSR with SPIF set, then access SPDR) in
  both modes — replaces the write-time-clear approximation where firmware
  uses the documented sequence; keep write-time clear as fallback.
- [x] DORD: byte-level model stays byte-level; expose bit order as metadata on
  the transfer callback and document that wire bit order is not serialized.
- [x] Snapshot/restore of in-progress slave transfers.
- [x] Oracle case for slave receive/SPIF polling through
  `bun run oracle:simavr:timing -- --timing-case spi-slave`.

## Phase 4 - Small Peripherals Sweep

Status: DONE (2026-07-04, Fable). Core implemented (2026-07-03, Codex parallel
slice) in `src/peripherals/analog-comparator.ts`,
`src/peripherals/clock-control.ts`, `src/peripherals/power-reduction.ts`,
`src/avr.ts`, and `test/phase4-small-peripherals.test.ts` (13 tests). Arduino
validation added (2026-07-04): `examples/arduino-comparator-interrupt`
(rising-edge comparator ISR, `test/comparator-interrupt.test.ts`) and
`examples/arduino-adc-internal` (temperature-sensor + bandgap raw-register reads,
`test/adc-internal.test.ts`).

- [x] Analog comparator: ACSR (ACO from host-set AIN0/AIN1 analog values,
  ACI + ACIE interrupt, ACIS edge select), ACME/ADEN mux to ADC channels,
  ACIC input-capture trigger into timer1.
- [x] CLKPR: runtime clock prescale. Cycle-relative behavior is unchanged
  (every peripheral runs off the divided clock), so implement as an effective
  `clockHz` change in the runtime frame pacing + a CLKPCE-protected register
  write protocol. Document this simplification.
- [x] PRR: gating a peripheral freezes its scheduled events/timer counters and
  resumes them on ungate; register-access simplification is documented in
  `docs/limitations.md`.
- [x] MCUSR reset-source flags: PORF on power-on, WDRF on watchdog reset,
  EXTRF via a host `avr.resetExternal()` API, BORF reserved for Phase 6.
- [x] ADC: temperature-sensor channel (MUX=1000) and bandgap (MUX=1110) with
  host-settable values.
- [x] ADC noise-reduction sleep gating.
- [x] GPIOR0-2/OSCCAL confirmed as plain storage in the Phase 0 matrix.
- [x] Arduino validation: a comparator-interrupt sketch
  (`examples/arduino-comparator-interrupt`, rising-edge `ANALOG_COMP_vect`
  tally) and an `analogRead(TEMPERATURE)`-style raw-register sketch
  (`examples/arduino-adc-internal`, temperature sensor + bandgap via
  ADMUX/ADCSRA). Covered by `test/comparator-interrupt.test.ts` and
  `test/adc-internal.test.ts`.

## Phase 5 - Timer Completeness

Status: core implemented (2026-07-03, Fable + Codex parallel slices). Covered
by `test/phase5-timers.test.ts` and `test/phase5-timer-completeness.test.ts`:
Timer2 async + busy-flag protocol, ICP1/ACIC input capture with ICNC1 delay,
FOC strobes, GTCCR TSM/PSRSYNC/PSRASY (`src/peripherals/timer-sync.ts`), and
Timer1 ICR1-as-TOP modes for WGM 8/10/12/14, and all 16 Timer1 WGM modes
(fixed 8/9/10-bit, OCR1A/ICR1 TOP). Timer2 async drift is native-oracle
validated and the `examples/arduino-timer2-rtc` sketch validates async overflow
timekeeping (`test/timer2-rtc.test.ts`). Phase 5 is complete.

- [x] Timer2 asynchronous mode (ASSR/AS2): clock from a simulated 32.768 kHz
  TOSC, scheduled at the cycle ratio to the main clock; TCN2UB/OCR2xUB/TCR2xUB
  busy flags with the datasheet's update protocol (values latch immediately,
  flags clear after one TOSC period — documented approximation). The ratio
  tracks the effective CLKPR-divided clock, and snapshot/restore re-arms
  pending busy clears.
- [x] ICP1 input capture: edge select, 4-cycle noise canceler delay, ICR1
  latch, ICF1 flag, and `TIMER1_CAPT` interrupt; snapshot carries a pending
  noise-canceler capture.
- [x] ACIC comparator path: comparator output edges drive the capture unit
  through ICES1 (`analogComparator.onCaptureTrigger` wired in the runtime).
- [x] ICR1 as PWM/CTC TOP (WGM 8/10/12/14): CTC mode 12, fast PWM mode 14,
  and dual-slope PWM modes 8/10 use ICR1 as TOP for wrap/direction, flags,
  PWM duty, and OC1A/OC1B pin output.
- [x] Verify forced output compare (FOC1A/FOC1B via TCCR1C) against the Phase 0
  matrix: strobes act on the pin in non-PWM modes, read back as zero, never
  set OCF1x.
- [x] GTCCR: PSRSYNC/PSRASY prescaler-reset strobes and TSM hold-in-reset for
  synchronized timer starts (freezes timer0/1 and timer2 respectively).
- [x] Verify remaining WGM edge cases against the Phase 0 matrix; close or
  document each. All 16 Timer1 WGM modes now model their TOP source (fixed
  8/9/10-bit, OCR1A, ICR1, or 16-bit MAX), single-vs-dual slope, and TOV1 edge
  (fast PWM at TOP, dual-slope at BOTTOM); the reserved WGM 13 free-runs to MAX
  as a documented approximation. Covered by
  `test/phase5-timer-completeness.test.ts`.
- [x] Oracle: simavr comparison for timer2 async tick drift over a long run.
  Evidence, 2026-07-04,
  `bun run oracle:simavr:timing -- --timing-case timer2-async`:

  | Engine | Completed | Cycles | Result bytes |
  |---|---:|---:|---|
  | simavr | yes | 1,966,203 | `a7 86 00 20 ba 07 20 5c` |
  | avrts | yes | 1,966,968 | `a7 86 00 20 ba 07 20 5c` |

  The result stores firmware-read `TCNT2` snapshots after one and thirty
  Timer1-overflow milestones (`0x86`, then `0xba`), proving avrts carries the
  fractional 16 MHz / 32.768 kHz TOSC ratio without long-run drift against
  native simavr.
- [x] Arduino validation: an RTC-style sketch using timer2 async overflow.
  `examples/arduino-timer2-rtc` clocks Timer2 from the 32.768 kHz TOSC crystal
  (prescaler 128 -> 1 Hz overflow) and counts seconds in the `TIMER2_OVF` ISR;
  `test/timer2-rtc.test.ts` runs the compiled `.ino.hex` for several simulated
  seconds and asserts it keeps time at the exact async tick ratio.

## Phase 6 - Chip-Level Tier (fuses, bootloader, SPM, BOD)

This is the phase that turns "application simulator" into "chip simulator".

Status: DONE (2026-07-04, Codex Phase 6 Optiboot slice). Covered by
`test/phase6-chip-level.test.ts`, `test/phase6-self-programming.test.ts`, and
`test/phase6-optiboot.test.ts`: `avr.useFuses()`, `avr.fuses()`, CKDIV8,
BOOTRST/BOOTSZ reset PC, MCUCR IVCE/IVSEL vector relocation, BODS/BODSE
handshake, `avr.resetBrownOut()`, WDTON, EESAVE via `avr.chipErase()`,
SUT/CKSEL startup-delay approximation, LPM fuse/lock/signature reads, SPMCSR
page fill/erase/write from the boot section, lock-bit programming/enforcement
for boot/application SPM/LPM access, RWWSRE/RWWSB, SPM_READY,
snapshot/restore of fuses/vector relocation/SPM command-window plus
page-buffer state, and stock Optiboot STK500v1 programming.

- [x] Fuse bytes (low/high/extended) + lock bits as loadable host
  configuration (`avr.useFuses({...})`, `avr.fuses()`).
- [x] Firmware fuse/lock reads via the LPM fuse-read protocol.
- [x] Fuse effects wired: CKDIV8 (initial CLKPR=8), BOOTRST (reset vector into
  the boot section), and BOOTSZ (boot section size).
- [x] Remaining fuse effects: WDTON (watchdog forced on), EESAVE (EEPROM
  survives chip erase), SUT/CKSEL (startup delay as a documented approximation).
- [x] IVSEL/IVCE (MCUCR): interrupt vector table relocation to the boot section,
  with the timed enable protocol.
- [x] SPM (SPMCSR): page erase, page fill, page write, RWW section busy +
  RWWSRE, boot lock bits, `SPM` only executing from the boot section.
  Decode-cache invalidation runs on flash writes.
- [x] Full lock-bit enforcement across boot/application read-write permissions.
- [x] Brown-out: BODS/BODSE sleep-disable protocol and a host API to inject a
  brown-out reset setting BORF. Voltage simulation stays a non-goal; BOD is
  modeled as an injectable reset source.
- [x] Snapshot/restore of fuses and boot-vector relocation state.
- [x] Snapshot/restore of SPM command-window and page-buffer state.
- [x] **Headline validation: boot real Optiboot.** Load the stock Optiboot
  .hex with BOOTRST set, speak STK500v1 over `avr.serial` from a host-side
  test, flash a blink sketch through the simulated bootloader, watch it run.
  This single test exercises SPM, boot section, vectors, USART RX pacing, and
  the watchdog-reset entry path end to end. Covered by
  `test/phase6-optiboot.test.ts` using
  `examples/optiboot/optiboot_atmega328.hex`.
- [x] Oracle: simavr runs Optiboot natively — compare the full flash image and
  cycle envelope after an identical STK500 session. Covered by
  `bun run oracle:simavr:optiboot`: simavr and avrts both complete the STK500v1
  session, emit 140 serial bytes, program matching page-0 flash bytes
  (`00 e2 04 b9 00 e2 05 b9 00 e0 05 b9 ff cf ...`), and run the uploaded
  app. Native simavr's Optiboot LED Timer1 wait is normalized in the helper;
  the SPM/serial/flash/app-execution path remains compared.

## Phase 7 - Sleep & Wake Fidelity

Status: DONE (2026-07-04, Fable Arduino validation slice). Core covered by
`test/phase7-sleep-wake.test.ts`: idle keeps sync timers running; ADC
noise-reduction starts an ADC conversion while sync timers are gated;
power-down and standby gate sync timers; power-save and extended standby keep
async Timer2 running; sleep-state restore reapplies timer gating; INT0, PCINT0,
ADC, TWI address-match, and WDT wake covered sleep states; and interrupt wake
adds the 4-cycle base latency. SUT/CKSEL reset startup delay is covered in
`test/phase6-chip-level.test.ts` because the behavior belongs to the fuse/reset
tier.

- [x] Timer clock-domain gating by sleep mode for idle, ADC noise reduction,
  power-down, power-save, standby, and extended standby: sync Timer0/1/2 stop
  outside idle; async Timer2 runs in power-save / extended-standby.
- [x] ADC noise-reduction mode starts a conversion on sleep entry while sync
  timers stay gated.
- [x] Sleep snapshot/restore reapplies mode-specific timer gating.
- [x] Broaden wake-source matrix beyond INT0 and WDT.
- [x] WDT wake from power-down.
- [x] TWI address-match wake nuance.
- [x] Wake-up latency: 4-cycle base.
- [x] SUT/CKSEL startup time from fuses (documented approximation for crystal
  startup).
- [x] Arduino validation: a `LowPower`-library-style sketch sleeping on WDT.
  `examples/arduino-lowpower-wdt` arms the watchdog timeout interrupt, enters
  `SLEEP_MODE_PWR_DOWN`, and wakes each 16 ms period (re-arming WDIE before each
  sleep). `test/lowpower-wdt.test.ts` runs the compiled `.ino.hex` across several
  periods and asserts the sleep/wake cadence and snapshot/restore.

## Phase 8 - Final Validation Sweep

Status: DONE (2026-07-04, Fable). Full sweep green: register matrix,
typecheck, check:fast-core, 648 Bun tests, both simavr oracles (timing +
result), Optiboot, and the benchmark suite (tight-loop 28.6M cycles/s, no
fast-path regression — Phase 8 added no `src/` changes). Comparator oracle row
added; README rewritten with the completeness statement, non-goals table, and
Arduino library matrix.

- [x] Phase 0 matrix shows 100%: every register modeled or documented, zero
  unexplained rows (`test/register-matrix.test.ts`, 81 modeled / 6 storage / 0
  unmodeled; 26/26 vectors).
- [x] `oracle:simavr:timing` extended matrix green. USART TX/RX, SPI
  master/slave receive/SPIF, TWI master/slave, Timer2 async drift, and the new
  comparator rising-edge row all pass (`bun run oracle:simavr:timing`). The
  comparator row drives AIN0/AIN1 through simavr's ACOMP input IRQs vs the avrts
  comparator handle at an identical injected edge cycle
  (`examples/comparator-oracle`, `--timing-case comparator`).
- [x] `oracle:simavr:result` green on all fixtures (peripheral-mix, isr-heavy,
  string-heavy, dsp-fixed).
- [x] Optiboot end-to-end flash test green
  (`test/phase6-optiboot.test.ts`, `bun run oracle:simavr:optiboot`).
- [x] Arduino library matrix documented in README: Serial (TX+RX), Wire
  (master+slave), SPI (master+slave), Servo, tone(), SoftwareSerial,
  EEPROM, LowPower-style sleep — each with a checked-in example test
  (`arduino-servo-sweep`/`servo.test.ts`, `arduino-tone-melody`/`tone.test.ts`,
  `arduino-eeprom-store`/`eeprom-store.test.ts` added this phase).
- [x] `bun run typecheck`, `bun run check:fast-core`, full `bun test`,
  benchmark suite showing no fast-path regression (the new features must not
  break fast-block eligibility for firmware that doesn't use them).
- [x] README rewritten: "complete ATmega328P (AVR-visible behavior)" with the
  non-goals table.

## Suggested Order & Rationale

1. **Phase 0** first — cheap, and it converts "100%" from a slogan into a
   failing-test-driven checklist.
2. **Phase 1 + 2** next — USART RX and Wire slave are the two things real
   Arduino projects hit most often that currently don't work.
3. **Phase 3 + 4** — small, independent, parallelizable.
4. **Phase 5** — timer2 async matters for RTC/low-power sketches.
5. **Phase 6** — biggest single phase; Optiboot is the payoff and the proof.
6. **Phase 7 + 8** — polish and the final sweep.

Phases 1-4 reuse existing machinery (scheduled events, handle APIs, snapshot
pattern, oracle harness) and carry low architectural risk. Phase 6 is the only
phase that touches the CPU core (SPM, vector relocation) — plan a dedicated
review there like the one done for peripheral timing.

## Done Definition

- [x] A stock Optiboot hex boots, accepts a sketch over the simulated serial
  line, and runs it — no special-case code paths.
- [x] Firmware cannot tell the difference between avrts and simavr for any
  behavior in the Phase 0 matrix (oracle-verified for every timed feature; the
  comparator rising-edge row was the last one, added in Phase 8). Remaining
  cross-engine differences are simavr-model artifacts normalized with a printed
  `NOTE` (e.g. SPI-slave echo byte, UART input-FIFO DOR0).
- [x] Every remaining difference from silicon is a row in `docs/limitations.md`
  guarded by the Phase 0 fidelity test (`test/register-matrix.test.ts`
  cross-checks the limitations tables against the peripheral hooks both ways).
