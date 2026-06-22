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
export type SpiTransferResponder = (mosiByte: number) => number;

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
