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

- **Erased-flash execution** treats exactly `0xFFFF` as a one-cycle no-op with
  PC advancing one word and no register/flag changes. This compatibility policy
  permits empty runtimes and BOOTRST-selected erased boot sections to run and
  wrap at the flash boundary. Traces/profiles label it `NOP`; flash contents and
  LPM/SPM semantics remain erased. The documented AVR NOP encoding is `0x0000`;
  the `0xFFFF` policy has not been physically calibrated. Other unsupported
  opcodes retain their unknown-opcode errors.
- **USART** retains its byte-frame/FIFO API by default. `avr.serial.useWire()`
  selects TXD/PD1, RXD/PD0 and XCK/PD4. Async RX uses three samples per bit;
  parity/framing errors come from received bits. Synchronous external XCK and
  master XCK/MSPIM are supported. Serial clocks pause through PRR/sleep and
  snapshots preserve partially shifted frames. Byte injection is rejected in
  wire mode. The legacy byte mode retains its native-oriented extra idle bit;
  wire TX completes after its actual start/data/parity/stop bits. Physical
  electrical timing and oscillator error tolerances are not calibrated.
- **SPI** retains byte responder/host-master APIs by default; `avr.spi.useWire()`
  selects SCK/PB5, MOSI/PB3 and MISO/PB4 for master/slave transfers, all four
  clock modes and both bit orders. Pin directions follow the alternate-function
  rules; slave MISO is an input while SS is high. Pin-driven transfers retain
  SPIF/WCOL and SPSR-then-SPDR acknowledgement semantics, PRR/sleep gates and
  snapshots. Byte APIs are rejected in wire mode. The local native simavr
  SPIF/collision disagreement remains in [SPI status evidence](evidence/spi-status-sequence.md).
  External SCK edges are logical; analog thresholds and sub-clock setup/hold
  violations are not reproduced.
- **TWI** retains native-oriented byte scheduling by default. `avr.twi.useWire()`
  selects open-drain SDA/PC4 and SCL/PC5, with address/general-call matching,
  master/slave bytes, ACK/NACK, START/repeated START/STOP, sampled arbitration
  and clock stretching. `createTwiBus()` resolves logical wired-AND lines across
  AVR endpoints; the caller advances their clocks. Connected bus listeners are
  runtime-owned, while snapshots retain each AVR's driver and protocol state.
  Bus electrical rise times, capacitance and noise remain excluded.
- **Analog comparator** supports AIN0/AIN1, ACME and ACIC input capture. Immediate
  logical comparison remains the default. `avr.comparator.setTiming(...)` adds
  explicit CPU-clock propagation/settling delays and rejects short excursions.
  Delayed flags and captures occur together and survive snapshots. Deep sleep
  cancels pending propagation, then wake reapplies settling to held inputs.
  These are host-selected policies, not measured physical delays. ACME with
  PRADC and comparator wake retain the [existing digital contract](evidence/analog-sleep-boundaries.md).
- **GPIO** resolves serial alternate-function ownership above timer/PORT outputs.
  TWI resolves open-drain drivers against host input levels; use logical pull-ups
  or `createTwiBus()`. Floating voltage, resistance and electrical contention
  remain excluded. DIDR affects firmware PIN register reads, independently of
  physical analog input values and host pin observations.
- **External interrupts** keep asynchronous low-level wake and PCINT. Optional
  `avr.gpio.useInterruptSynchronization()` samples INT0/INT1 on the next I/O
  clock and publishes edges after two pipeline clocks. Sub-sample pulses are
  rejected; snapshots preserve pending stages. Non-idle sleep discards stopped
  clock stages and wake resamples held inputs. Physical oscillator startup and
  fractional electrical sampling phases have not been measured.
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
  Async PSRASY remains asserted until reset at the next source edge, including
  stopped counters and snapshots. This deterministic crossing policy has not
  been physically calibrated; exact silicon mux startup remains unmeasured.
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
  oscillator startup instability or possible register loss. `avr.timer2Clock`
  selects a configurable logical frequency or manual rising EXCLK edges under
  AS2+EXCLK. Frequency changes retain source phase and pending transfers; manual
  source switches retain remaining transfer edges. Crystal drift is host-selected
  through frequency changes, not a physical oscillator model. Asynchronous compare/overflow
  conditions pass through a timer-clock stage and three CPU clocks before CPU
  flags become visible. Non-idle sleep pauses those CPU stages; enabled
  timer-domain conditions wake noise-reduction, power-save and extended-standby
  on the timer stage, with CPU synchronization completing during wake startup.
  Pending stages survive snapshots and clock changes; three CPU clocks remain
  three CPU clocks after CLKPR changes. This timing is based on the datasheet,
  not physical-hardware calibration. CPU flag clearing is immediate; timer-domain
  acknowledgement waits for the next source edge. Re-entering eligible sleep
  before that edge can cause the documented repeated wake. Exact PSRASY reset
  latency remains physically uncalibrated; the native probe retains the written
  bit rather than providing a trustworthy completion reference.
- **OSCCAL** is storage by default. `avr.useOscillatorCalibration(curve)`
  supplies a 256-entry host frequency table for the internal RC CKSEL selection.
  Pass `{ resetCode: value }` as the second argument to supply the factory
  calibration byte loaded on configuration and reset; the default code is 0.
  OSCCAL changes then update the base clock while retaining CLKPR and peripheral
  wall time. No generic silicon calibration curve is invented. **DIDR0/DIDR1**
  suppress the corresponding firmware PIN reads; analog voltages remain available.
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
  Wire TWI remains able to observe asynchronous external address clocks and
  hold SCL at firmware byte boundaries; PRR still gates the peripheral.
  Oscillator startup and wake-source filtering are not a complete silicon model.

## Permanent non-goals

- debugWIRE and on-chip debug hardware.
- Electrical/analog fidelity: rise times, drive strength, bus contention,
  capacitance, noise, temperature effects.
- Exact power/current consumption figures.

## Current model scope (2026-10-10)

The previous [scope decision record](evidence/calibration-scope-2026-10-10.md)
is historical. The user selected the deferred digital models for implementation.
[Wire and clock contracts](wire-models.md) describe their APIs and timing policies.
Physical calibration, electrical noise/current, wear and debugWIRE require
separate hardware evidence or remain permanent non-goals. Local tests establish
these logical models; they do not establish every physical silicon behavior.
