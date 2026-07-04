/**
 * Shared peripheral types. Concrete peripherals (GPIO here, timers in Phase 6,
 * USART in Phase 7) live in this folder and register via @OnWrite.
 */

/** A logical Arduino port name. */
export type PortName = "B" | "C" | "D";

/** Listener for a raw AVR port-register value change (e.g. PORTB). */
export type PortChangeListener = (value: number, oldValue: number) => void;

/** Where an Arduino pin number lives on the chip. */
export interface PinInfo {
  port: PortName;
  bit: number;
}

/** Emitted when a digital pin's effective level changes. */
export interface PinChangeEvent {
  /** Arduino pin number. */
  pin: number;
  high: boolean;
  port: PortName;
  bit: number;
  /** Cumulative CPU cycles at the moment of the change. */
  cycles: number;
  /** Simulated milliseconds (cycles / clockHz). */
  timeMs: number;
}

export type SerialByteListener = (byte: number) => void;

export interface AnalogChannelHandle {
  read(): number;
  setValue(value: number): void;
  setVoltage(volts: number, referenceVolts?: number): void;
}

export interface AnalogComparatorHandle {
  setInput(input: "ain0" | "ain1", volts: number): void;
  readOutput(): boolean;
}

export type PwmChannel = "A" | "B";

export interface PwmSignal {
  channel: PwmChannel;
  enabled: boolean;
  inverted: boolean;
  duty: number;
  value: number;
  mode: "off" | "fast-pwm" | "phase-correct-pwm" | "other";
}

/** A timer that can drive PWM on its two compare channels (Timer0/1/2). */
export interface PwmSource {
  readPwm(channel: PwmChannel): PwmSignal;
  onPwmChange(channel: PwmChannel, listener: (signal: PwmSignal) => void): () => void;
}

/** Returns the byte clocked in on MISO in response to each MOSI byte sent. */
export interface SpiTransferMeta {
  bitOrder: "msb-first" | "lsb-first";
  mode: "master" | "slave";
}

export type SpiTransferResponder = (mosiByte: number, meta: SpiTransferMeta) => number;
export type SpiByteListener = (byte: number, meta: SpiTransferMeta) => void;

/** Host-side SPI master for driving firmware configured as an SPI slave. */
export interface SpiMasterHandle {
  /** Clock one byte into the simulated slave and return the byte it had loaded in SPDR. */
  transfer(byte: number): number;
}

/**
 * A virtual I²C slave the master can talk to. All callbacks are optional; a
 * connected slave with no `start` ACKs its address by default.
 */
export interface TwiSlave {
  /** Return true to ACK being addressed (`read` = true for SLA+R). */
  start?(address: number, read: boolean): boolean;
  /** Master wrote a byte; return true to ACK. */
  write?(byte: number): boolean;
  /** Provide the next byte for a master read. */
  read?(): number;
  /** Master issued STOP. */
  stop?(): void;
}

/** Host-side I2C master for driving firmware configured as a TWI slave. */
export interface TwiMasterHandle {
  /** Address the simulated AVR as a slave; returns false when it does not ACK. */
  start(address: number, read?: boolean): boolean;
  /** Send a repeated START condition to the currently addressed simulated slave. */
  restart(): void;
  /** Clock one byte from the host master into the simulated slave receiver. */
  write(byte: number): void;
  /** Clock one byte out of the simulated slave transmitter. */
  read(ack?: boolean): number;
  /** Send STOP to the addressed simulated slave. */
  stop(): void;
  /** Force the firmware master to lose arbitration; returns true when it is then addressed as a slave. */
  injectArbitrationLost(address?: number, read?: boolean): boolean;
}
