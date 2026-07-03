import { OnWrite } from "../core";
import { MSTR, SPCR, SPDR, SPE, SPI_STC_VECTOR, SPI2X, SPIE, SPIF, SPR0, SPR1, SPSR, WCOL } from "../cpu";
import type { CPU } from "../cpu";
import type { SpiSnapshot } from "../snapshot";
import type { SerialByteListener, SpiTransferResponder } from "./types";

/**
 * SPI master model. Each write to SPDR clocks one byte out to MOSI listeners and
 * clocks one byte in after the configured SCK delay. Host listeners and the
 * responder run at transfer completion, matching the hardware-visible SPIF edge.
 */
export class Spi {
  private readonly txListeners = new Set<SerialByteListener>();
  private responder: SpiTransferResponder = () => 0xff;
  private pendingMosi: number | null = null;
  private readonly onTransferCompleteEvent = (): void => {
    this.completeTransfer();
  };

  constructor(private readonly cpu: CPU) {}

  reset(): void {
    this.cpu.clearClockEvent(this.onTransferCompleteEvent);
    this.pendingMosi = null;
    this.cpu.data[SPSR] = 0;
  }

  /** Observe each byte the master sends on MOSI. */
  onByteTransmit(listener: SerialByteListener): () => void {
    this.txListeners.add(listener);
    return () => {
      this.txListeners.delete(listener);
    };
  }

  /** Supply the byte clocked in on MISO for each transferred byte. */
  respondWith(responder: SpiTransferResponder): void {
    this.responder = responder;
  }

  @OnWrite(SPDR)
  onWriteSpdr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    const byte = value & 0xff;
    if (!this.enabledMaster()) {
      this.cpu.data[SPDR] = byte;
      return;
    }

    if (this.pendingMosi !== null) {
      this.cpu.data[SPDR] = oldValue & 0xff;
      this.cpu.data[SPSR] = this.cpu.readData(SPSR) | (1 << WCOL);
      return;
    }

    this.pendingMosi = byte;
    this.cpu.data[SPDR] = byte;
    this.cpu.data[SPSR] = this.cpu.readData(SPSR) & ~((1 << SPIF) | (1 << WCOL));
    this.cpu.addClockEvent(this.onTransferCompleteEvent, this.transferCycles());
  }

  private completeTransfer(): void {
    const byte = this.pendingMosi! & 0xff;
    this.pendingMosi = null;
    for (const listener of [...this.txListeners]) listener(byte);
    this.cpu.data[SPDR] = this.responder(byte) & 0xff;
    this.cpu.data[SPSR] = this.cpu.readData(SPSR) | (1 << SPIF);
    if ((this.cpu.readData(SPCR) & (1 << SPIE)) !== 0) {
      this.cpu.requestInterrupt(SPI_STC_VECTOR, () => {
        this.cpu.data[SPSR] = this.cpu.readData(SPSR) & ~(1 << SPIF);
      });
    }
  }

  private enabledMaster(): boolean {
    const spcr = this.cpu.readData(SPCR);
    return (spcr & (1 << SPE)) !== 0 && (spcr & (1 << MSTR)) !== 0;
  }

  private transferCycles(): number {
    const spcr = this.cpu.data[SPCR]!;
    const spr = (((spcr >> SPR1) & 1) << 1) | ((spcr >> SPR0) & 1);
    const base = [4, 16, 64, 128][spr]!;
    const divider = (this.cpu.data[SPSR]! & (1 << SPI2X)) !== 0 ? base / 2 : base;
    return Math.max(1, divider * 8);
  }

  private remainingCycles(): number {
    return this.cpu.clockEventRemainingCycles(this.onTransferCompleteEvent);
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
      remainingCycles: this.remainingCycles(),
    };
  }

  restore(snap: SpiSnapshot): void {
    this.responder = () => 0xff;
    this.pendingMosi = snap.busy ? (snap.pendingMosi ?? 0) : null;
    this.cpu.clearClockEvent(this.onTransferCompleteEvent);
    if (this.pendingMosi !== null) {
      this.cpu.addClockEvent(this.onTransferCompleteEvent, snap.remainingCycles ?? this.transferCycles());
    }
  }
}
