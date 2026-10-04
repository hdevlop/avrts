# avrts

<p align="center">
  <img src="https://img.shields.io/badge/ATmega328P-chip%20level-blue?style=for-the-badge&logo=arduino&logoColor=white" alt="ATmega328P chip-level simulator">
  <img src="https://img.shields.io/badge/TypeScript-runtime-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript runtime">
  <img src="https://img.shields.io/badge/Bun-tested-111111?style=for-the-badge&logo=bun&logoColor=white" alt="Bun tested">
  <img src="https://img.shields.io/badge/simavr-oracle%20checked-2d7d46?style=for-the-badge" alt="simavr oracle checked">
</p>

Realistic ATmega328P simulation in TypeScript.

avrts is built for chip-level fidelity, not for winning every speed chart. It
models the MCU underneath an Arduino Uno/Nano: CPU state, IO registers,
interrupt vectors, timers, reset sources, fuses, lock bits, sleep modes, flash
self-programming, serial buses, and the boot flow. Firmware should observe the
same AVR-visible behavior it would observe on the chip, while the simulator
still runs comfortably in Node, Bun, and browser workers.

If you want the fastest mature application-level Arduino simulator, avr8js is an
excellent choice. If you need the parts avr8js intentionally skips - `SPM`,
bootloaders, fuses, lock bits, sleep/wake clock domains, PRR, Timer2 async, or
analog-comparator capture - avrts is the simulator for that layer.

## At A Glance

| Need | avrts answer |
| --- | --- |
| Load firmware | Pass HEX text, a `.hex` path, or a browser `File` |
| Default chip | ATmega328P, 16 MHz clock |
| Main API | `AVR(...)` facade; no `new` needed |
| Timing model | Fast mode by default, optional cycle-exact mode |
| Validation | Bun tests plus native simavr timing/result/Optiboot oracles |
| Browser use | Worker runtime, snapshot/restore, pin/PWM/serial adapters |
| Best fit | Realistic register-level AVR simulation, bootloaders, low-power firmware, peripheral timing |

## Why avrts

- **Chip-level model**: not just Arduino API behavior, but the register and
  interrupt surface real firmware touches.
- **Bootloader capable**: stock Optiboot boots, accepts STK500v1 programming
  over the simulated USART, writes flash through `SPM`, and runs the uploaded
  sketch.
- **Native simavr validation**: timing, final state, and the Optiboot flow are
  cross-checked against native simavr where simavr can represent the behavior.
- **Browser friendly**: a public `AVR(...)` facade, snapshot/restore, debugger
  hooks, component adapters, and a worker-backed browser runtime.
- **Honest speed target**: most current fixtures are faster than realtime at
  16 MHz, but host-bound bit-banging can fall below realtime and compute-heavy
  real code can be slower than avr8js. Fidelity is the product priority.

## Install

After the package is published:

```bash
npm install @hdevlop/avrts
# or: bun add @hdevlop/avrts
```

For development in this repository:

```bash
bun install
bun test
```

The stable package root contains the function-first facade:

```ts
import { AVR } from "@hdevlop/avrts";
```

Browser/circuit APIs and low-level internals use explicit subpaths so they do
not accidentally become part of the minimal root contract:

```ts
import { createAVRWorkerRuntime } from "@hdevlop/avrts/browser";
import { CPU, Decoder, PORTB } from "@hdevlop/avrts/advanced";
```

avrts is released under the [MIT License](LICENSE).

## Quick Start

Load a local Intel HEX file in Node/Bun. The default chip clock is 16 MHz,
matching an Arduino Uno/Nano ATmega328P.

```ts
import { AVR } from "@hdevlop/avrts";

const avr = AVR("blink.hex");

avr.pin(13).onChange((high, event) => {
  console.log(event.timeMs.toFixed(3), high ? "LED on" : "LED off");
});

avr.serial.onText((text) => {
  process.stdout.write(text);
});

avr.runFor(1000);
console.log(avr.status());
```

If you already have HEX text in memory, pass it directly:

```ts
const avr = AVR(hexText);
```

Use `clockHz` only when you want a non-default clock:

```ts
const avr = AVR({ path: "blink.hex", clockHz: 8_000_000 });
```

## Loading Firmware

