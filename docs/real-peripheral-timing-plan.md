# Real Peripheral Timing Plan

Status: implemented in avrts; local TypeScript, Bun test, and native simavr timing
oracle gates pass.

Goal: make USART, SPI, and TWI behave like timed AVR peripherals, not instant
host callbacks. Firmware that polls flags, waits on interrupts, measures elapsed
cycles, or races against a transfer should see hardware-like timing.

## Original Evidence

- [x] USART0 transmit is currently functional but immediate: writing `UDR0`
  emits a byte and sets ready/complete flags right away.
- [x] SPI master transfer is currently functional but immediate: writing `SPDR`
  clocks a byte out/in and sets `SPIF` right away.
- [x] `SPIF` is never cleared in the current SPI model (`spi.ts` only ORs it in;
  only the interrupt acknowledge clears it). Timed SPI must add an explicit
  clear or polling loops pass instantly on the stale flag.
- [x] TWI/I2C master is currently functional but immediate at the state-machine
  level: status codes and `TWINT` become ready without bus-time delay.
- [x] The CPU already has scheduled clock events, so timed peripheral completion
  can use `addClockEvent` / `clearClockEvent` instead of per-instruction polling.
- [x] Fast paths already respect scheduled events: `canRunFastBlock` and
  `bulkIdleLoopIterations` (`src/cpu/cpu.ts`) refuse to cross `nextClockEvent`,
  and the poll-wait fast block relies on that invariant. Phases 2-4 only need to
  schedule events correctly; no new fast-path mechanism is required.
- [x] Timed TX helps the fast path: while a frame is in flight `UDRE0` is clear,
  so the 1-cycle USART interrupt-poll event disarms and busy-waits can
  bulk-skip straight to the scheduled completion event.

## Non-Goals For This Pass

- [x] Do not implement bootloader behavior.
- [x] Do not implement fuses/lock bits.
- [x] Do not implement `SPM` / self-programming.
- [x] Do not implement brown-out reset behavior.
- [x] Do not implement exact sleep-mode power consumption states.
- [x] Do not model every analog/electrical bus detail, such as rise time,
  contention, capacitance, or noise.
- [x] Original pass did not pace RX; later Phase 1 USART work superseded this
  and now paces host-injected RX through the simulated wire/FIFO.

These should remain documented simulator limitations unless a later plan targets
them directly.

## Design Rules

- [x] Default behavior should be timing-realistic for AVR-visible flags,
  interrupts, and cycle counts.
- [x] Transfer completion must be scheduled by CPU cycles, not completed in the
  write hook.
- [x] Host-facing byte listeners (`onByteTransmit` for USART and SPI, TWI slave
  callbacks) fire at transfer **completion**, not at register-write time: one
  code path, transcript timestamps match hardware-visible time, and nothing
  host-visible has happened for an in-flight transfer (simpler snapshots).
- [x] Snapshot/restore must preserve in-flight transfers as **remaining**
  cycles (not absolute completion cycles), so restore is just
  `addClockEvent(cb, remaining)`. New snapshot fields are optional with
  defaults so previously serialized snapshots still load.
- [x] Tests should assert behavior before and after the hardware delay.
- [x] Keep host-facing APIs (`serial.onText`, `spi.respondWith`,
  `twi.connect`, `onByteTransmit`) stable; only their *timing* changes (bytes
  arrive at completion in simulated time).

## Phase 1 - Register Constants And Timing Helpers

- [x] Add missing USART constants (UCSR0C bits):
  `UMSEL01`, `UMSEL00`, `UPM01`, `UPM00`, `USBS0`, `UCSZ01`, `UCSZ00`,
  `UCPOL0`. (`UCSZ02`, `UBRR0H/L`, `UCSR0C` already exist.)
- [x] Add missing SPI constants: `SPR1`, `SPR0`, `SPI2X`. (`WCOL` already
  exists in `constants.ts`.)
- [x] Add missing TWI constants: `TWPS0`, `TWPS1`.
- [x] Add small helper functions near each peripheral for calculating transfer
  cycles from the actual control registers.
- [x] USART TX-complete cycle formula (single source of truth for code and
  tests):
  `frameCycles = (UBRR + 1) * (U2X0 ? 8 : 16) * frameBits`, where
  `frameBits = 1 start + 5..9 data + (0|1) parity + (1|2) stop + 1
  simavr-calibrated TXC0 flag latency bit`.
- [x] SPI SCK-period formula: divider from `SPR1:SPR0` (4/16/64/128), halved
  when `SPI2X` is set (2/8/32/64); transfer = 8 SCK periods.
