# Simulator Limitations

The unmodeled register/vector tables are machine-checked:
`test/register-matrix.test.ts` asserts that every ATmega328P IO register and
interrupt vector is classified as modeled, plain storage, reserved, or listed
here as unmodeled. Inconsistent table rows and installed hooks fail the test.
The behavioral paragraphs below are maintained by review, not by that matrix.
Current phase assignments for every known limitation are in the
[root remaining-work inventory](../AVRTS-REMAINING-WORK-PLAN.md#11-full-limitation-disposition-inventory).
The [chip-level roadmap](complete-atmega328p-plan.md) records completed historical phases.

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
  propagation delay are not modeled. ACME-selected host input changes are
  evaluated immediately. Deep sleep retains the last logical output without
  generating events; wake samples held inputs after ADC/Timer1 clocks resume.
  Only idle allows comparator wake; other-mode flags remain available after
  an eligible wake source resumes the CPU. Power-up settling and ACO's physical
  1–2-clock synchronizer are not modeled. ACME operation with PRADC set remains
  unsupported rather than modeling the hardware's unavailable ADC mux. See
  [analog sleep evidence](evidence/analog-sleep-boundaries.md).
- **GPIO inputs** are host-driven logical levels. Floating inputs, pull-up
  resistance, and full serial peripheral pin overrides are not modeled.
- **External interrupts** stop INT0/INT1 edge/toggle detection with clkI/O in
  non-idle sleep and sample held levels at wake start. Completed asleep pulses
  are ignored; idle, asynchronous low-level sensing and PCINT remain active.
  Last clocked samples survive snapshots separately from raw GPIO levels.
  Input synchronizer stages, short-pulse filtering and low-level pulse retention
  through physical oscillator startup are not calibrated. See
  [external interrupt sleep evidence](evidence/external-interrupt-sleep.md).
- **EEPROM** latches firmware programming address/data/mode and holds EEPE busy
  for deterministic typical durations: 3.4 ms atomic erase/write, 1.8 ms erase-only
  or write-only. Reads stall the CPU four clocks; accepted writes stall two.
  Reserved mode and busy restarts are rejected. Ready IRQs, SPM exclusion,
  powered reset, clock changes, sleep and pending snapshots are covered.
  Host storage helpers remain immediate. Supply-loss corruption and wear are
  excluded; these typical durations are not a hardware guarantee. See the
  [runtime fidelity evidence](evidence/runtime-fidelity-2026-10-10.md).
- **CLKPR** changes the runtime's effective `clockHz` after the CLKPCE-protected
  write protocol. CPU-clocked peripherals follow that effective clock;
  watchdog, EEPROM/flash programming and asynchronous Timer2 preserve remaining wall time.
  Host-frame pacing uses the divided effective clock.
- **PRR** gates the modeled peripheral clocks for ADC, USART0, SPI, TWI, and
  timers 0/1/2 by pausing scheduled operations and timer counters. The register
  remains readable/writable in simulation while gated; electrical power/current
  effects are out of scope. PRTIM2 gates Timer2 only in synchronous mode; AS2
  bypasses that gate as documented by the chip.
- **Timer1** models input capture (`TIMER1_CAPT`, ICR1 latch, ICES1, and the
  4-cycle ICNC1 delay) and all 16 WGM modes: normal, both CTC modes (OCR1A WGM 4,
  ICR1 WGM 12), the fixed 8/9/10-bit fast/phase-correct PWM modes (WGM 1/2/3 and
  5/6/7), and the OCR1A/ICR1-TOP PWM modes (WGM 8/9/10/11/14/15), with fast-PWM
  TOV1 at TOP and dual-slope TOV1 at BOTTOM. The reserved WGM 13 free-runs to the
  16-bit MAX (documented approximation). Shared TEMP accesses, atomic low-byte
  commits, and OCR1A/B PWM buffering at the selected TOP/BOTTOM boundary are
  modeled. ICR1 is unbuffered and writable only when it defines TOP; lowering
  it below the counter can miss TOP until the counter wraps.
  Timer0/Timer1 accept external falling/rising clocks on PD4/PD5 through the
  existing logical pins. Integer-phase sampling uses the next I/O clock plus
  two pipeline clocks; same-cycle pulses are ignored. PRR, deep sleep and mux
  changes discard disabled-domain edges, and snapshots retain pending stages.
  Fractional edge phases and electrical input thresholds are not modeled.
- **Timer prescaler phase** models a shared free-running ten-bit Timer0/Timer1
  divider, with CS-independent phase, GTCCR reset/hold, sleep clock gating and
  snapshots. Counter PRR gates leave the common divider running. The exact
  silicon clock-mux startup pipeline is not modeled; timer counts use the
  simulator's selected tap boundaries. Older snapshots retain their saved next
  counter edges, but cannot reconstruct a shared phase absent from the file.
  Timer2 retains its independent full divider phase across CS changes and stopped
  counters in both clock domains, including fractional TOSC periods, clock scaling,
  PRR/sleep/GTCCR gates and restore. TOSC keeps running during a divider hold.
  Async PSRASY acknowledgement remains immediate in the GTCCR model; the silicon
  cross-domain reset handshake and exact mux startup pipeline are not modeled.
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
  Control/OCR reads expose the temporary value; TCNT reads the running counter
  except during the asynchronous power-save wake read window. That window
  retains the pre-sleep CPU-visible value until the next rising TOSC edge,
  including edges during interrupt entry, clock scaling and snapshots.
  Host reads while the CPU sleeps still inspect the running counter. Older
  snapshots cannot reconstruct a pre-sleep value that they did not record.
  Other sleep modes retain their preceding read behavior; the power-save latch
  model has not been calibrated against physical hardware.
  Each busy flag clears with its own transfer, independently of PWM buffering.
  Busy writes preserve the first queued value; clock-domain switches discard
  pending writes while retaining destinations. These are deterministic choices
  for hardware-defined corruption risks, not simulations of corrupted values.
  Power-down/standby pause the source and retain state rather than modeling
  oscillator startup instability or possible register loss. External TOSC/EXCLK
  pin wiring and crystal drift are not modeled. Asynchronous compare/overflow
  conditions pass through a timer-clock stage and three CPU clocks before CPU
  flags become visible. Non-idle sleep pauses those CPU stages; enabled
  timer-domain conditions wake noise-reduction, power-save and extended-standby
  on the timer stage, with CPU synchronization completing during wake startup.
  Pending stages survive snapshots and clock changes; three CPU clocks remain
  three CPU clocks after CLKPR changes. This timing is based on the datasheet,
  not physical-hardware calibration. The asynchronous clear/acknowledgement
  handshake and repeated-wake behavior on re-entering sleep within one TOSC
  period are not modeled. Exact PSRASY reset latency remains uncalibrated;
  the native probe retains the written bit rather than providing a reliable
  reset-completion reference.
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
  Erase/write operations use a deterministic 4.1 ms duration from the standard
  datasheet's 3.7..4.5 ms range; the command window remains four CPU clocks.
  The fixed RWW/NRWW boundary is word 0x3800, independently of BOOTSZ. NRWW
  programming stalls all fetches; RWW programming permits NRWW execution and
  blocks RWW fetch/LPM until completion and RWWSRE. Invalid blocked reads use
  deterministic zero rather than undefined silicon results. Writes clear bits
  only; erase restores ones. Programming continues through powered reset,
  startup delay, sleep, CLKPR and snapshots. Flash wear and voltage/temperature
  dependent programming times remain excluded. The local native build verifies
  programming data but lacks these busy durations.
- **Sleep** gates Timer0/Timer1, SPI, USART, ADC, and Timer2 by sleep mode, starts ADC
  conversion on idle / ADC noise-reduction sleep entry, keeps asynchronous Timer2
  running in ADC noise-reduction / power-save / extended-standby, reapplies gating after
  snapshot/restore, and adds the 4-cycle base interrupt wake latency. Sleep gates
  release at wake start, before startup/interrupt entry clocks, while PRR remains
  independent; in-flight operations can complete during entry. The precise
  physical startup edge has not been calibrated. See
  [wake clock evidence](evidence/wake-clock-domains.md).
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

## Retained scope decisions (2026-10-10)

The [calibration and scope record](evidence/calibration-scope-2026-10-10.md)
resolves the remaining queue without advertising unimplemented fidelity.
Timer2's asynchronous clear/acknowledgement handshake, repeated sleep within
one TOSC period, PSRASY crossing, and externally driven TOSC/EXCLK remain
explicitly deferred. Existing digital transfers, synchronization, wake reads,
clock phase and RTC behavior remain supported. A configurable external source
requires a concrete client and source-switch/phase contract before implementation.
EXTI sub-clock pulses, comparator propagation/settling and physical oscillator
startup remain uncalibrated. Wire-level USART/SPI/TWI, electrical GPIO contention,
OSCCAL frequency effects and DIDR input-buffer suppression remain outside the
selected byte-level/logical-pin contract. Existing host injection APIs remain
available; no full physical bus model is implied.
