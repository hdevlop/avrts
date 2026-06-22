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

  constructor(private readonly cpu: CPU) {}

  reset(): void {
    this.masterWriteCycle = -1;
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

  @OnWrite(EECR)
  onWriteEecr(_cpu: CPU, _addr: number, value: number): void {
    if ((value & (1 << EERE)) !== 0) {
      this.cpu.data[EEDR] = this.cells[this.address()]!;
      this.cpu.data[EECR] = value & ~(1 << EERE); // read finishes immediately
      return;
    }
    // EEMPE arms the master-write window. avr-libc does this in a separate
    // instruction from the EEPE write (`out EECR,EEMPE` then `out EECR,EEPE`), so
    // EEMPE need not be present in the same write that sets EEPE.
    if ((value & (1 << EEMPE)) !== 0) {
      this.masterWriteCycle = this.cpu.cycles;
    }
    if ((value & (1 << EEPE)) !== 0 && this.masterWriteArmed()) {
      this.cells[this.address()] = this.cpu.readData(EEDR);
      this.masterWriteCycle = -1;
      this.cpu.data[EECR] = value & ~((1 << EEPE) | (1 << EEMPE)); // write finishes immediately
      this.requestReadyInterrupt();
    }
  }

  /** True while the EEMPE master-write window is still open (4-cycle hardware window). */
  private masterWriteArmed(): boolean {
    return this.masterWriteCycle >= 0 && this.cpu.cycles - this.masterWriteCycle <= 4;
  }

  private requestReadyInterrupt(): void {
    if ((this.cpu.readData(EECR) & (1 << EERIE)) !== 0) {
      this.cpu.requestInterrupt(EE_READY_VECTOR);
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
  }
}