avrts accepts the common ways firmware appears in apps and tests:

```ts
AVR("build/sketch.hex");                    // Node/Bun path
AVR({ path: new URL("./blink.hex", import.meta.url) });
AVR(hexText);                               // direct Intel HEX text
AVR({ hex: hexText, timing: "cycle-exact" });
```

For browser file uploads, use the async file API:

```ts
const input = document.querySelector<HTMLInputElement>("#hex")!;

input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;

  const avr = AVR();
  await avr.loadFile(file);
  avr.start();
});
```

For fluent setup:

```ts
const avr = AVR()
  .useClock(16_000_000)
  .useFuses({ low: 0xff, high: 0xde, extended: 0xfd })
  .useHexFile("firmware.hex");
```

## Practical Examples

### Digital Input And Output

Drive an input pin from the host and observe firmware-controlled output:

```ts
const avr = AVR("button-led.hex");

const led = avr.pin(13);
const button = avr.pin(2);

led.onChange((high) => {
  console.log(`LED is ${high ? "HIGH" : "LOW"}`);
});

button.setInput(true);
avr.runFor(20);
button.setInput(false);
avr.runFor(20);
```

Use port-level observation when you care about the whole register value:

```ts
avr.gpio.port("B").onChange((value, oldValue) => {
  console.log(`PORTB ${oldValue.toString(16)} -> ${value.toString(16)}`);
});
```

### Serial TX And RX

Capture text written by firmware and inject host input back into `Serial`:

```ts
const avr = AVR("serial-echo.hex");

avr.serial.onText((chunk) => {
  process.stdout.write(chunk);
});

avr.serial.write("hello from host\n");
avr.runFor(100);

console.log(avr.serial.getText());
```

`serial.write(...)` is frame-time paced through the simulated USART RX path. The
firmware does not receive bytes instantly; it observes `RXC0`, `UDR0`, FIFO
behavior, and overrun status like a chip would.

### Analog Input And PWM Output

Feed `analogRead(A0)` and observe PWM generated by `analogWrite(...)`:

```ts
const avr = AVR("analog-pwm.hex");

avr.analog(0).setVoltage(2.5); // A0 at 2.5 V against the default 5 V reference

avr.pwm(9).onChange((signal) => {
  if (signal.enabled) {
    console.log(`pin 9 duty ${(signal.duty * 100).toFixed(1)}%`);
  }
});

avr.runFor(50);
```

Use `setValue(...)` when your test already has a raw 10-bit ADC sample:

```ts
avr.analog(0).setValue(512);
```

### Virtual I2C Slave

Connect a virtual device to firmware using the AVR TWI master peripheral:

```ts
const avr = AVR("wire-master.hex");
const writes: number[] = [];

avr.twi.connect(0x50, {
  start(address, read) {
    console.log(`I2C address 0x${address.toString(16)} ${read ? "read" : "write"}`);
    return true; // ACK address
  },
  write(byte) {
    writes.push(byte);
    return true; // ACK data
  },
  read() {
    return 0x42;
  },
  stop() {
    console.log("I2C STOP", writes);
  },
});

avr.runFor(100);
```

The same TWI model also exposes `avr.twi.master()` for host-side tests where
firmware is configured as an I2C slave.

### SPI Responder

Respond to firmware SPI master transfers:

```ts
const avr = AVR("spi-master.hex");

avr.spi.onByte((mosi, meta) => {
  console.log(`MOSI 0x${mosi.toString(16)} ${meta.bitOrder}`);
});

avr.spi.respondWith((mosi) => mosi ^ 0xff);

avr.runFor(20);
```

When firmware is configured as an SPI slave, drive it from the host:

```ts
const master = avr.spi.master();
const miso = master.transfer(0x3c);
console.log(miso);
```

### Snapshot, Rewind, And Deterministic Tests

Snapshots include CPU state, peripherals, pending events, serial buffers, fuses,
sleep state, timers, and in-flight transfers:

```ts
const avr = AVR("protocol.hex");

avr.runFor(10);
const beforePacket = avr.snapshot();

avr.serial.write("bad packet\n");
avr.runFor(50);

avr.restore(beforePacket);
avr.serial.write("good packet\n");
avr.runFor(50);
```

