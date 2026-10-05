# Simulator Limitations

This file is machine-checked: `test/register-matrix.test.ts` asserts that every
ATmega328P IO register and interrupt vector is either modeled, plain storage,
or listed here. Removing a row without modeling the register (or vice versa)
fails the test. Planned phases refer to `docs/complete-atmega328p-plan.md`.

## Unmodeled registers

| Register | Address | Planned phase | Notes |
| --- | --- | --- | --- |

## Unmodeled interrupt vectors

| Vector | Number | Planned phase | Notes |
| --- | --- | --- | --- |

## Behavioral limitations (registers modeled, behavior approximated)

Not machine-checked; keep in sync with the implementation by review.

- **USART RX** is paced by frame time through the 2-level FIFO with
  FE0/DOR0/UPE0, MPCM filtering, 9-bit, synchronous, and MSPIM modes — but
  framing/parity errors are host-*injected* (`usart.inject(...)`), not derived
  from wire bits, and the synchronous XCK clock is not wired to a GPIO pin.
  Frame scheduling is calibrated to native simavr; individual serial-bit sample
  boundaries and electrical line behavior are not modeled.
- **SPI** models master mode plus a byte-level host master API for firmware
  slave mode (`avr.spi.master().transfer(byte)`). SS selection and master-mode
  SS-fault behavior are modeled, and `SPIF` supports the documented
  read-SPSR-then-access-SPDR clear sequence. Wire bit order (`DORD`) is exposed
  as transfer metadata but individual bits are not serialized.
  New bytes preserve unread status flags. The local native simavr probe clears
  SPIF on unarmed SPDR access and does not report the tested write collisions;
  this flag behavior is not native-oracle equivalent. See the
  [SPI status evidence](evidence/spi-status-sequence.md).
- **TWI** models master and slave modes (TWAR/TWAMR address match, general
  call, host-side `twi.master()` handle). Multi-master arbitration loss is
  reachable only via host injection, not from real wire contention. START/STOP
  delays are calibrated to native simavr (1 cycle), not silicon
  (~0.5-1 SCL period).
- **Analog comparator** models ACSR flags/interrupts from host-supplied AIN0/AIN1
  voltages and the ACME ADC mux, and the ACIC path drives the full Timer1
  input-capture unit (ICES1 edge select, ICR1 latch, TIMER1_CAPT). This is a
  logical voltage comparison only; electrical noise, input leakage, and
  propagation delay are not modeled.
- **GPIO inputs** are host-driven logical levels. Floating inputs, pull-up
  resistance, and full serial peripheral pin overrides are not modeled.
- **EEPROM** implements reads, protected writes, programming modes, and ready
  interrupts, but completes reads/writes immediately rather than modeling CPU
  read stalls and millisecond programming latency.
- **CLKPR** changes the runtime's effective `clockHz` after the CLKPCE-protected
  write protocol. CPU-clocked peripherals follow that effective clock;
  watchdog timeouts and asynchronous Timer2 preserve their remaining wall time.
  Host-frame pacing uses the divided effective clock.
- **PRR** gates the modeled peripheral clocks for ADC, USART0, SPI, TWI, and
  timers 0/1/2 by pausing scheduled operations and timer counters. The register
  remains readable/writable in simulation while gated; electrical power/current
  effects are out of scope.
- **Timer1** models input capture (`TIMER1_CAPT`, ICR1 latch, ICES1, and the
  4-cycle ICNC1 delay) and all 16 WGM modes: normal, both CTC modes (OCR1A WGM 4,
  ICR1 WGM 12), the fixed 8/9/10-bit fast/phase-correct PWM modes (WGM 1/2/3 and
  5/6/7), and the OCR1A/ICR1-TOP PWM modes (WGM 8/9/10/11/14/15), with fast-PWM
  TOV1 at TOP and dual-slope TOV1 at BOTTOM. The reserved WGM 13 free-runs to the
  16-bit MAX (documented approximation). Shared TEMP accesses, atomic low-byte
  commits, and OCR1A/B PWM buffering at the selected TOP/BOTTOM boundary are
  modeled. ICR1 is unbuffered and writable only when it defines TOP; lowering
  it below the counter can miss TOP until the counter wraps.
  Timer0/Timer1 external T0/T1 clock inputs are not wired.
