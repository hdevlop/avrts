import { OnRead, OnWrite } from "../core";
import { DDRB, DORD, MSTR, SPCR, SPDR, SPE, SPI_STC_VECTOR, SPI2X, SPIE, SPIF, SPR0, SPR1, SPSR, WCOL } from "../cpu";
import type { CPU } from "../cpu";
import type { SpiSnapshot } from "../snapshot";
import type { Gpio } from "./gpio";
import type { SpiByteListener, SpiMasterHandle, SpiTransferMeta, SpiTransferResponder } from "./types";

/**
 * SPI master model. Each write to SPDR clocks one byte out to MOSI listeners and
 * clocks one byte in after the configured SCK delay. Host listeners and the
 * responder run at transfer completion, matching the hardware-visible SPIF edge.
 */
export class Spi {
  private readonly txListeners = new Set<SpiByteListener>();
  private readonly hostMaster: SpiMasterHandle = {
    transfer: (byte) => this.hostTransfer(byte),
  };
  private responder: SpiTransferResponder = () => 0xff;
  private pendingMosi: number | null = null;
  private pendingMode: "master" | "slave" | null = null;
  private spifClearArmed = false;
  private previousSsHigh = true;
  private powerReduced = false;
  private frozenTransferRemainingCycles = 0;
  private readonly onTransferCompleteEvent = (): void => {
    this.completeTransfer();
  };

  constructor(
    private readonly cpu: CPU,
    private readonly gpio?: Gpio,
  ) {
    this.previousSsHigh = this.ssHigh();
    this.gpio?.onPinChange("B", 2, (high) => this.onSsLevelChange(high));
  }

  reset(): void {
    this.powerReduced = false;
    this.frozenTransferRemainingCycles = 0;
    this.cpu.clearClockEvent(this.onTransferCompleteEvent);
    this.pendingMosi = null;
    this.pendingMode = null;
    this.spifClearArmed = false;
    this.previousSsHigh = this.ssHigh();
    this.cpu.data[SPSR] = 0;
  }

  /** Observe each byte the master sends on MOSI. */
  onByteTransmit(listener: SpiByteListener): () => void {
    this.txListeners.add(listener);
    return () => {
      this.txListeners.delete(listener);
    };
  }

  /** Supply the byte clocked in on MISO for each transferred byte. */
  respondWith(responder: SpiTransferResponder): void {
    this.responder = responder;
  }

  /** Host-side external SPI master used when firmware configures this AVR as a slave. */
  master(): SpiMasterHandle {
    return this.hostMaster;
  }

  @OnWrite(SPDR)
  onWriteSpdr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    const byte = value & 0xff;
    this.clearFlagsAfterSpdrAccess();
    if (!this.enabledMaster()) {
      this.cpu.data[SPDR] = byte;
      return;
    }

    if (this.pendingMosi !== null) {
      this.cpu.data[SPDR] = oldValue & 0xff;
      this.cpu.data[SPSR] = this.cpu.data[SPSR]! | (1 << WCOL);
      return;
    }

