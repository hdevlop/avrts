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

/** Format version written by `avr.snapshot()`; `restore()` rejects newer ones. */
export const AVR_SNAPSHOT_VERSION = 1;

/** Per-port GPIO state: the injected PINx byte plus the timer-driven overrides. */
export interface GpioSnapshot {
  pin: Record<PortName, number>;
  peripheralMask: Record<PortName, number>;
  peripheralValue: Record<PortName, number>;
}

export interface Timer0Snapshot {
  prescalerRemainder: number;
  /** Full divider phase for independently constructed Timer0 instances. */
  prescalerPhase?: number;
  countingDown?: boolean;
  activeOcrA?: number;
  activeOcrB?: number;
  compareBlocked?: boolean;
}

export interface Timer1Snapshot {
  count: number;
  /** Full divider phase for independently constructed Timer1 instances. */
  prescalerPhase?: number;
  /** Shared high-byte TEMP latch, including incomplete CPU accesses. */
  tempHigh?: number;
  /** Active comparator words; CPU data retains the pending PWM buffers. */
  activeOcrA?: number;
  activeOcrB?: number;
  /** A committed TCNT1 write suppresses the next timer-clock compare. */
  compareBlocked?: boolean;
  /** Timer1 dual-slope PWM direction, when running an up/down WGM mode. */
  countingDown?: boolean;
  prescalerRemainder: number;
  /** Remaining cycles of a noise-canceler-delayed input capture (0 = none). */
  captureDelayRemaining?: number;
  captureInputHigh?: boolean;
  filteredCaptureHigh?: boolean;
}

export interface Timer2Snapshot {
  prescalerRemainder: number;
  /** Full ten-bit divider phase in CPU cycles, including partial TOSC periods. */
  dividerPhase?: number;
  countingDown?: boolean;
  activeOcrA?: number;
  activeOcrB?: number;
  compareBlocked?: boolean;
  /** ASSR update-busy bits (TCN2UB..TCR2BUB) still latching. */
  asyncBusyMask?: number;
  /** Remaining cycles until the pending async register updates latch. */
  asyncBusyRemaining?: number;
  /** Phase within a TOSC period, in CPU cycles at the snapshot's clock rate. */
  toscPhase?: number;
  /** Separate register transfers; omitted values preserve legacy busy windows. */
  asyncWrites?: { register: number; value?: number; remainingCycles: number }[];
  /** CPU-visible TCNT2 retained on asynchronous power-save entry. */
  asyncSleepCounter?: number;
  /** Remaining CPU cycles of the post-wake read synchronization window. */
  asyncWakeReadRemaining?: number;
}

export interface Usart0Snapshot {
  /** Legacy: pending RX bytes without frame metadata (kept for old snapshots). */
  rxBytes: Uint8Array;
  rxHead: number;
  /** Byte currently being shifted out, null/undefined when TX is idle. */
  txShiftByte?: number | null;
  /** One-byte transmit buffer, null/undefined when the buffer is empty. */
  txBufferByte?: number | null;
  /** Remaining cycles for the current TX frame. */
  txRemainingCycles?: number;
  /** Encoded frames (9 data bits + error flags) in the 2-level receive FIFO. */
  rxFifo?: number[];
  /** Encoded frame currently crossing the wire, null when RX is idle. */
  rxShiftFrame?: number | null;
  /** Remaining cycles for the in-flight RX frame. */
  rxRemainingCycles?: number;
  /** Encoded frames still queued on the host side of the wire. */
  rxWire?: number[];
  /** Data-overrun (DOR0) latched and not yet cleared by a UDR0 read. */
  rxOverrun?: boolean;
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
  /** Whether the next conversion needs the 25-clock ADC initialization. */
  firstConversion?: boolean;
  /** Channel/reference selection latched for the in-flight conversion. */
  conversionMux?: number;
  /** ADCL was read without the matching ADCH read. */
  resultLocked?: boolean;
  /** Remaining CPU cycles until the in-flight input is sampled. */
  sampleRemainingCycles?: number;
  /** Input held for the in-flight conversion; null before sample-and-hold. */
  sampledResult?: number | null;
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
  pendingMode?: "master" | "slave" | null;
  remainingCycles?: number;
  spifClearArmed?: boolean;
  receivedByte?: number | null;
}