- **Timer prescaler phase** uses per-timer remainders. Synchronous clock-select
  changes reset the local phase, and stopped counters do not keep a shared
  free-running Timer0/Timer1 divider. GTCCR reset/hold behavior is modeled, but
  arbitrary staggered starts and divisor changes do not reproduce the shared
  divider described in datasheet section 16.2. Timer2's asynchronous source
  phase is retained; its divider taps are not a complete free-running model.
- **Timer0/Timer2** model normal/CTC and fixed/variable-TOP fast/phase-correct
  PWM (WGM 0/1/2/3/5/7), OCR buffers transferred at BOTTOM or TOP, both counting
  slopes, endpoint duties, OCnA toggle and force-compare strobes. Reserved WGM
  4/6 free-run as an approximation. CTC holds TOP for one timer clock on all
  three timers; ordinary OCF flags sample equality on the following clock.
  TCNT-written compare TOP and down-counting BOTTOM miss their boundary until
  the counter wraps; compare values above TOP do not generate compare pin edges.
  Timer1 OCR1A-as-TOP PWM has a dedicated TOP flag. PWM facade duty remains a
  compare-value/TOP description, not a measurement of individual pin pulses.
  Timer1 fast-PWM TOV1 remains at TOP per the mode description; the local
  simavr overflow probe observes it at BOTTOM, so this phase is not native-oracle
  equivalent and has not been checked against physical hardware.
- **Timer2 asynchronous mode** models `ASSR.AS2` with a simulated 32.768 kHz
  TOSC source and separate temporary-register transfers after two source edges.
  Control/OCR reads expose the temporary value; TCNT reads the running counter.
  Each busy flag clears with its own transfer, independently of PWM buffering.
  Busy writes preserve the first queued value; clock-domain switches discard
  pending writes while retaining destinations. These are deterministic choices
  for hardware-defined corruption risks, not simulations of corrupted values.
  Power-down/standby pause the source and retain state rather than modeling
  oscillator startup instability or possible register loss. External TOSC/EXCLK
  pin wiring, crystal drift, the wake-time CPU-domain TCNT read latch and the
  three-CPU-cycle asynchronous interrupt-flag synchronization are not modeled.
- **OSCCAL** is plain storage and has no oscillator effect. **DIDR0/DIDR1**
  retain only implemented bits; they do not alter the digital/analog pin model.
- **Fuse / boot tier** stores fuse bytes and lock bits; applies CKDIV8,
  WDTON, EESAVE through `avr.chipErase()`, BOOTRST/BOOTSZ, SUT/CKSEL startup
  delay as a cycle-level approximation when the low fuse is explicitly
  configured, IVSEL/IVCE vector relocation, the BODS/BODSE handshake, and
  host-injected brown-out reset (`avr.resetBrownOut()`). Firmware fuse/lock
  reads through the LPM fuse-read protocol are modeled.
- **SPM self-programming** models SPMCSR command bits, boot-section-only SPM
  execution, 64-word page buffer fill, page erase/write, RWWSRE/RWWSB,
  lock-bit programming, boot-lock enforcement for cross-section SPM/LPM access,
  LPM signature/fuse/lock reads, and SPM_READY interrupts. Stock Optiboot
  STK500v1 programming is validated with avrts and a native simavr oracle.
  Flash wear and exact millisecond erase/write latency are not modeled.
- **Sleep** gates Timer0/Timer1, SPI, USART, ADC, and Timer2 by sleep mode, starts ADC
  conversion on ADC noise-reduction sleep entry, keeps asynchronous Timer2
  running in ADC noise-reduction / power-save / extended-standby, reapplies gating after
  snapshot/restore, and adds the 4-cycle base interrupt wake latency.
  A compiled LowPower-style watchdog sleep fixture validates repeated
  power-down wake cycles and snapshot/restore (`test/lowpower-wdt.test.ts`).
  TWI uses the host byte-operation model rather than modeling each asleep-bus
  clock stretch or asynchronous address-watch transition. Oscillator startup
  and wake-source filtering are not a complete silicon model.

## Permanent non-goals

- debugWIRE and on-chip debug hardware.
- Electrical/analog fidelity: rise times, drive strength, bus contention,
  capacitance, noise, temperature effects.
- Exact power/current consumption figures.
