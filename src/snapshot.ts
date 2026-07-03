/**
 * Plain-data snapshot shape for the simulator. Every field is either a primitive,
 * a plain object, or a typed-array copy — no closures, no class instances, no
 * listener references. The composition is what `avr.snapshot()` returns; each
 * peripheral's own `snapshot()`/`restore()` operates on its slice.
 *
 * Per the project rules:
 * - Listeners belong to the runtime, not to snapshots.
 * - `restore()` may re-emit pin events if the restored state visibly differs.
 * - Serial/status UI refresh happens through the facade's `"restore"` event.
 * - EEPROM is part of the snapshot, even though normal `reset()` does not clear it.
 */

import type { AVRChip, AVRSpeed } from "./avr";
import type { PortName } from "./peripherals";

/** Per-port GPIO state: the injected PINx byte plus the timer-driven overrides. */
export interface GpioSnapshot {
  pin: Record<PortName, number>;
  peripheralMask: Record<PortName, number>;
  peripheralValue: Record<PortName, number>;
}

export interface Timer0Snapshot {
  prescalerRemainder: number;
}

export interface Timer1Snapshot {
  count: number;
  prescalerRemainder: number;
}

export interface Timer2Snapshot {
  prescalerRemainder: number;
}

export interface Usart0Snapshot {
  /** Queued host bytes waiting for firmware to read. */
  rxBytes: Uint8Array;
  rxHead: number;
  /** Byte currently being shifted out, null/undefined when TX is idle. */
  txShiftByte?: number | null;
  /** One-byte transmit buffer, null/undefined when the buffer is empty. */
  txBufferByte?: number | null;
  /** Remaining cycles for the current TX frame. */
  txRemainingCycles?: number;
}

export interface AdcSnapshot {
  /** 8 channels of 10-bit values, stored as 16-bit entries. */
  channels: Uint16Array;
  /** Physical voltage sources for channels configured through setVoltage(). */
  channelVoltages: Float64Array;
  /** 1 when channelVoltages[channel] is active, else channels[channel] is raw. */
  voltageEnabled: Uint8Array;
  remainingCycles: number;
  converting: boolean;
  triggerSource: number;
  triggerWasHigh: boolean;
}

export interface EepromSnapshot {
  cells: Uint8Array;
  /** Cycle at which EEMPE was last armed (-1 = not armed). */
  masterWriteCycle: number;
}

/**
 * The SPI responder is a user-supplied closure, so it is not part of the snapshot.
 * `restore()` resets to the default `() => 0xff`. The user must call
 * `avr.spi.respondWith(...)` again if they want a non-default responder.
 */
export interface SpiSnapshot {
  responderReset: true;
  busy?: boolean;
  pendingMosi?: number;
  remainingCycles?: number;
}

export interface TwiSnapshot {
  started: boolean;
  awaitingAddress: boolean;
  reading: boolean;
  /** Address of the slave currently being addressed (null = none). */
  currentAddress: number | null;
  pendingOperation?: "start" | "stop" | "transfer" | null;
  remainingCycles?: number;
}

export interface WatchdogSnapshot {
  accumulatedCycles: number;
}

export interface PcintSnapshot {
  /** Last-seen effective pin byte per port (used for edge detection). */
  snapshots: Record<PortName, number>;
}

export interface ExternalInterruptsSnapshot {
  /** Last-seen effective level of INT0 (PD2) and INT1 (PD3). */
  prevPinLevels: { int0: boolean; int1: boolean };
}

export interface CpuSnapshot {
  pc: number;
  cycles: number;
  sleeping: boolean;
  /** Copy of the flat data space (registers, I/O, SRAM). */
  data: Uint8Array;
  /** Copy of flash (16-bit words). */
  flash: Uint16Array;
  /** Pending interrupt vectors; acknowledge callbacks are dropped. */
  pendingInterrupts: number[];
}

export interface RuntimeSnapshot {
  clockHz: number;
  chip: AVRChip;
  speed: AVRSpeed;
  programSource: string | null;
  running: boolean;
  paused: boolean;
  serialText: string;
  timing: "fast" | "cycle-exact";
}

/** Top-level snapshot returned by `avr.snapshot()`. */
export interface AVRSnapshot {
  cpu: CpuSnapshot;
  runtime: RuntimeSnapshot;
  gpio: GpioSnapshot;
  timer0: Timer0Snapshot;
  timer1: Timer1Snapshot;
  timer2: Timer2Snapshot;
  usart0: Usart0Snapshot;
  adc: AdcSnapshot;
  eeprom: EepromSnapshot;
  spi: SpiSnapshot;
  twi: TwiSnapshot;
  watchdog: WatchdogSnapshot;
  pcint: PcintSnapshot;
  exti: ExternalInterruptsSnapshot;
}