- [x] TWI SCL formula: `sclCycles = 16 + 2 * TWBR * prescaler`, prescaler from
  `TWSR` bits `TWPS1:TWPS0` (1/4/16/64).
- [x] Add focused tests for the timing calculations and delayed flag behavior.

## Phase 2 - USART0 TX Timing

Decision (was a review question): model the datasheet double buffer, not a
single delayed flag. `UDRE0` means the transmit buffer can accept a byte;
`TXC0` means the shift register drained with an empty buffer.

- [x] Replace immediate TX completion with an in-flight transmit state:
  a shift register (byte being clocked out) plus a one-byte transmit buffer.
- [x] Compute frame cycles from `clockHz`, `UBRR0H:UBRR0L`, `U2X0`, character
  size, parity, and stop bits (Phase 1 formula).
- [x] Write to `UDR0` with shift register idle: byte moves to the shift
  register immediately, `UDRE0` stays set, completion event scheduled.
- [x] Write to `UDR0` while shifting: byte parks in the transmit buffer,
  `UDRE0` clears.
- [x] Write to `UDR0` while `UDRE0` is clear (shift register busy AND buffer
  full): **ignored**, per datasheet. Do not overwrite the buffered byte.
- [x] Clear `TXC0` when firmware writes a new byte to `UDR0` (matches simavr
  and avr8js).
- [x] On frame completion: emit the byte to `onByteTransmit` listeners, move
  the buffered byte (if any) into the shift register, set `UDRE0`, schedule the
  next frame; set `TXC0` only when the shift register drains with an empty
  buffer.
- [x] Request `USART_TX_VECTOR` only when `TXCIE0` is enabled and the delayed
  `TXC0` becomes set; `USART_UDRE_VECTOR` follows the double-buffered `UDRE0`.
- [x] Preserve existing RX queue behavior (RX pacing is a non-goal).
- [x] Snapshot/restore: shift-register byte, remaining frame cycles, buffered
  byte (or none); `UCSR0A` flags ride along in the CPU data snapshot.

Consequence to expect: Arduino `HardwareSerial` becomes genuinely
interrupt-driven — `Serial.print` fills the ring buffer and drains via
`UDRIE0`, with two bytes in flight back-to-back through the double buffer.

## Phase 3 - SPI Master Timing

Decision (was a review question): `onByteTransmit` and the `respondWith`
responder both run at transfer **completion** (see Design Rules).

- [x] Replace immediate SPI completion with an in-flight transfer state.
- [x] Compute SCK period from `SPR1:SPR0` and `SPI2X` (Phase 1 formula);
  schedule completion after 8 SCK clocks.
- [x] **Clear `SPIF` when a valid `SPDR` write starts a transfer.** Nothing
  else clears it in this model, so without this the second
  `while (!(SPSR & _BV(SPIF)))` poll passes instantly on the stale flag.
  (Real hardware clears it via read-`SPSR`-then-access-`SPDR`; write-time
  clearing is the documented sim approximation.)
- [x] Keep `SPIF` clear during the transfer; store the received MISO byte into
  `SPDR` only when the transfer completes.
- [x] Request `SPI_STC_VECTOR` only when `SPIE` is enabled and delayed `SPIF`
  becomes set.
- [x] Handle write collision: writing `SPDR` while a transfer is in progress
  sets `WCOL` and is ignored (does not replace the active transfer).
- [x] Snapshot/restore: pending MOSI byte, remaining cycles, busy state. The
  MISO byte is computed at completion (responder runs then), so it is not
  stored; a restored sim needs the responder reattached before completion
  fires — same rule as TWI slaves.

## Phase 4 - TWI/I2C Master Timing

Decisions (were review questions): byte operations (SLA+R/W, data) cost
**9 SCL periods** (8 bits + ACK); START/repeated-START and STOP cost **1 CPU
cycle** each, calibrated against the native simavr timing oracle. Slave callbacks
(`start`/`read`/`write`/`stop`) run at operation **completion**, so snapshots
never store a callback result and the existing "reconnect slaves before
resuming" rule covers restore.

- [x] Replace immediate TWI state-machine completion with scheduled operations.
- [x] Compute SCL cycles from `sclCycles = 16 + 2 * TWBR * prescaler`, with the
  prescaler from `TWSR` bits `TWPS1:TWPS0` (Phase 1 formula).
- [x] Delay START, STOP, address, write-byte, and read-byte status updates by
  the cycle counts above.
