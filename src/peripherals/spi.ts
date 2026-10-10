import { OnRead, OnWrite } from "../core";
import { DDRB, DORD, MSTR, PINB, SPCR, SPDR, SPE, SPI_STC_VECTOR, SPI2X, SPIE, SPIF, SPR0, SPR1, SPSR, WCOL } from "../cpu";
import type { CPU } from "../cpu";
import type { SpiSnapshot } from "../snapshot";
import type { Gpio } from "./gpio";
import type { SpiByteListener, SpiMasterHandle, SpiTransferMeta, SpiTransferResponder } from "./types";

/**
 * SPI master/slave byte model with optional GPIO shifting. SPDR writes clock bytes to listeners;
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
  private wireEnabled = false;
  private syncingPins = false;
  private wireSubscriptions: (() => void)[] = [];
  private wireEdge = 0;
  private wireTx = 0;
  private wireRx = 0;
  private wireControl = 0;
  private wireHalfPeriod = 2;
  private frozenWireCycles = 0;
  private readonly onWireEvent = (): void => {
    if (this.pendingMode !== "master" || this.clockPaused()) return;
    const leading = (this.wireEdge & 1) === 0;
    this.gpio?.setPeripheralPin("B", 5, leading !== this.wireIdle());
    this.clockWire(leading);
    this.wireEdge++;
    if (this.wireEdge === 16) this.completeTransfer();
    else this.cpu.addClockEvent(this.onWireEvent, this.wireHalfPeriod);
  };
  private readonly onTransferCompleteEvent = (): void => {
    this.completeTransfer();
  };

  constructor(
    private readonly cpu: CPU,
    private readonly gpio?: Gpio,
  ) {
    this.gpio?.onPortTouched("B", () => this.checkSs());
  }

  private attachWireListeners(): void {
    if (!this.gpio || this.wireSubscriptions.length > 0) return;
    this.wireSubscriptions.push(this.gpio.onPinChange("B", 2, () => {
      if (this.wireEnabled && this.pendingMosi === null) this.syncWirePins();
    }, true));
    this.wireSubscriptions.push(this.gpio.onPinChange("B", 5, (high) => {
      if (this.syncingPins || !this.wireEnabled || !this.enabledSlave() || this.ssHigh() || this.clockPaused()) return;
      if (this.pendingMosi === null) this.beginWireSlave();
      this.clockWire(high !== this.wireIdle());
      this.wireEdge++;
      if (this.wireEdge === 16) this.completeTransfer();
    }, true));
  }

  /** Use SCK/MOSI/MISO pins instead of the byte responder. Change only while idle. */
  useWire(enabled = true): void {
    if (!this.gpio) throw new Error("SPI wire mode requires GPIO.");
    if (this.pendingMosi !== null) throw new Error("Cannot change SPI wire mode during a transfer.");
    this.wireEnabled = enabled;
    if (enabled) this.attachWireListeners();
    else { for (const off of this.wireSubscriptions) off(); this.wireSubscriptions = []; }
    if (!enabled) for (const bit of [2, 3, 4, 5]) this.gpio?.setPeripheralPin("B", bit, undefined);
    this.syncWirePins();
  }

  private wireIdle(): boolean { return (this.wireControl & 8) !== 0; }

  private syncWirePins(): void {
    if (!this.wireEnabled) return;
    this.syncingPins = true;
    try {
      if ((this.cpu.data[SPCR]! & (1 << SPE)) === 0) {
        for (const bit of [2, 3, 4, 5]) this.gpio?.setPeripheralPin("B", bit, undefined);
      } else if (this.enabledMaster()) {
        this.gpio?.setPeripheralPin("B", 2, undefined);
        this.gpio?.setPeripheralPin("B", 4, "input");
        if (this.pendingMosi === null) this.gpio?.setPeripheralPin("B", 5, (this.cpu.data[SPCR]! & 8) !== 0);
      } else {
        if (this.pendingMosi === null) this.wireControl = this.cpu.data[SPCR]!;
        this.gpio?.setPeripheralPin("B", 2, "input");
        this.gpio?.setPeripheralPin("B", 3, "input");
        this.gpio?.setPeripheralPin("B", 5, "input");
        this.gpio?.setPeripheralPin("B", 4, this.ssHigh() ? "input" : this.outputBit(this.cpu.data[SPDR]!, 0));
      }
    } finally { this.syncingPins = false; }
  }

  private outputBit(value: number, index: number): boolean {
    const bit = (this.wireControl & (1 << DORD)) !== 0 ? index : 7 - index;
    return ((value >> bit) & 1) !== 0;
  }

  private beginWireSlave(): void {
    this.pendingMosi = 0;
    this.pendingMode = "slave";
    this.beginWire();
  }

  private beginWire(): void {
    this.wireEdge = 0;
    this.wireRx = 0;
    this.wireTx = this.cpu.data[SPDR]!;
    this.wireControl = this.cpu.data[SPCR]!;
    this.wireHalfPeriod = this.transferCycles() / 16;
    if ((this.wireControl & 4) === 0) this.driveWireBit(0);
  }

  private driveWireBit(index: number): void {
    this.gpio?.setPeripheralPin("B", this.pendingMode === "master" ? 3 : 4,
      this.outputBit(this.wireTx, index));
  }

  private clockWire(leading: boolean): void {
    const sample = leading === ((this.wireControl & 4) === 0);
    const index = this.wireEdge >> 1;
    if (sample) {
      const high = this.gpio?.readPin("B", this.pendingMode === "master" ? 4 : 3) ?? true;
      const bit = (this.wireControl & (1 << DORD)) !== 0 ? index : 7 - index;
      if (high) this.wireRx |= 1 << bit;
    } else {
      const next = (this.wireControl & 4) !== 0 ? index : index + 1;
      if (next < 8) this.driveWireBit(next);
    }
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
    this.cpu.clearClockEvent(this.onWireEvent);
    this.wireEdge = 0;
    this.syncWirePins();
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
    this.syncWirePins();
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
      if (this.wireEnabled) this.syncWirePins();
      return;
    }

    this.pendingMosi = byte;
    this.pendingMode = "master";
    this.cpu.data[SPDR] = byte;
    this.updateInterrupt();
    if (this.wireEnabled) {
      this.beginWire();
      if (this.clockPaused()) this.frozenWireCycles = this.wireHalfPeriod;
      else this.cpu.addClockEvent(this.onWireEvent, this.wireHalfPeriod);
    } else this.scheduleTransfer(this.transferCycles());
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
      this.cpu.data[SPDR] = this.wireEnabled ? this.wireRx : this.responder(byte, meta) & 0xff;
    } else {
      this.cpu.data[SPDR] = this.wireEnabled ? this.wireRx : byte;
    }
    this.receivedByte = this.cpu.data[SPDR]!;
    this.cpu.data[SPSR] = this.cpu.data[SPSR]! | (1 << SPIF);
    this.syncWirePins();
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
    if (this.wireEnabled) throw new Error("Drive SCK/MOSI pins when SPI wire mode is enabled.");
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
      this.syncWirePins();
      this.updateInterrupt();
    } else if (high && this.pendingMode === "slave") {
      this.abortTransfer();
    }
    if (this.wireEnabled && this.enabledSlave() && high) this.gpio?.setPeripheralPin("B", 4, "input");
  }

  private abortTransfer(): void {
    this.cpu.clearClockEvent(this.onTransferCompleteEvent);
    this.cpu.clearClockEvent(this.onWireEvent);
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
      bitOrder: ((this.wireEnabled ? this.wireControl : this.cpu.data[SPCR]!) & (1 << DORD)) !== 0 ? "lsb-first" : "msb-first",
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
      this.frozenWireCycles = this.cpu.clockEventRemainingCycles(this.onWireEvent);
      this.cpu.clearClockEvent(this.onWireEvent);
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
      this.frozenWireCycles = this.cpu.clockEventRemainingCycles(this.onWireEvent);
      this.cpu.clearClockEvent(this.onWireEvent);
      this.frozenTransferRemainingCycles = this.cpu.clockEventRemainingCycles(this.onTransferCompleteEvent);
      this.cpu.clearClockEvent(this.onTransferCompleteEvent);
      return;
    }
    if (this.pendingMosi !== null) {
      if (this.wireEnabled) {
        if (this.pendingMode === "master") this.cpu.addClockEvent(this.onWireEvent, this.frozenWireCycles || this.wireHalfPeriod);
      } else this.cpu.addClockEvent(this.onTransferCompleteEvent, this.frozenTransferRemainingCycles || this.transferCycles());
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
      wire: { enabled: this.wireEnabled, edge: this.wireEdge, tx: this.wireTx, rx: this.wireRx,
        control: this.wireControl, halfPeriod: this.wireHalfPeriod,
        remainingCycles: this.clockPaused() ? this.frozenWireCycles : this.cpu.clockEventRemainingCycles(this.onWireEvent) },
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
    this.wireEnabled = snap.wire?.enabled ?? false;
    if (this.wireEnabled) this.attachWireListeners();
    else { for (const off of this.wireSubscriptions) off(); this.wireSubscriptions = []; }
    this.wireEdge = snap.wire?.edge ?? 0;
    this.wireTx = snap.wire?.tx ?? 0;
    this.wireRx = snap.wire?.rx ?? 0;
    this.wireControl = snap.wire?.control ?? 0;
    this.wireHalfPeriod = snap.wire?.halfPeriod ?? 2;
    this.cpu.clearClockEvent(this.onWireEvent);
    this.cpu.clearClockEvent(this.onTransferCompleteEvent);
    if (this.pendingMosi !== null) {
      if (this.wireEnabled) {
        if (this.pendingMode === "master") this.cpu.addClockEvent(this.onWireEvent, snap.wire?.remainingCycles ?? this.wireHalfPeriod);
      } else this.cpu.addClockEvent(this.onTransferCompleteEvent, snap.remainingCycles ?? this.transferCycles());
    }
  }
}
