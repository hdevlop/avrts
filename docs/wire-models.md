# Logical wire and clock models

The byte APIs remain the default. Enable a pin model while its peripheral is
idle; changing modes during a frame/transaction throws. GPIO listeners and bus
connections belong to the runtime. Snapshots preserve driver ownership, data,
bit position, clock deadlines and error state; restore does not serialize callbacks.

```ts
import { AVR, createTwiBus } from "@hdevlop/avrts";

const avr = AVR();
avr.serial.useWire(); // TXD pin 1, RXD pin 0, XCK pin 4
avr.spi.useWire();    // MOSI 11, MISO 12, SCK 13, SS 10
avr.twi.useWire();    // SDA 18, SCL 19; host levels provide logical pull-ups
avr.pin(18).setInput(true);
avr.pin(19).setInput(true);

avr.timer2Clock.setFrequency(null); // explicit EXCLK edges
// Firmware must select ASSR.AS2 and ASSR.EXCLK.
avr.timer2Clock.setInput(false);
avr.timer2Clock.setInput(true);     // one rising source edge
avr.timer2Clock.setFrequency(32768); // restore an automatic logical source

avr.gpio.useInterruptSynchronization();
avr.comparator.setTiming({ propagationCycles: 2, settlingCycles: 4 });

const bus = createTwiBus();
const master = AVR();
const slave = AVR();
const disconnectMaster = bus.connect(master);
const disconnectSlave = bus.connect(slave);
// Configure firmware TWEN/TWAR/TWEA and advance both clocks from the host.
for (let i = 0; i < 100; i++) {
  master.runCycles(1);
  slave.runCycles(1);
}
disconnectMaster();
disconnectSlave();
```

USART wire TX emits a start bit, 5-9 LSB-first data bits, optional even/odd parity
and one/two stop bits. RX majority-votes three samples around each bit center,
rejects a false start and derives FE/UPE before delivery to the existing FIFO.
Synchronous USART uses XCK, external when DDRD4 is clear and generated when it
is set. MSPIM uses eight data bits, UCPOL/UCPHA and UDORD. Legacy byte listeners
still run on completed TX. Host byte injection/responders are bypassed or rejected
in wire mode. Configure the frame before starting a transfer.

SPI uses CPOL/CPHA and DORD, with one master edge each half SCK period. Slave
clocks come from SCK changes. Master MOSI/SCK and slave MISO respect DDRB;
master MISO and slave MOSI/SCK/SS are inputs. SS high releases slave MISO and
aborts a partial byte. SPDR collisions preserve the in-flight shift value.
Serial pin ownership takes precedence over timer output on shared pins.

TWI is open-drain: a zero dominates a released line. A master waits for the
resolved SCL high level before sampling each bit. A transmitted one sampled
as zero loses arbitration; master reception supplies ACK/NACK on the ninth
clock. Slave address/data completion sets TWINT and holds SCL low until firmware
clears TWINT. `readDrive()`/`onDrive()` expose driver intent for custom host buses;
pin level alone cannot distinguish a local release from another device's low.
`createTwiBus()` resolves those intents and resynchronizes on restore. The caller
coordinates endpoint clocks; the bus does not run their CPUs automatically.

Timer2's default asynchronous source is 32768 Hz. A positive host frequency
preserves fractional source/divider phase and pending write progress. A manual
source advances only on rising edges with AS2+EXCLK; register writes transfer
after two source edges. Switching AS2 (or manual EXCLK selection) discards
unfinished register transfers as the documented deterministic undefined-state
policy. PRR leaves AS2 running; power-down/standby pause the source. Async
PSRASY resets at the next source edge and remains asserted until then. CPU
flag clears acknowledge into the timer domain at that edge; sleeping before
acknowledgement can produce a repeated wake. These crossing latencies are
deterministic policies, not measured hardware values.

Interrupt synchronization is optional and uses the next I/O sample plus two
pipeline clocks; low-level wake stays asynchronous. Comparator delays are
nonnegative integer CPU clocks, with zero preserving the immediate model.
Pending propagation is cancelled in deep sleep; wake applies settling to held
inputs. DIDR suppresses firmware PIN reads without replacing analog inputs.

`useOscillatorCalibration(curve)` accepts 256 positive frequencies indexed by
OSCCAL. It applies only for internal RC CKSEL=2, preserves CLKPR and is copied
into snapshots. Without a table OSCCAL remains storage. The host must supply an
appropriate measured or chosen curve; the simulator does not invent one.
Pass `useOscillatorCalibration(curve, { resetCode: 128 })` to model the chip's
factory calibration byte. The supplied code is loaded immediately and on every
reset, and survives snapshots. Omitting it retains the default reset code of 0.

The [standard ATmega328P datasheet](https://ww1.microchip.com/downloads/en/DeviceDoc/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf)
defines the register/frame/pin rules. Regression tests exercise both execution
modes. Physical propagation, oscillator drift/startup, electrical contention,
noise, power consumption and wear are not calibrated by these logical models.
