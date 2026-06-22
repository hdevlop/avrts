import { OnWrite } from "../core";
import { TWCR, TWDR, TWEA, TWEN, TWIE, TWINT, TWI_VECTOR, TWSR, TWSTA, TWSTO } from "../cpu";
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

/**
 * Minimal TWI (I²C) master. It drives the standard status-code state machine the
 * Arduino Wire library expects: START -> SLA+R/W -> data -> STOP. Connect virtual
 * slaves with `connect(address, slave)`. Slave/multi-master arbitration and real
 * bit timing are not modeled.
 */
export class Twi {
  private readonly slaves = new Map<number, TwiSlave>();
  private current?: TwiSlave;
  private currentAddress: number | null = null;
  private started = false;
  private awaitingAddress = false;
  private reading = false;

  constructor(private readonly cpu: CPU) {}

  reset(): void {
    this.current = undefined;
    this.currentAddress = null;
    this.started = false;
    this.awaitingAddress = false;
    this.reading = false;
    this.cpu.data[TWSR] = STATUS.IDLE;
  }

  /** Attach a virtual slave at a 7-bit address. */
  connect(address: number, slave: TwiSlave): void {
    this.slaves.set(address & 0x7f, slave);
  }

  @OnWrite(TWCR)
  onWriteTwcr(_cpu: CPU, _addr: number, value: number): void {
    if ((value & (1 << TWEN)) === 0) {
      this.cpu.data[TWCR] = value & ~(1 << TWINT);
      return;
    }
    // The operation runs only when firmware writes a 1 to TWINT (clearing it).
    if ((value & (1 << TWINT)) === 0) {
      this.cpu.data[TWCR] = value;
      return;
    }
    if ((value & (1 << TWSTA)) !== 0) {
      this.doStart(value);
    } else if ((value & (1 << TWSTO)) !== 0) {
      this.doStop(value);
    } else {
      this.doTransfer(value);
    }
  }

  private doStart(value: number): void {
    const code = this.started ? STATUS.REP_START : STATUS.START;
    this.started = true;
    this.awaitingAddress = true;
    this.current = undefined;
    this.currentAddress = null;
    this.complete(value, code);
  }

  private doStop(value: number): void {
    this.current?.stop?.();
    this.started = false;
    this.awaitingAddress = false;
    this.current = undefined;
    this.currentAddress = null;
    // STOP clears TWSTO and does NOT set TWINT.
    this.cpu.data[TWCR] = value & ~((1 << TWSTO) | (1 << TWINT));
  }

  private doTransfer(value: number): void {
    if (this.awaitingAddress) {
      this.addressSlave(value);
      return;
    }
    if (this.reading) {
      const byte = this.current?.read?.() ?? 0xff;
      this.cpu.data[TWDR] = byte & 0xff;
      const ackBack = (value & (1 << TWEA)) !== 0;
      this.complete(value, ackBack ? STATUS.MR_DATA_ACK : STATUS.MR_DATA_NACK);
      return;
    }
    const outgoing = this.cpu.readData(TWDR);
    const ack = this.current ? (this.current.write?.(outgoing) ?? true) : false;
    this.complete(value, ack ? STATUS.MT_DATA_ACK : STATUS.MT_DATA_NACK);
  }

  private addressSlave(value: number): void {
    const sla = this.cpu.readData(TWDR);
    const address = (sla >> 1) & 0x7f;
    this.reading = (sla & 1) === 1;
    this.current = this.slaves.get(address);
    this.currentAddress = this.current ? address : null;
    const ack = this.current ? (this.current.start?.(address, this.reading) ?? true) : false;
    this.awaitingAddress = false;
    if (this.reading) {
      this.complete(value, ack ? STATUS.MR_SLA_ACK : STATUS.MR_SLA_NACK);
    } else {
      this.complete(value, ack ? STATUS.MT_SLA_ACK : STATUS.MT_SLA_NACK);
    }
  }

  private complete(value: number, code: number): void {
    this.cpu.data[TWSR] = (this.cpu.readData(TWSR) & 0x07) | (code & 0xf8);
    // Operation done: TWINT reads back as 1; START flag is cleared by hardware.
    this.cpu.data[TWCR] = (value & ~(1 << TWSTA)) | (1 << TWINT);
    if ((this.cpu.readData(TWCR) & (1 << TWIE)) !== 0) {
      this.cpu.requestInterrupt(TWI_VECTOR);
    }
  }

  // --- Snapshot / restore (Phase 10) ---

  /** Capture TWI state-machine flags. Connected slaves are looked up by address on restore. */
  snapshot(): TwiSnapshot {
    return {
      started: this.started,
      awaitingAddress: this.awaitingAddress,
      reading: this.reading,
      currentAddress: this.currentAddress,
    };
  }

  /**
   * Restore state-machine flags and re-resolve the slave by address. The
   * connected slaves themselves (user-supplied closures) are not serialized —
   * they must remain connected to the runtime via `avr.twi.connect(...)`.
   */
  restore(snap: TwiSnapshot): void {
    this.started = snap.started;
    this.awaitingAddress = snap.awaitingAddress;
    this.reading = snap.reading;
    this.currentAddress = snap.currentAddress;
    this.current = snap.currentAddress === null ? undefined : this.slaves.get(snap.currentAddress);
  }
}
