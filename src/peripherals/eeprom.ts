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
import type { EepromSnapshot } from "../snapshot";

/**
 * EEPROM model. Firmware reads by setting the address and EERE; writes by setting
 * EEMPE then EEPE. Both complete instantly here (no multi-ms write delay), which
 * keeps blocking `eeprom_write` loops moving. Contents persist across `reset()`,
 * like real EEPROM.
 */
export class Eeprom {
  private readonly cells = new Uint8Array(EEPROM_SIZE);
  // Cycle at which EEMPE was last armed (-1 = not armed). EEMPE stays valid for a
  // short window, after which a write to EEPE no longer starts a write.
  private masterWriteCycle = -1;
  private readonly expireMasterWriteEvent = (): void => {
    this.masterWriteCycle = -1;
    this.cpu.data[EECR] = this.cpu.data[EECR]! & ~(1 << EEMPE);
  };

  constructor(private readonly cpu: CPU) {}

  reset(): void {
    this.masterWriteCycle = -1;
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
  onWriteEecr(_cpu: CPU, _addr: number, value: number): void {
    const armed = this.masterWriteArmed();
    this.cpu.clearClockEvent(this.expireMasterWriteEvent);
    this.masterWriteCycle = -1;
    this.cpu.data[EECR] = value & 0x3f & ~((1 << EEPE) | (1 << EERE));
    if ((value & (1 << EERE)) !== 0) {
      this.cpu.data[EEDR] = this.cells[this.address()]!;
    }
    // EEMPE arms the master-write window. avr-libc does this in a separate
    // instruction from the EEPE write (`out EECR,EEMPE` then `out EECR,EEPE`), so
    // EEMPE need not be present in the same write that sets EEPE.
    if ((value & (1 << EEMPE)) !== 0) {
      this.masterWriteCycle = this.cpu.cycles;
      this.cpu.addClockEvent(this.expireMasterWriteEvent, 4);
    }
    if ((value & (1 << EEPE)) !== 0 && armed && (this.cpu.data[SPMCSR]! & (1 << SELFPRGEN)) === 0) {
      const address = this.address();
      const mode = (value >> 4) & 3;
      if (mode === 0) this.cells[address] = this.cpu.readData(EEDR);
      else if (mode === 1) this.cells[address] = 0xff;
      else if (mode === 2) this.cells[address] = this.cells[address]! & this.cpu.readData(EEDR);
      this.masterWriteCycle = -1;
      this.cpu.clearClockEvent(this.expireMasterWriteEvent);
      this.cpu.data[EECR] = this.cpu.data[EECR]! & ~(1 << EEMPE);
    }
    this.updateInterrupt();
  }

  @OnWrite(EEARH)
  onWriteEearh(): void {
    this.cpu.data[EEARH] = this.cpu.data[EEARH]! & ((EEPROM_SIZE - 1) >> 8);
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
    };
  }

  restore(snap: EepromSnapshot): void {
    this.cells.set(snap.cells);
    this.masterWriteCycle = snap.masterWriteCycle;
    this.cpu.clearClockEvent(this.expireMasterWriteEvent);
    if (this.masterWriteArmed()) {
      this.cpu.addClockEvent(this.expireMasterWriteEvent, 4 - (this.cpu.cycles - this.masterWriteCycle));
    } else {
      this.expireMasterWriteEvent();
    }
    this.updateInterrupt();
  }
}