Snapshots are plain data and carry a format `version`, so they can be stored
(for example in IndexedDB) and restored by later releases; `restore()` rejects
snapshots from a newer format with a clear error.

### Debugging And Watchpoints

Use breakpoints and data watchpoints for register-level tests and UI inspectors:

```ts
const avr = AVR("firmware.hex");

avr.breakpoint({ pc: 0x0120 });
avr.watchData(0x25, ({ oldValue, value }) => {
  console.log(`PORTB ${oldValue.toString(16)} -> ${value.toString(16)}`);
});

avr.on("breakpoint", (event) => {
  console.log(`stopped at PC=${event.pc?.toString(16)}`);
});

avr.runCycles(200_000);
```

### Chip-Level Setup

Configure fuses and reset behavior when your firmware depends on the chip tier:

```ts
const avr = AVR()
  .useFuses({
    // Example only: choose fuse bytes for your target firmware.
    low: 0xff,
    high: 0xde,
    extended: 0xfd,
  })
  .useHexFile("boot-or-app.hex");

avr.reset();
console.log(avr.status().clockHz);
```

For full bootloader flows, see [examples/optiboot/](examples/optiboot/) and the
native simavr Optiboot oracle:

```bash
bun run oracle:simavr:optiboot
```

## What It Models

| Area | Coverage |
| --- | --- |
| CPU | AVR instruction set, flags, stack, program/data memory, breakpoints, cycle accounting, fast timing and cycle-exact timing modes |
| Registers/vectors | All ATmega328P IO addresses classified; 81 named registers modeled with hooks, 6 verified as plain storage, 0 unmodeled named registers, 26/26 interrupt vectors modeled |
| GPIO/interrupts | Ports B/C/D, external interrupts, pin-change interrupts, interrupt flags/masks, vector dispatch and acknowledgement |
| Timers | Timer0/1/2, CTC, PWM, Timer1 input capture, comparator capture, Timer2 asynchronous 32.768 kHz `TOSC` mode |
| Serial/buses | Timed USART TX/RX, 2-level RX FIFO, `DOR0` overrun, 9-bit/synchronous/MSPIM modes, SPI master/slave, TWI/I2C master/slave |
| Analog/peripherals | ADC, internal ADC channels, analog comparator, EEPROM, watchdog, CLKPR clock prescaler, PRR power reduction |
| Chip tier | Fuses, lock bits, `MCUSR` reset sources, CKDIV8, BOOTRST/BOOTSZ, WDTON, EESAVE, IVSEL vector relocation, brown-out reset injection |
| Flash/self-programming | `SPMCSR`, page buffer fill, page erase/write, RWWSB/RWWSRE, boot-lock enforcement, fuse/lock/signature reads through `LPM`, `SPM_READY` |
| Sleep/wake | Six sleep modes with timer clock-domain gating, ADC noise-reduction entry, async Timer2 in power-save/extended-standby, wake sources and wake latency |
| Runtime | Public facade, events, serial text/bytes, pin/PWM/analog handles, EEPROM/SPI/TWI handles, snapshot/restore, debugger/watchpoints, browser worker runtime |

The exact behavioral limits are tracked in
[docs/limitations.md](docs/limitations.md). That file is intentionally part of
the product: if a register or vector is not modeled, it must be documented and
the machine-checked matrix must agree.

## Fidelity Compared With avr8js

avr8js is fast, widely deployed, and very good for the Arduino-class tier:
timers, ADC, GPIO, EEPROM, watchdog, USART, SPI, TWI, and common sketch
execution. avrts targets the next layer down: the chip behavior that bootloaders,
low-power firmware, self-programming code, and register-level tests depend on.

As of the installed `avr8js` 0.21.0 dev dependency in this repository:

