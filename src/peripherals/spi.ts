import { OnWrite } from "../core";
import { MSTR, SPCR, SPDR, SPE, SPI_STC_VECTOR, SPIE, SPIF, SPSR } from "../cpu";
import type { CPU } from "../cpu";
import type { SpiSnapshot } from "../snapshot";
import type { SerialByteListener, SpiTransferResponder } from "./types";

/**
 * SPI master model. Each write to SPDR clocks one byte out to MOSI listeners and
 * clocks one byte in (from the configured responder) back into SPDR, then sets
 * SPIF. Transfer is modeled as immediate so polling loops on SPIF proceed.
 */
export class Spi {
  private readonly txListeners = new Set<SerialByteListener>();
  private responder: SpiTransferResponder = () => 0xff;

  constructor(private readonly cpu: CPU) {}

  reset(): void {
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
  onWriteSpdr(_cpu: CPU, _addr: number, value: number): void {
    const byte = value & 0xff;
    if (!this.enabledMaster()) {
      this.cpu.data[SPDR] = byte;
      return;
    }
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

  // --- Snapshot / restore (Phase 10) ---

  /**
   * The SPI responder is a user-supplied closure, so it cannot be serialized.
   * Snapshot only notes that a restore will reset the responder to its default.
   */
  snapshot(): SpiSnapshot {
    return { responderReset: true };
  }

  restore(_snap: SpiSnapshot): void {
    this.responder = () => 0xff;
  }
}
