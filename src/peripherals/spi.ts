import { OnRead, OnWrite } from "../core";
import { DDRB, DORD, MSTR, PINB, SPCR, SPDR, SPE, SPI_STC_VECTOR, SPI2X, SPIE, SPIF, SPR0, SPR1, SPSR, WCOL } from "../cpu";
import type { CPU } from "../cpu";
import type { SpiSnapshot } from "../snapshot";
import type { Gpio } from "./gpio";
import type { SpiByteListener, SpiMasterHandle, SpiTransferMeta, SpiTransferResponder } from "./types";

/**
 * SPI master/slave byte model. Master SPDR writes clock bytes to MOSI listeners;
 * a host master supplies slave bytes. Completion follows the configured SCK delay.
 * Host listeners and the responder run at completion, matching the SPIF edge.
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
  private receivedByte: number | null = null;
  private powerReduced = false;
  private sleepPaused = false;
  private frozenTransferRemainingCycles = 0;
  private readonly onTransferCompleteEvent = (): void => {
    this.completeTransfer();
  };

  constructor(
    private readonly cpu: CPU,
    private readonly gpio?: Gpio,
  ) {
    this.gpio?.onPortTouched("B", () => this.checkSs());
  }

  reset(): void {
    this.powerReduced = false;
    this.sleepPaused = false;
    this.frozenTransferRemainingCycles = 0;
    this.cpu.clearClockEvent(this.onTransferCompleteEvent);
    this.pendingMosi = null;
    this.pendingMode = null;
    this.spifClearArmed = false;
    this.receivedByte = null;
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

  @OnWrite(SPCR)
  onWriteSpcr(): void {
    const control = this.cpu.data[SPCR]!;
    const mode = (control & (1 << MSTR)) !== 0 ? "master" : "slave";
    if ((control & (1 << SPE)) === 0 || (this.pendingMode !== null && this.pendingMode !== mode)) {
      this.abortTransfer();
    }
    this.checkSs();
    this.updateInterrupt();
  }

  @OnWrite(SPSR)
  onWriteSpsr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    // Only SPI2X is writable; SPIF/WCOL are cleared by acknowledgement/access.
    this.cpu.data[SPSR] = (oldValue & ((1 << SPIF) | (1 << WCOL))) | (value & (1 << SPI2X));
    this.updateInterrupt();
  }

  @OnWrite(SPDR)
  onWriteSpdr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    const byte = value & 0xff;
    this.clearFlagsAfterSpdrAccess();
    if (this.pendingMosi !== null) {
      this.cpu.data[SPDR] = oldValue & 0xff;
      this.cpu.data[SPSR] = this.cpu.data[SPSR]! | (1 << WCOL);
      return;
    }
    if (!this.enabledMaster()) {
      this.cpu.data[SPDR] = byte;
      return;
    }

    this.pendingMosi = byte;
    this.pendingMode = "master";
    this.cpu.data[SPDR] = byte;
    this.cpu.data[SPSR] = this.cpu.data[SPSR]! & ~((1 << SPIF) | (1 << WCOL));
    this.updateInterrupt();
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
    const value = this.receivedByte ?? this.cpu.data[SPDR]!;
    this.clearFlagsAfterSpdrAccess();
    return value;
  }

  private completeTransfer(): void {
    if (this.pendingMosi === null) return;
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
    this.receivedByte = this.cpu.data[SPDR]!;
    this.cpu.data[SPSR] = this.cpu.data[SPSR]! | (1 << SPIF);
    this.updateInterrupt();
  }

  private updateInterrupt(): void {
    if ((this.cpu.data[SPCR]! & (1 << SPIE)) !== 0 && (this.cpu.data[SPSR]! & (1 << SPIF)) !== 0) {
      this.cpu.requestInterrupt(SPI_STC_VECTOR, () => {
        this.cpu.data[SPSR] = this.cpu.data[SPSR]! & ~(1 << SPIF);
      });
    } else {
      this.cpu.clearInterrupt(SPI_STC_VECTOR);
    }
  }

  private hostTransfer(byte: number): number {
    if (!this.enabledSlave()) {
      throw new Error("SPI host master transfer requires firmware SPI slave mode (SPE set, MSTR clear).");
    }
    if (this.clockPaused()) {
      throw new Error("SPI host master transfer requires an active SPI clock (PRR.PRSPI clear and idle/awake).");
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
    this.updateInterrupt();
    this.scheduleTransfer(this.transferCycles());
    return miso;
  }

  private clearFlagsAfterSpdrAccess(): void {
    if (!this.spifClearArmed) return;
    this.cpu.data[SPSR] = this.cpu.data[SPSR]! & ~((1 << SPIF) | (1 << WCOL));
    this.spifClearArmed = false;
    this.updateInterrupt();
  }

  private checkSs(): void {
    if ((this.cpu.data[SPCR]! & (1 << SPE)) === 0) return;
    const high = this.ssHigh();
    if (!high && this.enabledMaster() && this.ssConfiguredInput()) {
      this.abortTransfer();
      this.cpu.data[SPCR] = this.cpu.data[SPCR]! & ~(1 << MSTR);
      this.cpu.data[SPSR] = this.cpu.data[SPSR]! | (1 << SPIF);
      this.updateInterrupt();
    } else if (high && this.pendingMode === "slave") {
      this.abortTransfer();
    }
  }

  private abortTransfer(): void {
    this.cpu.clearClockEvent(this.onTransferCompleteEvent);
    this.pendingMosi = null;
    this.pendingMode = null;
    this.frozenTransferRemainingCycles = 0;
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
    // In slave mode the SPI owns SS as an input even if firmware sets DDB2.
    if (this.enabledSlave()) return (this.cpu.data[PINB]! & (1 << 2)) !== 0;
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
    if (this.clockPaused() && this.pendingMosi !== null) return this.frozenTransferRemainingCycles;
    return this.cpu.clockEventRemainingCycles(this.onTransferCompleteEvent);
  }

  private scheduleTransfer(cycles: number): void {
    if (this.clockPaused()) {
      this.frozenTransferRemainingCycles = cycles;
      return;
    }
    this.cpu.addClockEvent(this.onTransferCompleteEvent, cycles);
  }

  setPowerReduced(reduced: boolean): void {
    const wasPaused = this.clockPaused();
    this.powerReduced = reduced;
    this.applyClockGate(wasPaused);
  }

  setSleepPaused(paused: boolean): void {
    const wasPaused = this.clockPaused();
    this.sleepPaused = paused;
    this.applyClockGate(wasPaused);
  }

  private clockPaused(): boolean {
    return this.powerReduced || this.sleepPaused;
  }

  private applyClockGate(wasPaused: boolean): void {
    if (wasPaused === this.clockPaused()) return;
    if (this.clockPaused()) {
      this.frozenTransferRemainingCycles = this.cpu.clockEventRemainingCycles(this.onTransferCompleteEvent);
      this.cpu.clearClockEvent(this.onTransferCompleteEvent);
      return;
    }
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
      receivedByte: this.receivedByte,
    };
  }

  restore(snap: SpiSnapshot): void {
    this.powerReduced = false;
    this.sleepPaused = false;
    this.frozenTransferRemainingCycles = 0;
    this.responder = () => 0xff;
    this.pendingMosi = snap.busy ? (snap.pendingMosi ?? 0) : null;
    this.pendingMode = snap.busy ? (snap.pendingMode ?? "master") : null;
    this.spifClearArmed = snap.spifClearArmed ?? false;
    this.receivedByte = snap.receivedByte ?? null;
    this.cpu.clearClockEvent(this.onTransferCompleteEvent);
    if (this.pendingMosi !== null) {
      this.cpu.addClockEvent(this.onTransferCompleteEvent, snap.remainingCycles ?? this.transferCycles());
    }
  }
}