- [x] Keep `TWINT` clear while the bus operation is in progress; set `TWINT`
  and update `TWSR` only when the delayed operation completes.
- [x] Run the slave callback inside the completion event, immediately before
  applying the status code.
- [x] Request `TWI_VECTOR` only when `TWIE` is enabled and delayed `TWINT`
  becomes set.
- [x] STOP: **`TWSTO` stays set for the STOP duration and clears inside the
  scheduled completion event**; `TWINT` is not set. This is load-bearing:
  Arduino's `twi_stop()` spins on `while (TWCR & _BV(TWSTO))`, so the flag
  clearing in a clock event is exactly what the poll-wait fast block needs to
  stop at.
- [x] Snapshot/restore: pending operation type, remaining cycles, current
  slave address / read-write direction, and started/awaiting-address flags.
  No status-to-apply or data-byte result is stored (computed at completion).

## Phase 5 - Tests

- [x] Update USART tests that currently expect immediate `TXC0`.
- [x] Add USART tests:
  byte not emitted/complete before frame delay, emitted/complete after frame
  delay, double buffer accepts two quick writes and ignores a third,
  `UDR0` write clears `TXC0`, `TXCIE0` interrupt fires after delay,
  snapshot restores in-flight frame plus buffered byte.
- [x] Update SPI tests that currently expect immediate `SPIF`.
- [x] Add SPI tests:
  `SPDR` write clears stale `SPIF`, `SPIF` remains clear before 8 SCK clocks,
  responder byte appears in `SPDR` only after delay, interrupt fires after
  delay, write collision sets `WCOL` and keeps the active transfer,
  snapshot restores in-flight transfer.
- [x] Update TWI tests that currently expect immediate status codes.
- [x] Add TWI tests:
  `TWINT` remains clear before operation delay, status appears after delay,
  slave callbacks fire at completion, `TWSTO` stays set during STOP and clears
  after the STOP delay without setting `TWINT`, interrupt fires after delay,
  snapshot restores pending operation.
- [x] Add regression tests proving fast-run/poll-wait loops stop at scheduled
  peripheral completion events (guards already exist in `cpu.ts`; this pins
  the invariant).
- [x] Budget for wide test fallout beyond the peripheral suites: at 9600 baud
  one byte costs ~16,700 cycles, so any test that runs a sketch for N cycles
  and expects serial output can shift — expect updates in `phase9-golden`,
  `phase15-peripheral-fidelity`, `phase18-demo`, the `phase21-*`
  adapter/serial-monitor suites, and `avr.test.ts`, not just
  `phase7`/`phase8-rest`/`phase10-snapshot`.

## Phase 6 - Validation Gates

Fast inner loop while implementing:

- [x] `bun test test/phase7.test.ts`
- [x] `bun test test/phase8-rest.test.ts`
- [x] `bun test test/phase10-snapshot.test.ts`
- [x] `bun test test/cpu.test.ts`

Full gates before declaring done:

- [x] `bun run typecheck`
- [x] `bun test` (catches the wider fallout listed in Phase 5)
- [x] Add or update simavr oracle coverage for USART polling cases
  (`TXC0` and later `RXC0`/data), SPI master polling, SPI slave receive/SPIF,
  Timer2 async drift, and TWI polling/slave cases; use the oracle to calibrate
  the TWI START/STOP cycle counts. DOR0 overrun stays covered by focused Bun
  tests because native simavr's UART input IRQ uses a 64-byte host FIFO. SPI
  slave host-output bytes are normalized because native simavr's SPI input IRQ
  echoes the injected byte instead of the preloaded slave `SPDR`.

## Done Definition

- [x] Firmware polling `TXC0`, `RXC0`, `SPIF`, or `TWINT` can observe time
  passing before the flag becomes ready.
- [x] Interrupt-driven firmware receives USART/SPI/TWI interrupts at delayed
  transfer completion, not at register write time.
- [x] Snapshot/restore of an in-flight transfer resumes with the correct
  remaining cycle delay.
- [x] README or public docs separate "timed AVR-visible behavior now modeled"
  from still-missing features like bootloader validation and detailed sleep
  power states.

## Validation Evidence

- [x] 2026-07-02: `bun run typecheck`
- [x] 2026-07-02: `bun test` — 508 pass, 0 fail
- [x] 2026-07-03: `bun run typecheck`
- [x] 2026-07-03: `bun test` — 513 pass, 0 fail
- [x] 2026-07-03: `bun run oracle:simavr:timing` — PASS
- [x] 2026-07-03: `bun run bench` — completed benchmark sanity run
