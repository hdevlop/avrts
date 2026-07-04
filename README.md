# avrts

A complete ATmega328P simulator (AVR-visible behavior) in TypeScript. "Complete"
means every AVR-visible behavior of the chip — registers, flags, interrupts,
timing, reset sources, memories, and the boot process — is either modeled
faithfully or listed in a machine-checked limitations table. Firmware cannot tell
the difference between avrts and real silicon for any behavior in the coverage
matrix; every timed feature is oracle-verified against native
[simavr](https://github.com/buserror/simavr).

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## What "complete" covers

- Full instruction set with a coverage harness; cycle-accurate CPU.
- Timers 0/1/2 (PWM, CTC, input capture, Timer2 asynchronous 32.768 kHz mode),
  ADC (including the temperature-sensor and bandgap internal channels), EEPROM,
  watchdog, external/pin-change interrupts, GPIO, and the analog comparator.
- Timed USART TX/RX (with the 2-level receive FIFO, DOR0/FE0/UPE0, MPCM, 9-bit,
  synchronous, and MSPIM modes), SPI master/slave, and TWI/I2C master/slave — so
  firmware polling `TXC0`, `RXC0`, `SPIF`, or `TWINT` observes a real delay
  before completion.
- Chip-level tier: fuses/lock bits, CKDIV8/BOOTRST/BOOTSZ, IVSEL vector
  relocation, self-programming (SPM), brown-out and reset sources, and a stock
  Optiboot bootloader that boots and flashes a sketch over the simulated serial
  line end to end.
- Sleep and wake fidelity: per-mode timer clock-domain gating and the full
  wake-source matrix (INT0/PCINT/ADC/TWI-address-match/WDT) with wake latency.
- Snapshot/restore, debugger, browser runtime, and Arduino/`avr-gcc` compile
  integration.

## Non-goals (permanent)

| Not modeled | Why |
|---|---|
| debugWIRE / on-chip debug hardware | Out of scope; no AVR-visible firmware behavior depends on it. |
| Electrical/analog fidelity: rise time, drive strength, bus contention, capacitance, noise, temperature | avrts models digital/logical behavior; analog pin voltages are host-supplied values, not simulated electrically. |
| Exact power/current consumption (µA) | Sleep *behavior* (clock gating, wake sources) is in scope; microamp figures are not. |
| Multi-master bus arbitration on the physical wire | The single-bus case is modeled honestly; TWI arbitration-loss is reachable via a host-API injection hook, documented in [docs/limitations.md](docs/limitations.md). |

## Arduino library matrix

Each supported Arduino library ships with a checked-in example sketch and a test
that runs the compiled firmware:

| Library | Example | Test |
|---|---|---|
| `Serial` (TX) | [arduino-serial-print](examples/arduino-serial-print/) | [phase9-golden.test.ts](test/phase9-golden.test.ts) |
| `Serial` (RX, `available()`-paced) | [arduino-serial-echo](examples/arduino-serial-echo/) | [phase9-golden.test.ts](test/phase9-golden.test.ts) |
| `Wire` (master + slave) | [arduino-wire-slave](examples/arduino-wire-slave/) | [twi-slave.test.ts](test/twi-slave.test.ts) + simavr oracle |
| `SPI` (master + slave) | [spi-slave-oracle](examples/spi-slave-oracle/) | [spi-slave.test.ts](test/spi-slave.test.ts) + simavr oracle |
| `Servo` | [arduino-servo-sweep](examples/arduino-servo-sweep/) | [servo.test.ts](test/servo.test.ts) |
| `tone()` | [arduino-tone-melody](examples/arduino-tone-melody/) | [tone.test.ts](test/tone.test.ts) |
| `SoftwareSerial` | [arduino-softserial-loopback](examples/arduino-softserial-loopback/) | [phase9-golden.test.ts](test/phase9-golden.test.ts) |
| `EEPROM` | [arduino-eeprom-store](examples/arduino-eeprom-store/) | [eeprom-store.test.ts](test/eeprom-store.test.ts) |
| LowPower-style WDT sleep | [arduino-lowpower-wdt](examples/arduino-lowpower-wdt/) | [lowpower-wdt.test.ts](test/lowpower-wdt.test.ts) |

## Oracle verification

Every timed feature is compared against native simavr, which runs the identical
firmware:

```bash
bun run oracle:simavr:timing   # USART/SPI/TWI polling, TWI+SPI slave, Timer2 async, comparator
bun run oracle:simavr:result   # peripheral-mix, ISR-heavy, string-heavy, DSP-fixed result blocks
```

Any remaining difference from silicon is normalized with a printed `NOTE` and is
a documented row in [docs/limitations.md](docs/limitations.md).

## Coverage matrix

Every ATmega328P IO register (0x20-0xFF) and all 26 interrupt vectors are
classified in `test/register-matrix.test.ts` as modeled, plain storage, or a
documented limitation - as of 2026-07: 81 of 87 named registers modeled, 6
plain storage, 0 documented in [docs/limitations.md](docs/limitations.md);
26 of 26 vectors modeled. The test cross-checks the classification against the
installed peripheral hooks and the limitations tables in both directions, so
the claim cannot silently rot. The roadmap that built this out is
[docs/complete-atmega328p-plan.md](docs/complete-atmega328p-plan.md).

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