| Behavior | avr8js 0.21.0 | avrts |
| --- | --- | --- |
| `SPM` | Instruction exists, but the CPU core marks it `not implemented` | Flash page fill/erase/write, RWWSB/RWWSRE, lock bits, `SPM_READY`, Optiboot programming |
| `SLEEP` | Instruction exists, but the CPU core marks it `not implemented` | Six sleep modes, clock-domain gating, wake sources, wake latency |
| Bootloader flow | No fuse/BOOTRST/SPM tier for stock Optiboot programming | Boots stock Optiboot and flashes a sketch over simulated STK500v1 |
| Fuses/lock bits/reset sources | Not modeled as a chip tier | CKDIV8, BOOTRST/BOOTSZ, WDTON, EESAVE, lock bits, `MCUSR`, external/brown-out/watchdog reset |
| Analog comparator | No packaged comparator peripheral | `ACSR`, interrupts, ACIC to Timer1 input capture, simavr oracle row |
| Timer2 async | No `ASSR.AS2` / 32.768 kHz `TOSC` model | Async Timer2 with busy flags and long-run drift validation |
| PRR | No power-reduction peripheral | Gates modeled peripheral clocks |
| USART RX | Application-friendly serial delivery | Frame-time pacing, 2-level FIFO, `DOR0`, frame/parity status injection |
| Validation | Project tests and large real-world ecosystem exposure | Bun tests plus native simavr timing, result, and Optiboot oracles |
| Speed | Often faster on compute-heavy real sketches | Usually faster than realtime; host-bound bitbang can fall below it, and arithmetic/string/ISR workloads may trail avr8js |

The honest one-line version: **avrts is the more realistic ATmega328P chip
simulator; avr8js is the faster and more battle-tested application-level
simulator.**

## Validation

Core checks:

```bash
bun run verify
```

Production package checks:

```bash
bun run build:lib       # ESM bundles + declaration maps
bun run package:smoke   # pack/install/import in Node, Bun, and a browser bundle
bun run release:check   # core + browser E2E + package gates
```

Native simavr oracles:

```bash
bun run oracle:simavr:timing    # USART/SPI/TWI timing, Timer2 async, comparator
bun run oracle:simavr:result    # final-state fixtures against native simavr
bun run oracle:simavr:optiboot  # stock Optiboot STK500v1 programming flow
```

Benchmark and result checks:

```bash
bun run bench:result
bun run bench:compare -- --repeats 3 --isolate
```

The current benchmark policy is documented in
[docs/performance-summary.md](docs/performance-summary.md) and
[docs/benchmark-plan.md](docs/benchmark-plan.md). Speed claims should use
isolated runs because production normally runs one firmware per simulator
instance.

## Browser Runtime

Import worker/circuit helpers from `@hdevlop/avrts/browser`. The packaged runtime includes
`browser-worker.js`; bundlers that do not preserve package-relative worker URLs
can pass an explicitly constructed `Worker` through the `worker` option, as the
demo does.

The browser example uses only public facade/runtime APIs and runs the core in a
Web Worker:

```bash
bun run demo
```

It includes program upload, run/pause/resume/reset, single-step, breakpoints,
watchpoints, serial monitor, snapshot/restore, draggable LED/button/PWM widgets,
and pin wiring. See
[examples/browser-simulator/README.md](examples/browser-simulator/README.md).

## Example Fixtures

Checked-in firmware fixtures live under [examples/](examples/):

| Fixture family | What it proves |
| --- | --- |
| Arduino Serial / SoftwareSerial | TX text, RX pacing, `Serial.available()`, host input |
| Arduino Wire / SPI | Firmware master paths plus host-side slave/master testing |
| Arduino Servo / tone / PWM | Timer-driven output visible through facade handles |
| LowPower-style WDT sleep | `SLEEP`, watchdog wake, sleep-state snapshot/restore |
| Timer2 async RTC | 32.768 kHz `TOSC` drift behavior |
| Comparator oracle | `ACSR`, comparator interrupt, ACIC -> Timer1 capture |
| Optiboot | BOOTRST, boot section, USART RX pacing, `SPM`, flash write |
| Benchmark fixtures | Mixed peripherals, ISR churn, strings, fixed DSP, float math, bitbang CRC |

## Non-Goals

avrts models AVR-visible logical behavior. It does not try to be a circuit
solver or a physics simulator.

Permanent non-goals:

- debugWIRE and on-chip debug hardware.
- Electrical analog effects such as rise time, drive strength, bus contention,
  capacitance, leakage, noise, and temperature drift.
- Exact current consumption in microamps.
- Flash wear and exact millisecond erase/write latency.
- Multi-master physical-wire arbitration beyond documented host injection hooks.

When avrts intentionally approximates something, the row belongs in
[docs/limitations.md](docs/limitations.md), not in someone's memory.
