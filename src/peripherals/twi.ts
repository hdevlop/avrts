import { OnWrite } from "../core";
import {
  TWBR,
  TWAMR,
  TWAR,
  TWCR,
  TWDR,
  TWEA,
  TWGCE,
  TWEN,
  TWIE,
  TWINT,
  TWPS0,
  TWPS1,
  TWI_VECTOR,
  TWSR,
  TWSTA,
  TWSTO,
  TWWC,
} from "../cpu";
import type { CPU } from "../cpu";
import type { TwiSnapshot } from "../snapshot";
import type { TwiMasterHandle, TwiSlave } from "./types";

// TWI status codes (upper 5 bits of TWSR).
const STATUS = {
  START: 0x08,
  REP_START: 0x10,
  MT_SLA_ACK: 0x18,
  MT_SLA_NACK: 0x20,
  MT_DATA_ACK: 0x28,
  MT_DATA_NACK: 0x30,
  MR_SLA_ACK: 0x40,
  MR_SLA_NACK: 0x48,
  MR_DATA_ACK: 0x50,
  MR_DATA_NACK: 0x58,
  SR_SLA_ACK: 0x60,
  SR_ARB_LOST_SLA_ACK: 0x68,
  SR_GCALL_ACK: 0x70,
  SR_ARB_LOST_GCALL_ACK: 0x78,
  SR_DATA_ACK: 0x80,
  SR_DATA_NACK: 0x88,
  SR_GCALL_DATA_ACK: 0x90,
  SR_GCALL_DATA_NACK: 0x98,
  SR_STOP: 0xa0,
  ST_SLA_ACK: 0xa8,
  ST_ARB_LOST_SLA_ACK: 0xb0,
  ST_DATA_ACK: 0xb8,
  ST_DATA_NACK: 0xc0,
  ST_LAST_DATA_ACK: 0xc8,
  ARB_LOST: 0x38,
  IDLE: 0xf8,
} as const;

type PendingTwiOperation =
  | "start"
  | "stop"
  | "transfer"
  | "slaveAddress"
  | "slaveWrite"
  | "slaveRead"
  | "slaveStop"
  | "slaveRestart"
  | "arbitrationLost";

type SlaveAddressMatch = "own" | "generalCall";

/**
 * Byte-level TWI (I2C) master/slave. It drives the status-code state machine the
 * Arduino Wire library expects: START -> SLA+R/W -> data -> STOP. Connect virtual
 * slaves with `connect(address, slave)`, or drive this AVR through `master()`.
 * Arbitration loss is host-injected; wire contention and analog bus effects
 * are not modeled, but AVR-visible operation timing is.
 */
export class Twi {
  private readonly slaves = new Map<number, TwiSlave>();
  private readonly hostMaster: TwiMasterHandle = {
    start: (address, read = false) => this.hostStart(address, read),
    restart: () => this.hostRestart(),
    write: (byte) => this.hostWrite(byte),
    read: (ack = true) => this.hostRead(ack),
    stop: () => this.hostStop(),
    injectArbitrationLost: (address, read = false) => this.hostInjectArbitrationLost(address, read),
  };
  private current?: TwiSlave;
  private currentAddress: number | null = null;
  private started = false;
  private awaitingAddress = false;
  private reading = false;
  private slaveActive = false;
  private slaveTransmitting = false;
  private slaveGeneralCall = false;
  private pendingHostAddress = 0;
  private pendingHostRead = false;
  private pendingHostGeneralCall = false;
  private pendingHostByte = 0;
  private pendingHostAck = false;
  private pendingArbitrationLost = false;
  private pendingOperation: PendingTwiOperation | null = null;
  private powerReduced = false;
  private frozenOperationRemainingCycles = 0;
  private readonly onOperationCompleteEvent = (): void => {
    this.completePendingOperation();
  };

  constructor(private readonly cpu: CPU) {
    this.reset();
  }

  reset(): void {
    this.powerReduced = false;
    this.frozenOperationRemainingCycles = 0;
    this.cpu.clearClockEvent(this.onOperationCompleteEvent);
    this.current = undefined;
    this.currentAddress = null;
    this.started = false;
    this.awaitingAddress = false;
    this.reading = false;
    this.clearSlaveState();
    this.pendingOperation = null;
    this.cpu.data[TWSR] = STATUS.IDLE;
  }

  /** Attach a virtual slave at a 7-bit address. */
  connect(address: number, slave: TwiSlave): void {
    this.slaves.set(address & 0x7f, slave);
  }

  /** Host-side external master that can drive this AVR when firmware enables slave mode. */
  master(): TwiMasterHandle {
    return this.hostMaster;
  }