    this.pendingMosi = byte;
    this.pendingMode = "master";
    this.cpu.data[SPDR] = byte;
    this.cpu.data[SPSR] = this.cpu.data[SPSR]! & ~((1 << SPIF) | (1 << WCOL));
    this.scheduleTransfer(this.transferCycles());
  }

  @OnRead(SPSR)
  onReadSpsr(): number {
    const value = this.cpu.data[SPSR]!;
    if ((value & ((1 << SPIF) | (1 << WCOL))) !== 0) this.spifClearArmed = true;
    return value;
  }

  @OnRead(SPDR)
  onReadSpdr(): number {
    const value = this.cpu.data[SPDR]!;
    this.clearFlagsAfterSpdrAccess();
    return value;
  }

  private completeTransfer(): void {
    const byte = this.pendingMosi! & 0xff;
    const mode = this.pendingMode ?? "master";
    this.pendingMosi = null;
    this.pendingMode = null;
    const meta = this.transferMeta(mode);
    if (mode === "master") {
      for (const listener of [...this.txListeners]) listener(byte, meta);
      this.cpu.data[SPDR] = this.responder(byte, meta) & 0xff;
    } else {
      this.cpu.data[SPDR] = byte;
    }
    this.cpu.data[SPSR] = this.cpu.data[SPSR]! | (1 << SPIF);
    if ((this.cpu.data[SPCR]! & (1 << SPIE)) !== 0) {
      this.cpu.requestInterrupt(SPI_STC_VECTOR, () => {
        this.cpu.data[SPSR] = this.cpu.data[SPSR]! & ~(1 << SPIF);
      });
    }
  }

  private hostTransfer(byte: number): number {
    if (!this.enabledSlave()) {
      throw new Error("SPI host master transfer requires firmware SPI slave mode (SPE set, MSTR clear).");
    }
    if (this.powerReduced) {
      throw new Error("SPI host master transfer requires SPI power enabled (PRR.PRSPI clear).");
    }
    if (this.ssHigh()) {
      throw new Error("SPI host master transfer requires SS/PB2 low.");
    }
    if (this.pendingMosi !== null) {
      throw new Error("SPI host master cannot transfer while another SPI transfer is pending.");
    }
    const miso = this.cpu.data[SPDR]! & 0xff;
    this.pendingMosi = byte & 0xff;
    this.pendingMode = "slave";
    this.cpu.data[SPSR] = this.cpu.data[SPSR]! & ~((1 << SPIF) | (1 << WCOL));
    this.scheduleTransfer(this.transferCycles());
    return miso;
  }

  private clearFlagsAfterSpdrAccess(): void {
    if (!this.spifClearArmed) return;
    this.cpu.data[SPSR] = this.cpu.data[SPSR]! & ~((1 << SPIF) | (1 << WCOL));
    this.spifClearArmed = false;
  }

  private onSsLevelChange(high: boolean): void {
    const wasHigh = this.previousSsHigh;
    this.previousSsHigh = high;
    if (wasHigh && !high && this.enabledMaster() && this.ssConfiguredInput()) {
      this.cpu.data[SPCR] = this.cpu.data[SPCR]! & ~(1 << MSTR);
      this.cpu.data[SPSR] = this.cpu.data[SPSR]! | (1 << SPIF);
      if ((this.cpu.data[SPCR]! & (1 << SPIE)) !== 0) {
        this.cpu.requestInterrupt(SPI_STC_VECTOR, () => {
          this.cpu.data[SPSR] = this.cpu.data[SPSR]! & ~(1 << SPIF);
        });
      }
    }
  }

  private enabledMaster(): boolean {
    const spcr = this.cpu.data[SPCR]!;
    return (spcr & (1 << SPE)) !== 0 && (spcr & (1 << MSTR)) !== 0;
  }

  private enabledSlave(): boolean {
    const spcr = this.cpu.data[SPCR]!;
    return (spcr & (1 << SPE)) !== 0 && (spcr & (1 << MSTR)) === 0;
  }

  private ssConfiguredInput(): boolean {
    return (this.cpu.data[DDRB]! & (1 << 2)) === 0;
  }

  private ssHigh(): boolean {
    return this.gpio?.readPin("B", 2) ?? false;
  }

  private transferMeta(mode: "master" | "slave"): SpiTransferMeta {
    return {
      bitOrder: (this.cpu.data[SPCR]! & (1 << DORD)) !== 0 ? "lsb-first" : "msb-first",
      mode,
    };
  }

  private transferCycles(): number {
    const spcr = this.cpu.data[SPCR]!;
    const spr = (((spcr >> SPR1) & 1) << 1) | ((spcr >> SPR0) & 1);
    const base = [4, 16, 64, 128][spr]!;
    const divider = (this.cpu.data[SPSR]! & (1 << SPI2X)) !== 0 ? base / 2 : base;
    return Math.max(1, divider * 8);
  }

  private remainingCycles(): number {
    if (this.powerReduced && this.pendingMosi !== null) return this.frozenTransferRemainingCycles;
    return this.cpu.clockEventRemainingCycles(this.onTransferCompleteEvent);
  }

  private scheduleTransfer(cycles: number): void {
    if (this.powerReduced) {
      this.frozenTransferRemainingCycles = cycles;
      return;
    }
    this.cpu.addClockEvent(this.onTransferCompleteEvent, cycles);
  }

  setPowerReduced(reduced: boolean): void {
    if (this.powerReduced === reduced) return;
    if (reduced) {
      this.frozenTransferRemainingCycles = this.remainingCycles();
      this.powerReduced = true;
      this.cpu.clearClockEvent(this.onTransferCompleteEvent);
      return;
    }
    this.powerReduced = false;
    if (this.pendingMosi !== null) {
      this.cpu.addClockEvent(this.onTransferCompleteEvent, this.frozenTransferRemainingCycles || this.transferCycles());
    }
    this.frozenTransferRemainingCycles = 0;
  }

  // --- Snapshot / restore (Phase 10) ---

  /**
   * The SPI responder is a user-supplied closure, so it cannot be serialized.
   * Snapshot only notes that a restore will reset the responder to its default.
   */
  snapshot(): SpiSnapshot {
    return {
      responderReset: true,
      busy: this.pendingMosi !== null,
      pendingMosi: this.pendingMosi ?? 0,
      pendingMode: this.pendingMode,
      remainingCycles: this.remainingCycles(),
      spifClearArmed: this.spifClearArmed,
    };
  }

  restore(snap: SpiSnapshot): void {
    this.powerReduced = false;
    this.frozenTransferRemainingCycles = 0;
    this.responder = () => 0xff;
    this.pendingMosi = snap.busy ? (snap.pendingMosi ?? 0) : null;
    this.pendingMode = snap.busy ? (snap.pendingMode ?? "master") : null;
    this.spifClearArmed = snap.spifClearArmed ?? false;
    this.previousSsHigh = this.ssHigh();
    this.cpu.clearClockEvent(this.onTransferCompleteEvent);
    if (this.pendingMosi !== null) {
      this.cpu.addClockEvent(this.onTransferCompleteEvent, snap.remainingCycles ?? this.transferCycles());
    }
  }
}
