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
- **SPI** models master mode plus a byte-level host master API for firmware
  slave mode (`avr.spi.master().transfer(byte)`). SS selection and master-mode
  SS-fault behavior are modeled, and `SPIF` supports the documented
  read-SPSR-then-access-SPDR clear sequence. Wire bit order (`DORD`) is exposed
  as transfer metadata but individual bits are not serialized.
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
- **CLKPR** changes the runtime's effective `clockHz` after the CLKPCE-protected
  write protocol. Cycle-relative peripheral scheduling is unchanged; host-frame
  pacing and watchdog timeouts use the divided effective clock.
- **PRR** gates the modeled peripheral clocks for ADC, USART0, SPI, TWI, and
  timers 0/1/2 by pausing scheduled operations and timer counters. The register
  remains readable/writable in simulation while gated; electrical power/current
  effects are out of scope.
- **Timer1** models input capture (`TIMER1_CAPT`, ICR1 latch, ICES1, and the
  4-cycle ICNC1 delay) and all 16 WGM modes: normal, both CTC modes (OCR1A WGM 4,
  ICR1 WGM 12), the fixed 8/9/10-bit fast/phase-correct PWM modes (WGM 1/2/3 and
  5/6/7), and the OCR1A/ICR1-TOP PWM modes (WGM 8/9/10/11/14/15), with fast-PWM
  TOV1 at TOP and dual-slope TOV1 at BOTTOM. The reserved WGM 13 free-runs to the
  16-bit MAX (documented approximation). Exact OCR/ICR double-buffer edge
  semantics for every dynamic TOP update remain approximated.
- **Timer2 asynchronous mode** models `ASSR.AS2` with a simulated 32.768 kHz
  TOSC source and `TCN2UB`/`OCR2xUB`/`TCR2xUB` update-busy flags. External
  TOSC/EXCLK pin wiring and crystal drift are not modeled.
- **OSCCAL, DIDR0, and DIDR1** are plain storage. OSCCAL has no oscillator effect,
  and DIDR bits do not alter the digital/analog pin model.
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
- **Sleep** gates Timer0/Timer1 and Timer2 by sleep mode, starts ADC
  conversion on ADC noise-reduction sleep entry, keeps asynchronous Timer2
  running in power-save / extended-standby, reapplies gating after
  snapshot/restore, and adds the 4-cycle base interrupt wake latency.
  Library-level low-power validation remains Phase 7 work.

## Permanent non-goals

- debugWIRE and on-chip debug hardware.
- Electrical/analog fidelity: rise times, drive strength, bus contention,
  capacitance, noise, temperature effects.
- Exact power/current consumption figures.