  @OnWrite(TWCR)
  onWriteTwcr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    value = (value & ~((1 << TWWC) | (1 << 1))) | (oldValue & (1 << TWWC));
    if ((value & (1 << TWEN)) === 0) {
      this.cpu.clearClockEvent(this.onOperationCompleteEvent);
      this.pendingOperation = null;
      this.started = false;
      this.awaitingAddress = false;
      this.current = undefined;
      this.currentAddress = null;
      this.clearSlaveState();
      this.cpu.data[TWCR] = value & ~(1 << TWINT);
    } else if (this.pendingOperation !== null) {
      const pendingCommandBits = oldValue & ((1 << TWSTA) | (1 << TWSTO));
      this.cpu.data[TWCR] = (value & ~((1 << TWINT) | (1 << TWSTA) | (1 << TWSTO))) | pendingCommandBits;
    } else if ((value & (1 << TWINT)) === 0) {
      // Only writing one to TWINT clears it and starts the next operation.
      this.cpu.data[TWCR] = value | (oldValue & (1 << TWINT));
    } else if ((value & (1 << TWSTA)) !== 0) {
      this.scheduleOperation("start", value, 1);
    } else if (this.started && (value & (1 << TWSTO)) !== 0) {
      this.scheduleOperation("stop", value, 1);
    } else if (this.started) {
      this.scheduleOperation("transfer", value, this.sclCycles() * 9);
    } else {
      this.cpu.data[TWCR] = value & ~((1 << TWINT) | (1 << TWSTA) | (1 << TWSTO));
    }
    this.updateInterrupt();
  }

  @OnWrite(TWSR)
  onWriteTwsr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.cpu.data[TWSR] = (oldValue & 0xf8) | (value & 0x03);
  }

  @OnWrite(TWAMR)
  onWriteTwamr(): void {
    this.cpu.data[TWAMR] = this.cpu.data[TWAMR]! & 0xfe;
  }

  @OnWrite(TWDR)
  onWriteTwdr(_cpu: CPU, _addr: number, _value: number, oldValue: number): void {
    if ((this.cpu.data[TWCR]! & (1 << TWINT)) === 0) {
      this.cpu.data[TWDR] = oldValue;
      this.cpu.data[TWCR] = this.cpu.data[TWCR]! | (1 << TWWC);
    } else {
      this.cpu.data[TWCR] = this.cpu.data[TWCR]! & ~(1 << TWWC);
    }
  }

  private hostStart(address: number, read: boolean): boolean {
    this.assertHostCanDrive("start");
    if (this.slaveActive) {
      throw new Error("TWI host master cannot address a new slave before stop().");
    }
    const normalizedAddress = address & 0x7f;
    const match = this.matchSlaveAddress(normalizedAddress, read);
    if (match === null) return false;
    this.pendingHostAddress = normalizedAddress;
    this.pendingHostRead = read;
    this.pendingHostGeneralCall = match === "generalCall";
    this.scheduleOperation("slaveAddress", this.cpu.readData(TWCR), this.sclCycles() * 9);
    return true;
  }

  private hostRestart(): void {
    this.assertHostCanDrive("restart");
    if (!this.slaveActive) {
      throw new Error("TWI host master restart requires an addressed slave.");
    }
    this.scheduleOperation("slaveRestart", this.cpu.readData(TWCR), 1);
  }

  private hostWrite(byte: number): void {
    this.assertHostCanDrive("write");
    if (!this.slaveActive || this.slaveTransmitting) {
      throw new Error("TWI host master write requires an addressed slave receiver.");
    }
    this.pendingHostByte = byte & 0xff;
    this.scheduleOperation("slaveWrite", this.cpu.readData(TWCR), this.sclCycles() * 9);
  }

  private hostRead(ack: boolean): number {
    this.assertHostCanDrive("read");
    if (!this.slaveActive || !this.slaveTransmitting) {
      throw new Error("TWI host master read requires an addressed slave transmitter.");
    }
    this.pendingHostAck = ack;
    const byte = this.cpu.readData(TWDR) & 0xff;
    this.scheduleOperation("slaveRead", this.cpu.readData(TWCR), this.sclCycles() * 9);
    return byte;
  }

  private hostStop(): void {
    this.assertHostCanDrive("stop");
    if (!this.slaveActive) return;
    this.scheduleOperation("slaveStop", this.cpu.readData(TWCR), 1);
  }

  private hostInjectArbitrationLost(address: number | undefined, read: boolean): boolean {
    if (this.slaveActive) {
      throw new Error("TWI arbitration-loss injection is only valid while firmware owns the bus as master.");
    }

    this.cpu.clearClockEvent(this.onOperationCompleteEvent);
    this.pendingOperation = null;
    this.clearMasterState();

    if (address === undefined) {
      this.scheduleOperation("arbitrationLost", this.cpu.readData(TWCR), 1);
      return false;
    }

    const normalizedAddress = address & 0x7f;
    const match = this.matchSlaveAddress(normalizedAddress, read);
    if (match === null) {
      this.scheduleOperation("arbitrationLost", this.cpu.readData(TWCR), 1);
      return false;
    }

    this.pendingHostAddress = normalizedAddress;
    this.pendingHostRead = read;
    this.pendingHostGeneralCall = match === "generalCall";
    this.pendingArbitrationLost = true;
    this.scheduleOperation("slaveAddress", this.cpu.readData(TWCR), 1);
    return true;
  }

  private assertHostCanDrive(action: string): void {
    if (this.powerReduced) {
      throw new Error(`TWI host master cannot ${action} while TWI power is reduced (PRR.PRTWI set).`);
    }
    if (this.pendingOperation !== null) {
      throw new Error(`TWI host master cannot ${action} while another TWI operation is pending.`);
    }
    if (this.started || this.awaitingAddress || this.current !== undefined) {
      throw new Error(`TWI host master cannot ${action} during a firmware master transaction.`);
    }
    if ((this.cpu.readData(TWCR) & (1 << TWINT)) !== 0) {
      throw new Error(`TWI host master cannot ${action} until firmware clears TWINT.`);
    }
  }

  private matchSlaveAddress(address: number, read: boolean): SlaveAddressMatch | null {
    const twcr = this.cpu.readData(TWCR);
    if ((twcr & (1 << TWEN)) === 0 || (twcr & (1 << TWEA)) === 0) return null;
    const twar = this.cpu.readData(TWAR);
    if (!read && address === 0 && (twar & (1 << TWGCE)) !== 0) return "generalCall";
    const ownAddress = (twar >> 1) & 0x7f;
    const mask = (this.cpu.readData(TWAMR) >> 1) & 0x7f;
    return ((address ^ ownAddress) & ~mask) === 0 ? "own" : null;
  }

  private scheduleOperation(operation: PendingTwiOperation, value: number, cycles: number): void {
    this.pendingOperation = operation;
    this.cpu.data[TWCR] = value & ~(1 << TWINT);
    this.updateInterrupt();
    if (this.powerReduced) {
      this.frozenOperationRemainingCycles = cycles;
      return;
    }
    this.cpu.addClockEvent(this.onOperationCompleteEvent, cycles);
  }

  private completePendingOperation(): void {
    const operation = this.pendingOperation;
    this.pendingOperation = null;
    switch (operation) {
      case "start":
        this.doStart();
        break;
      case "stop":
        this.doStop();
        break;
      case "transfer":
        this.doTransfer();
        break;
      case "slaveAddress":
        this.doSlaveAddress();
        break;
      case "slaveWrite":
        this.doSlaveWrite();
        break;
      case "slaveRead":
        this.doSlaveRead();
        break;
      case "slaveStop":
        this.doSlaveStop();
        break;
      case "slaveRestart":
        this.doSlaveRestart();
        break;
      case "arbitrationLost":
        this.doArbitrationLost();
        break;
      default:
        break;
    }
  }

  private doStart(): void {
    const code = this.started ? STATUS.REP_START : STATUS.START;
    this.started = true;
    this.awaitingAddress = true;
    this.current = undefined;
    this.currentAddress = null;
    this.complete(code);
  }

  private doTransfer(): void {
    if (this.awaitingAddress) {
      this.addressSlave();
      return;
    }
    if (this.reading) {
      this.readByte();
      return;
    }
    this.writeByte();
  }

  private doStop(): void {
    this.clearMasterState({ notifyStop: true });
    this.cpu.data[TWSR] = (this.cpu.readData(TWSR) & 0x07) | STATUS.IDLE;
    // STOP clears TWSTO and does not set TWINT.
    this.cpu.data[TWCR] = this.cpu.readData(TWCR) & ~((1 << TWSTO) | (1 << TWINT));
    this.updateInterrupt();
  }

  private doSlaveAddress(): void {
    this.slaveActive = true;
    this.slaveTransmitting = this.pendingHostRead;
    this.slaveGeneralCall = this.pendingHostGeneralCall;
    const code = this.slaveAddressStatus();
    this.pendingArbitrationLost = false;
    this.complete(code);
  }

  private doSlaveWrite(): void {
    this.cpu.data[TWDR] = this.pendingHostByte & 0xff;
    const ackBack = (this.cpu.readData(TWCR) & (1 << TWEA)) !== 0;
    const code = this.slaveGeneralCall
      ? ackBack
        ? STATUS.SR_GCALL_DATA_ACK
        : STATUS.SR_GCALL_DATA_NACK
      : ackBack
        ? STATUS.SR_DATA_ACK
        : STATUS.SR_DATA_NACK;
    this.complete(code);
  }

  private doSlaveRead(): void {
    const ackReceived = this.pendingHostAck;
    const wantsMore = (this.cpu.readData(TWCR) & (1 << TWEA)) !== 0;
    const code = ackReceived ? (wantsMore ? STATUS.ST_DATA_ACK : STATUS.ST_LAST_DATA_ACK) : STATUS.ST_DATA_NACK;
    this.complete(code);
  }

  private doSlaveStop(): void {
    this.slaveActive = false;
    this.slaveTransmitting = false;
    this.slaveGeneralCall = false;
    this.complete(STATUS.SR_STOP);
  }

  private doSlaveRestart(): void {
    this.slaveActive = false;
    this.slaveTransmitting = false;
    this.slaveGeneralCall = false;
    this.complete(STATUS.SR_STOP);
  }

  private doArbitrationLost(): void {
    this.complete(STATUS.ARB_LOST);
  }

  private readByte(): void {
    const byte = this.current?.read?.() ?? 0xff;
    this.cpu.data[TWDR] = byte & 0xff;
    const ackBack = (this.cpu.readData(TWCR) & (1 << TWEA)) !== 0;
    this.complete(ackBack ? STATUS.MR_DATA_ACK : STATUS.MR_DATA_NACK);
  }

  private writeByte(): void {
    const outgoing = this.cpu.readData(TWDR);
    const ack = this.current ? (this.current.write?.(outgoing) ?? true) : false;
    this.complete(ack ? STATUS.MT_DATA_ACK : STATUS.MT_DATA_NACK);
  }

  private addressSlave(): void {
    const sla = this.cpu.readData(TWDR);
    const address = (sla >> 1) & 0x7f;
    this.reading = (sla & 1) === 1;
    this.current = this.slaves.get(address);
    this.currentAddress = this.current ? address : null;
    const ack = this.current ? (this.current.start?.(address, this.reading) ?? true) : false;
    this.awaitingAddress = false;
    this.complete(this.reading ? (ack ? STATUS.MR_SLA_ACK : STATUS.MR_SLA_NACK) : (ack ? STATUS.MT_SLA_ACK : STATUS.MT_SLA_NACK));
  }

  private complete(code: number): void {
    this.cpu.data[TWSR] = (this.cpu.readData(TWSR) & 0x07) | (code & 0xf8);
    // Operation done: TWINT reads back as 1; START flag is cleared by hardware.
    this.cpu.data[TWCR] = (this.cpu.readData(TWCR) & ~(1 << TWSTA)) | (1 << TWINT);
    this.updateInterrupt();
  }

  private updateInterrupt(): void {
    const mask = (1 << TWEN) | (1 << TWIE) | (1 << TWINT);
    if ((this.cpu.data[TWCR]! & mask) === mask) {
      this.cpu.requestInterrupt(TWI_VECTOR, () => this.acknowledgeInterrupt());
    } else {
      this.cpu.clearInterrupt(TWI_VECTOR);
    }
  }

  /** TWINT is not hardware-cleared on ISR entry: keep its request asserted. */
  acknowledgeInterrupt(): void {
    this.updateInterrupt();
  }

  private slaveAddressStatus(): number {
    if (this.pendingHostRead) {
      return this.pendingArbitrationLost ? STATUS.ST_ARB_LOST_SLA_ACK : STATUS.ST_SLA_ACK;
    }
    if (this.pendingHostGeneralCall) {
      return this.pendingArbitrationLost ? STATUS.SR_ARB_LOST_GCALL_ACK : STATUS.SR_GCALL_ACK;
    }
    return this.pendingArbitrationLost ? STATUS.SR_ARB_LOST_SLA_ACK : STATUS.SR_SLA_ACK;
  }

  private clearMasterState(options: { notifyStop?: boolean } = {}): void {
    if (options.notifyStop) this.current?.stop?.();
    this.current = undefined;
    this.currentAddress = null;
    this.started = false;
    this.awaitingAddress = false;
    this.reading = false;
  }

  private clearSlaveState(): void {
    this.slaveActive = false;
    this.slaveTransmitting = false;
    this.slaveGeneralCall = false;
    this.pendingHostAddress = 0;
    this.pendingHostRead = false;
    this.pendingHostGeneralCall = false;
    this.pendingHostByte = 0;
    this.pendingHostAck = false;
    this.pendingArbitrationLost = false;
  }

  private sclCycles(): number {
    const prescalerBits =
      (((this.cpu.data[TWSR]! >> TWPS1) & 1) << 1) | ((this.cpu.data[TWSR]! >> TWPS0) & 1);
    const prescaler = [1, 4, 16, 64][prescalerBits]!;
    return 16 + 2 * this.cpu.data[TWBR]! * prescaler;
  }

  private remainingCycles(): number {
    if (this.powerReduced && this.pendingOperation !== null) return this.frozenOperationRemainingCycles;
    return this.cpu.clockEventRemainingCycles(this.onOperationCompleteEvent);
  }

  setPowerReduced(reduced: boolean): void {
    if (this.powerReduced === reduced) return;
    if (reduced) {
      this.frozenOperationRemainingCycles = this.remainingCycles();
      this.powerReduced = true;
      this.cpu.clearClockEvent(this.onOperationCompleteEvent);
      return;
    }
    this.powerReduced = false;
    if (this.pendingOperation !== null) {
      const fallback = this.operationFallbackCycles(this.pendingOperation);
      this.cpu.addClockEvent(this.onOperationCompleteEvent, this.frozenOperationRemainingCycles || fallback);
    }
    this.frozenOperationRemainingCycles = 0;
  }

  private restorePendingOperation(
    operation: TwiSnapshot["pendingOperation"] | "address" | "write" | "read",
  ): PendingTwiOperation | null {
    if (operation === "address" || operation === "write" || operation === "read") return "transfer";
    return operation ?? null;
  }

  private operationFallbackCycles(operation: PendingTwiOperation): number {
    const oneCycle =
      operation === "start" ||
      operation === "stop" ||
      operation === "slaveStop" ||
      operation === "slaveRestart" ||
      operation === "arbitrationLost";
    return oneCycle ? 1 : this.sclCycles() * 9;
  }

  // --- Snapshot / restore (Phase 10) ---

  /** Capture TWI state-machine flags. Connected slaves are looked up by address on restore. */
  snapshot(): TwiSnapshot {
    return {
      started: this.started,
      awaitingAddress: this.awaitingAddress,
      reading: this.reading,
      currentAddress: this.currentAddress,
      pendingOperation: this.pendingOperation,
      remainingCycles: this.remainingCycles(),
      slaveActive: this.slaveActive,
      slaveTransmitting: this.slaveTransmitting,
      slaveGeneralCall: this.slaveGeneralCall,
      pendingHostAddress: this.pendingHostAddress,
      pendingHostRead: this.pendingHostRead,
      pendingHostGeneralCall: this.pendingHostGeneralCall,
      pendingHostByte: this.pendingHostByte,
      pendingHostAck: this.pendingHostAck,
      pendingArbitrationLost: this.pendingArbitrationLost,
    };
  }

  /**
   * Restore state-machine flags and re-resolve the slave by address. The
   * connected slaves themselves (user-supplied closures) are not serialized;
   * they must remain connected to the runtime via `avr.twi.connect(...)`.
   */
  restore(snap: TwiSnapshot): void {
    this.powerReduced = false;
    this.frozenOperationRemainingCycles = 0;
    this.started = snap.started;
    this.awaitingAddress = snap.awaitingAddress;
    this.reading = snap.reading;
    this.currentAddress = snap.currentAddress;
    this.current = snap.currentAddress === null ? undefined : this.slaves.get(snap.currentAddress);
    this.slaveActive = snap.slaveActive ?? false;
    this.slaveTransmitting = snap.slaveTransmitting ?? false;
    this.slaveGeneralCall = snap.slaveGeneralCall ?? false;
    this.pendingHostAddress = snap.pendingHostAddress ?? 0;
    this.pendingHostRead = snap.pendingHostRead ?? false;
    this.pendingHostGeneralCall = snap.pendingHostGeneralCall ?? false;
    this.pendingHostByte = snap.pendingHostByte ?? 0;
    this.pendingHostAck = snap.pendingHostAck ?? false;
    this.pendingArbitrationLost = snap.pendingArbitrationLost ?? false;
    this.pendingOperation = this.restorePendingOperation(snap.pendingOperation);
    this.cpu.clearClockEvent(this.onOperationCompleteEvent);
    if (this.pendingOperation !== null) {
      const fallback = this.operationFallbackCycles(this.pendingOperation);
      this.cpu.addClockEvent(this.onOperationCompleteEvent, snap.remainingCycles ?? fallback);
    }
    this.updateInterrupt();
  }
}