export interface ClockControlSnapshot {
  unlocked: boolean;
  remainingCycles?: number;
}

export interface ChipControlSnapshot {
  ivUnlocked: boolean;
  ivUnlockRemaining?: number;
  bodUnlocked: boolean;
  bodUnlockRemaining?: number;
}

export interface SelfProgrammingSnapshot {
  pageBuffer: Uint16Array;
  pendingOperation?: "erase" | "write" | "lock" | "rww" | null;
  pendingPageBase?: number;
  pendingLockValue?: number;
  pendingRemainingCycles?: number;
  commandClearRemainingCycles?: number;
}

export interface AnalogComparatorSnapshot {
  ain0Volts: number;
  ain1Volts: number;
  output: boolean;
  initialized: boolean;
}

export interface TwiSnapshot {
  started: boolean;
  awaitingAddress: boolean;
  reading: boolean;
  /** Address of the slave currently being addressed (null = none). */
  currentAddress: number | null;
  pendingOperation?:
    | "start"
    | "stop"
    | "transfer"
    | "slaveAddress"
    | "slaveWrite"
    | "slaveRead"
    | "slaveStop"
    | "slaveRestart"
    | "arbitrationLost"
    | null;
  remainingCycles?: number;
  slaveActive?: boolean;
  slaveTransmitting?: boolean;
  slaveGeneralCall?: boolean;
  pendingHostAddress?: number;
  pendingHostRead?: boolean;
  pendingHostGeneralCall?: boolean;
  pendingHostByte?: number;
  pendingHostAck?: boolean;
  pendingArbitrationLost?: boolean;
}

export interface WatchdogSnapshot {
  accumulatedCycles: number;
  changeWindowRemainingCycles?: number;
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
  /** SEI/RETI deferral when captured before the instruction's dispatch boundary. */
  interruptDeferred?: boolean;
  /** Boot-vector offset applied to pending interrupt vectors. */
  interruptVectorBase?: number;
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
  /** Undivided clock configured by useClock(); CLKPR derives clockHz from this. */
  baseClockHz?: number;
  chip: AVRChip;
  speed: AVRSpeed;
  programSource: string | null;
  running: boolean;
  paused: boolean;
  serialText: string;
  timing: "fast" | "cycle-exact";
  fuses?: {
    low: number;
    high: number;
    extended: number;
    lockBits: number;
  };
  /** Bitmask of fuse bytes explicitly configured by host code; older snapshots omit it. */
  configuredFuseMask?: number;
  /**
   * Simulated time (ms) accumulated up to `timeBaseCycles`, so clock-prescaler
   * changes do not rescale past time. Older snapshots omit both fields.
   */
  timeBaseMs?: number;
  timeBaseCycles?: number;
}

/** Top-level snapshot returned by `avr.snapshot()`. */
export interface AVRSnapshot {
  /**
   * Snapshot format version (`AVR_SNAPSHOT_VERSION` when written). Snapshots
   * from before versioning omit it and are restored as version 0.
   */
  version?: number;
  cpu: CpuSnapshot;
  runtime: RuntimeSnapshot;
  gpio: GpioSnapshot;
  timer0: Timer0Snapshot;
  timer1: Timer1Snapshot;
  timer2: Timer2Snapshot;
  /** Shared free-running Timer0/1 divider phase; absent in older snapshots. */
  timerPrescaler?: { phase: number };
  usart0: Usart0Snapshot;
  adc: AdcSnapshot;
  eeprom: EepromSnapshot;
  spi: SpiSnapshot;
  clock?: ClockControlSnapshot;
  chip?: ChipControlSnapshot;
  spm?: SelfProgrammingSnapshot;
  comparator?: AnalogComparatorSnapshot;
  twi: TwiSnapshot;
  watchdog: WatchdogSnapshot;
  pcint: PcintSnapshot;
  exti: ExternalInterruptsSnapshot;
}
