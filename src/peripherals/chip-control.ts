import { OnWrite } from "../core";
import { BODSE, BODS, IVCE, IVSEL, MCUCR, MCUSR, PUD, SMCR } from "../cpu";
import type { CPU } from "../cpu";
import type { ChipControlSnapshot } from "../snapshot";

const PROTECTED_WINDOW_CYCLES = 4;
const IV_MASK = (1 << IVCE) | (1 << IVSEL);
const BOD_MASK = (1 << BODSE) | (1 << BODS);

/**
 * MCUCR-owned chip-level controls. This covers the timed IVCE/IVSEL vector
 * relocation protocol and the BOD sleep-disable handshake; reset/boot fuse
 * policy stays in the AVR facade because it owns the configured fuse bytes.
 */
export class ChipControl {
  private ivUnlocked = false;
  private bodUnlocked = false;

  private readonly ivLockEvent = (): void => {
    this.ivUnlocked = false;
    this.cpu.data[MCUCR] = this.cpu.data[MCUCR]! & ~(1 << IVCE);
  };

  private readonly bodLockEvent = (): void => {
    this.bodUnlocked = false;
    this.cpu.data[MCUCR] = this.cpu.data[MCUCR]! & ~BOD_MASK;
  };

  constructor(
    private readonly cpu: CPU,
    private readonly bootVectorBase: () => number,
  ) {}

  reset(): void {
    this.ivUnlocked = false;
    this.bodUnlocked = false;
    this.cpu.clearClockEvent(this.ivLockEvent);
    this.cpu.clearClockEvent(this.bodLockEvent);
    this.cpu.data[MCUCR] = 0;
    this.applyVectorBase();
  }

  @OnWrite(MCUCR)
  onWriteMcucr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    let next = oldValue & ((1 << IVSEL) | (1 << BODS));
    next = (next & ~(1 << PUD)) | (value & (1 << PUD));

    if ((value & (1 << IVCE)) !== 0) {
      this.ivUnlocked = true;
      this.cpu.addClockEvent(this.ivLockEvent, PROTECTED_WINDOW_CYCLES);
      next = (next & ~IV_MASK) | (oldValue & (1 << IVSEL)) | (1 << IVCE);
    } else if (this.ivUnlocked) {
      this.ivUnlocked = false;
      this.cpu.clearClockEvent(this.ivLockEvent);
      next = (next & ~IV_MASK) | (value & (1 << IVSEL));
    } else {
      next = (next & ~IV_MASK) | (oldValue & (1 << IVSEL));
    }

    if ((value & BOD_MASK) === BOD_MASK) {
      this.bodUnlocked = true;
      this.cpu.addClockEvent(this.bodLockEvent, PROTECTED_WINDOW_CYCLES);
      next = (next & ~BOD_MASK) | BOD_MASK;
    } else if (this.bodUnlocked) {
      this.bodUnlocked = false;
      this.cpu.clearClockEvent(this.bodLockEvent);
      next = (next & ~BOD_MASK) | (value & (1 << BODS));
    } else {
      next = (next & ~BOD_MASK) | (oldValue & (1 << BODS));
    }

    this.cpu.data[MCUCR] = next & 0xff;
    this.applyVectorBase();
  }

  @OnWrite(MCUSR)
  onWriteMcusr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    // Hardware sets reset causes; firmware may only clear them by writing zero.
    this.cpu.data[MCUSR] = oldValue & value & 0x0f;
  }

  @OnWrite(SMCR)
  onWriteSmcr(): void {
    this.cpu.data[SMCR] = this.cpu.data[SMCR]! & 0x0f;
  }

  snapshot(): ChipControlSnapshot {
    return {
      ivUnlocked: this.ivUnlocked,
      ivUnlockRemaining: this.cpu.clockEventRemainingCycles(this.ivLockEvent),
      bodUnlocked: this.bodUnlocked,
      bodUnlockRemaining: this.cpu.clockEventRemainingCycles(this.bodLockEvent),
    };
  }

  restore(snap: ChipControlSnapshot | undefined): void {
    this.cpu.clearClockEvent(this.ivLockEvent);
    this.cpu.clearClockEvent(this.bodLockEvent);
    this.ivUnlocked = snap?.ivUnlocked ?? false;
    this.bodUnlocked = snap?.bodUnlocked ?? false;
    if (this.ivUnlocked) {
      this.cpu.addClockEvent(this.ivLockEvent, snap?.ivUnlockRemaining ?? 1);
    } else {
      this.cpu.data[MCUCR] = this.cpu.data[MCUCR]! & ~(1 << IVCE);
    }
    if (this.bodUnlocked) {
      this.cpu.addClockEvent(this.bodLockEvent, snap?.bodUnlockRemaining ?? 1);
    } else {
      this.cpu.data[MCUCR] = this.cpu.data[MCUCR]! & ~(1 << BODSE);
    }
    this.applyVectorBase();
  }

  private applyVectorBase(): void {
    this.cpu.interruptVectorBase =
      (this.cpu.data[MCUCR]! & (1 << IVSEL)) !== 0 ? this.bootVectorBase() : 0;
  }
}
