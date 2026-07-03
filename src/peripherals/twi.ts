import { OnWrite } from "../core";
import {
  TWBR,
  TWCR,
  TWDR,
  TWEA,
  TWEN,
  TWIE,
  TWINT,
  TWPS0,
  TWPS1,
  TWI_VECTOR,
  TWSR,
  TWSTA,
  TWSTO,
} from "../cpu";
import type { CPU } from "../cpu";
import type { TwiSnapshot } from "../snapshot";
import type { TwiSlave } from "./types";

// Master-mode TWI status codes (upper 5 bits of TWSR).
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
  IDLE: 0xf8,
} as const;

type PendingTwiOperation = "start" | "stop" | "transfer";

/**
 * Minimal TWI (I2C) master. It drives the standard status-code state machine the
 * Arduino Wire library expects: START -> SLA+R/W -> data -> STOP. Connect virtual
 * slaves with `connect(address, slave)`. Slave/multi-master arbitration and
 * analog bus effects are not modeled, but AVR-visible operation timing is.
 */
export class Twi {
  private readonly slaves = new Map<number, TwiSlave>();
  private current?: TwiSlave;
  private currentAddress: number | null = null;
  private started = false;
  private awaitingAddress = false;
  private reading = false;
  private pendingOperation: PendingTwiOperation | null = null;
  private readonly onOperationCompleteEvent = (): void => {
    this.completePendingOperation();
  };

  constructor(private readonly cpu: CPU) {
    this.reset();
  }

  reset(): void {
    this.cpu.clearClockEvent(this.onOperationCompleteEvent);
    this.current = undefined;
    this.currentAddress = null;
    this.started = false;
    this.awaitingAddress = false;
    this.reading = false;
    this.pendingOperation = null;
    this.cpu.data[TWSR] = STATUS.IDLE;
  }

  /** Attach a virtual slave at a 7-bit address. */
  connect(address: number, slave: TwiSlave): void {
    this.slaves.set(address & 0x7f, slave);
  }

  @OnWrite(TWCR)
  onWriteTwcr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    if ((value & (1 << TWEN)) === 0) {
      this.cpu.clearClockEvent(this.onOperationCompleteEvent);
      this.pendingOperation = null;
      this.cpu.data[TWCR] = value & ~(1 << TWINT);
      return;
    }
    if (this.pendingOperation !== null) {
      const pendingCommandBits = oldValue & ((1 << TWSTA) | (1 << TWSTO));
      this.cpu.data[TWCR] = (value & ~((1 << TWINT) | (1 << TWSTA) | (1 << TWSTO))) | pendingCommandBits;
      return;
    }
    // The operation runs only when firmware writes a 1 to TWINT (clearing it).
    if ((value & (1 << TWINT)) === 0) {
      this.cpu.data[TWCR] = value;
      return;
    }
    if ((value & (1 << TWSTA)) !== 0) {
      this.scheduleOperation("start", value, 1);
    } else if ((value & (1 << TWSTO)) !== 0) {
      this.scheduleOperation("stop", value, 1);
    } else {
      this.scheduleOperation("transfer", value, this.sclCycles() * 9);
    }
  }

  private scheduleOperation(operation: PendingTwiOperation, value: number, cycles: number): void {
    this.pendingOperation = operation;
    this.cpu.data[TWCR] = value & ~(1 << TWINT);
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
    this.current?.stop?.();
    this.started = false;
    this.awaitingAddress = false;
    this.current = undefined;
    this.currentAddress = null;
    this.cpu.data[TWSR] = (this.cpu.readData(TWSR) & 0x07) | STATUS.IDLE;
    // STOP clears TWSTO and does not set TWINT.
    this.cpu.data[TWCR] = this.cpu.readData(TWCR) & ~((1 << TWSTO) | (1 << TWINT));
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
    if ((this.cpu.readData(TWCR) & (1 << TWIE)) !== 0) {
      this.cpu.requestInterrupt(TWI_VECTOR);
    }
  }

  private sclCycles(): number {
    const prescalerBits =
      (((this.cpu.data[TWSR]! >> TWPS1) & 1) << 1) | ((this.cpu.data[TWSR]! >> TWPS0) & 1);
    const prescaler = [1, 4, 16, 64][prescalerBits]!;
    return 16 + 2 * this.cpu.data[TWBR]! * prescaler;
  }

  private remainingCycles(): number {
    return this.cpu.clockEventRemainingCycles(this.onOperationCompleteEvent);
  }

  private restorePendingOperation(
    operation: TwiSnapshot["pendingOperation"] | "address" | "write" | "read",
  ): PendingTwiOperation | null {
    if (operation === "address" || operation === "write" || operation === "read") return "transfer";
    return operation ?? null;
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
    };
  }

  /**
   * Restore state-machine flags and re-resolve the slave by address. The
   * connected slaves themselves (user-supplied closures) are not serialized;
   * they must remain connected to the runtime via `avr.twi.connect(...)`.
   */
  restore(snap: TwiSnapshot): void {
    this.started = snap.started;
    this.awaitingAddress = snap.awaitingAddress;
    this.reading = snap.reading;
    this.currentAddress = snap.currentAddress;
    this.current = snap.currentAddress === null ? undefined : this.slaves.get(snap.currentAddress);
    this.pendingOperation = this.restorePendingOperation(snap.pendingOperation);
    this.cpu.clearClockEvent(this.onOperationCompleteEvent);
    if (this.pendingOperation !== null) {
      const fallback = this.pendingOperation === "transfer" ? this.sclCycles() * 9 : 1;
      this.cpu.addClockEvent(this.onOperationCompleteEvent, snap.remainingCycles ?? fallback);
    }
  }
}
