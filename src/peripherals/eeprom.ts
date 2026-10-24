import { OnWrite } from "../core";
import {
  EEARH,
  EEARL,
  EECR,
  EEDR,
  EEMPE,
  EEPE,
  EE_READY_VECTOR,
  EEPROM_SIZE,
  EERE,
  EERIE,
  SELFPRGEN,
  SPMCSR,
} from "../cpu";
import type { CPU } from "../cpu";
import { WallClockTimer } from "./wall-clock-timer";
import type { EepromSnapshot } from "../snapshot";

/** Firmware programming uses deterministic typical RC timing; host storage helpers stay immediate. */
export class Eeprom {
  private readonly cells = new Uint8Array(EEPROM_SIZE);
  // Cycle at which EEMPE was last armed (-1 = not armed). EEMPE stays valid for a
  // short window, after which a write to EEPE no longer starts a write.
  private masterWriteCycle = -1;
  private readonly expireMasterWriteEvent = (): void => {
    this.masterWriteCycle = -1;
    this.cpu.data[EECR] = this.cpu.data[EECR]! & ~(1 << EEMPE);
  };

  private pending: { address: number; value: number; mode: number } | undefined;
  private readonly programming: WallClockTimer;

  constructor(private readonly cpu: CPU, private readonly onReadyChange: () => void = () => {}) {
    this.programming = new WallClockTimer(cpu, () => this.complete());
  }

  setClock(hz: number): void { this.programming.setClock(hz); }

  private complete(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    const {address, value, mode} = pending;
    this.cells[address] = mode === 0 ? value : mode === 1 ? 0xff : this.cells[address]! & value;
    this.cpu.data[EECR] = this.cpu.data[EECR]! & ~(1 << EEPE);
    this.updateInterrupt();
    this.onReadyChange();
  }

  reset(): void {
    this.masterWriteCycle = -1;
    this.pending = undefined;
    this.programming.stop();
    this.cpu.clearClockEvent(this.expireMasterWriteEvent);
    // EEPROM contents are non-volatile; nothing to clear.
  }

  read(address: number): number {
    return this.cells[address & (EEPROM_SIZE - 1)]!;
  }

  write(address: number, value: number): void {
    this.cells[address & (EEPROM_SIZE - 1)] = value & 0xff;
  }

  /** Replace the whole EEPROM image (host/test helper). */
  load(data: Uint8Array | number[]): void {
    this.cells.fill(0);
    this.cells.set(Uint8Array.from(data).subarray(0, EEPROM_SIZE));
  }

  /** Snapshot the EEPROM image. */
  dump(): Uint8Array {
    return this.cells.slice();
  }

  /** Chip erase resets EEPROM bytes unless the EESAVE fuse preserves them. */
  erase(): void {
    this.cells.fill(0xff);
  }

  @OnWrite(EECR)
  onWriteEecr(_cpu: CPU, _addr: number, value: number, oldValue: number, mask = 0xff): void {
    if (this.pending) {
      // EEPE cannot be cleared by software; modes and address remain latched.
      this.cpu.data[EECR] = (oldValue & 0x30) | (1 << EEPE) | (value & (1 << EERIE));
      this.updateInterrupt();
      return;
    }
    const armed = this.masterWriteArmed();
    if ((mask & (1 << EEMPE)) !== 0) {
      this.cpu.clearClockEvent(this.expireMasterWriteEvent);
      this.masterWriteCycle = -1;
    }
    this.cpu.data[EECR] = value & 0x3f & ~((1 << EEPE) | (1 << EERE));
    const read = (value & mask & (1 << EERE)) !== 0;
    if (read) {
      this.cpu.data[EEDR] = this.cells[this.address()]!;
      this.cpu.stall(4);
    }
    if ((value & mask & (1 << EEMPE)) !== 0) {
      this.masterWriteCycle = this.cpu.cycles;
      this.cpu.addClockEvent(this.expireMasterWriteEvent, 4);
    }
    const mode = (value >> 4) & 3;
    if (!read && (value & mask & (1 << EEPE)) !== 0 && armed && mode !== 3 &&
        (this.cpu.data[SPMCSR]! & (1 << SELFPRGEN)) === 0) {
      this.pending = { address: this.address(), value: this.cpu.data[EEDR]!, mode };
      this.cpu.data[EECR] = (this.cpu.data[EECR]! | (1 << EEPE)) & ~(1 << EEMPE);
      this.masterWriteCycle = -1;
      this.cpu.clearClockEvent(this.expireMasterWriteEvent);
      this.programming.start(mode === 0 ? 3.4 : 1.8);
      this.cpu.stall(2);
    }
    this.updateInterrupt();
    this.onReadyChange();
  }

  @OnWrite(EEARL)
  @OnWrite(EEARH)
  onWriteAddress(_cpu: CPU, addr: number, _value: number, oldValue: number): void {
    if (this.pending) this.cpu.data[addr] = oldValue;
    if (addr === EEARH) this.cpu.data[EEARH] = this.cpu.data[EEARH]! & ((EEPROM_SIZE - 1) >> 8);
  }

  /** True while the EEMPE master-write window is still open (4-cycle hardware window). */
  private masterWriteArmed(): boolean {
    return this.masterWriteCycle >= 0 && this.cpu.cycles - this.masterWriteCycle < 4;
  }

  /** EEPROM-ready is a level request; SPM temporarily suppresses it. */
  updateInterrupt(): void {
    if ((this.cpu.data[EECR]! & ((1 << EERIE) | (1 << EEPE))) === (1 << EERIE) &&
        (this.cpu.data[SPMCSR]! & (1 << SELFPRGEN)) === 0) {
      this.cpu.requestInterrupt(EE_READY_VECTOR, () => this.updateInterrupt());
    } else {
      this.cpu.clearInterrupt(EE_READY_VECTOR);
    }
  }

  private address(): number {
    return ((this.cpu.readData(EEARH) << 8) | this.cpu.readData(EEARL)) & (EEPROM_SIZE - 1);
  }

  // --- Snapshot / restore (Phase 10) ---

  snapshot(): EepromSnapshot {
    return {
      cells: new Uint8Array(this.cells),
      masterWriteCycle: this.masterWriteCycle,
      pending: this.pending ? { ...this.pending, remainingMs: this.programming.remainingMs() } : undefined,
    };
  }

  restore(snap: EepromSnapshot): void {
    this.cells.set(snap.cells);
    this.masterWriteCycle = snap.masterWriteCycle;
    this.programming.stop();
    this.pending = snap.pending ? { address: snap.pending.address, value: snap.pending.value, mode: snap.pending.mode } : undefined;
    if (snap.pending) {
      this.cpu.data[EECR] = this.cpu.data[EECR]! | (1 << EEPE);
      this.programming.start(snap.pending.remainingMs);
    }
    this.cpu.clearClockEvent(this.expireMasterWriteEvent);
    if (this.masterWriteArmed()) {
      this.cpu.addClockEvent(this.expireMasterWriteEvent, 4 - (this.cpu.cycles - this.masterWriteCycle));
    } else {
      this.expireMasterWriteEvent();
    }
    this.updateInterrupt();
  }
}
