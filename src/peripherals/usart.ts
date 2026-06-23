import { OnRead, OnWrite } from "../core";
import {
  MPCM0,
  RXC0,
  RXCIE0,
  RXEN0,
  TXC0,
  TXCIE0,
  TXEN0,
  U2X0,
  UCSR0A,
  UCSR0B,
  UDR0,
  UDRIE0,
  UDRE0,
  USART_RX_VECTOR,
  USART_TX_VECTOR,
  USART_UDRE_VECTOR,
} from "../cpu";
import type { CPU } from "../cpu";
import type { Usart0Snapshot } from "../snapshot";
import type { SerialByteListener } from "./types";

const UCSR0A_HARDWARE_MASK = (1 << RXC0) | (1 << TXC0) | (1 << UDRE0);
const UCSR0A_WRITABLE_MASK = (1 << U2X0) | (1 << MPCM0);

/**
 * Minimal USART0 model for Serial output. Transmission is modeled as immediate:
 * writing UDR0 emits one byte, then UDRE0/TXC0 are ready so Arduino's polling
 * loops keep moving. RX is buffered and interrupt flags are surfaced so Arduino's
 * serial core can use polling or interrupt-driven paths.
 */
export class Usart0 {
  private readonly txListeners = new Set<SerialByteListener>();
  private readonly rxBytes: number[] = [];
  private rxHead = 0;
  private interruptSourcesEnabled = false;
  private readonly onInterruptEvent = (): void => {
    this.updateInterrupts();
    this.scheduleInterruptPoll();
  };

  constructor(private readonly cpu: CPU) {
    this.reset();
  }

  reset(): void {
    this.rxBytes.length = 0;
    this.rxHead = 0;
    this.cpu.data[UCSR0A] = (1 << UDRE0);
    this.cpu.data[UDR0] = 0;
    this.refreshInterruptSourcesEnabled();
    this.scheduleInterruptPoll();
  }

  onByteTransmit(listener: SerialByteListener): () => void {
    this.txListeners.add(listener);
    return () => {
      this.txListeners.delete(listener);
    };
  }

  /** Queue host bytes for firmware to read from UDR0 (the simulated RX line). */
  receive(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    for (const byte of bytes) this.rxBytes.push(byte & 0xff);
    this.updateRxFlag();
    this.updateInterrupts();
    this.scheduleInterruptPoll();
  }

  /** Re-evaluate USART interrupt sources after CPU cycles/instruction boundaries. */
  tick(): void {
    if (!this.interruptSourcesEnabled) return;
    this.updateInterrupts();
    this.scheduleInterruptPoll();
  }

  @OnWrite(UCSR0A)
  onWriteUcsr0a(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    // TXC0 is write-1-to-clear. U2X0/MPCM0 are writable; RXC0/UDRE0 are
    // hardware-owned in this model.
    const hardware = (oldValue & UCSR0A_HARDWARE_MASK) & ~(value & (1 << TXC0));
    this.cpu.data[UCSR0A] = hardware | (value & UCSR0A_WRITABLE_MASK);
    this.updateReadyFlags();
    this.scheduleInterruptPoll();
  }

  @OnWrite(UCSR0B)
  onWriteUcsr0b(): void {
    this.refreshInterruptSourcesEnabled();
    // Enabling RXEN0 should surface any already-queued RX bytes.
    this.updateReadyFlags();
    this.scheduleInterruptPoll();
  }

  @OnWrite(UDR0)
  onWriteUdr0(_cpu: CPU, _addr: number, value: number): void {
    if (this.txEnabled()) {
      this.emitByte(value & 0xff);
    }
    this.cpu.data[UDR0] = value & 0xff;
    this.cpu.data[UCSR0A] = this.cpu.readData(UCSR0A) | (1 << UDRE0) | (1 << TXC0);
    this.updateInterrupts();
    this.scheduleInterruptPoll();
  }

  /** Firmware read of UDR0: deliver and consume the next queued RX byte. */
  @OnRead(UDR0)
  readUdr0(): number {
    const byte = this.rxEnabled() && this.hasQueuedRx() ? this.shiftRxByte() : this.cpu.data[UDR0]!;
    this.cpu.data[UDR0] = byte & 0xff;
    this.updateRxFlag();
    this.scheduleInterruptPoll();
    return byte & 0xff;
  }

  private rxEnabled(): boolean {
    return (this.cpu.data[UCSR0B]! & (1 << RXEN0)) !== 0;
  }

  private txEnabled(): boolean {
    return (this.cpu.data[UCSR0B]! & (1 << TXEN0)) !== 0;
  }

  private hasQueuedRx(): boolean {
    return this.rxHead < this.rxBytes.length;
  }

  private shiftRxByte(): number {
    const byte = this.rxBytes[this.rxHead++]!;
    if (this.rxHead >= this.rxBytes.length) {
      this.rxBytes.length = 0;
      this.rxHead = 0;
    }
    return byte;
  }

  private emitByte(byte: number): void {
    if (this.txListeners.size === 0) return;
    if (this.txListeners.size === 1) {
      this.txListeners.values().next().value?.(byte);
      return;
    }
    for (const listener of [...this.txListeners]) listener(byte);
  }

  private updateRxFlag(): void {
    if (!this.rxEnabled() || !this.hasQueuedRx()) {
      this.cpu.data[UCSR0A] = this.cpu.data[UCSR0A]! & ~(1 << RXC0);
      return;
    }
    this.cpu.data[UCSR0A] = this.cpu.data[UCSR0A]! | (1 << RXC0);
  }

  private updateReadyFlags(): void {
    this.cpu.data[UCSR0A] = this.cpu.data[UCSR0A]! | (1 << UDRE0);
    this.updateRxFlag();
    this.updateInterrupts();
  }

  private refreshInterruptSourcesEnabled(): void {
    const control = this.cpu.data[UCSR0B]!;
    this.interruptSourcesEnabled =
      (control & ((1 << RXCIE0) | (1 << UDRIE0) | (1 << TXCIE0))) !== 0;
  }

  private hasEnabledReadySource(): boolean {
    if (!this.interruptSourcesEnabled) return false;
    const status = this.cpu.data[UCSR0A]!;
    const control = this.cpu.data[UCSR0B]!;
    return (
      ((status & (1 << RXC0)) !== 0 && (control & (1 << RXCIE0)) !== 0) ||
      ((status & (1 << UDRE0)) !== 0 && (control & (1 << UDRIE0)) !== 0) ||
      ((status & (1 << TXC0)) !== 0 && (control & (1 << TXCIE0)) !== 0)
    );
  }

  private scheduleInterruptPoll(): void {
    if (this.hasEnabledReadySource()) {
      this.cpu.addClockEvent(this.onInterruptEvent, 1);
    } else {
      this.cpu.clearClockEvent(this.onInterruptEvent);
    }
  }

  private updateInterrupts(): void {
    if (!this.interruptSourcesEnabled) return;
    if (!this.cpu.sreg.I) return;
    const status = this.cpu.data[UCSR0A]!;
    const control = this.cpu.data[UCSR0B]!;
    if ((status & (1 << RXC0)) !== 0 && (control & (1 << RXCIE0)) !== 0) {
      this.cpu.requestInterrupt(USART_RX_VECTOR);
    }
    if ((status & (1 << UDRE0)) !== 0 && (control & (1 << UDRIE0)) !== 0) {
      this.cpu.requestInterrupt(USART_UDRE_VECTOR);
    }
    if ((status & (1 << TXC0)) !== 0 && (control & (1 << TXCIE0)) !== 0) {
      this.cpu.requestInterrupt(USART_TX_VECTOR, () => {
        this.cpu.data[UCSR0A] &= ~(1 << TXC0);
      });
    }
  }

  // --- Snapshot / restore (Phase 10) ---

  /** Capture queued RX bytes and head index. Status flags live in the CPU snapshot. */
  snapshot(): Usart0Snapshot {
    const bytes = new Uint8Array(this.rxBytes.length - this.rxHead);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = this.rxBytes[this.rxHead + i]!;
    return { rxBytes: bytes, rxHead: 0 };
  }

  /** Restore queued RX bytes. UCSR0A/UCSR0B are restored with the CPU data. */
  restore(snap: Usart0Snapshot): void {
    this.rxBytes.length = 0;
    for (const byte of snap.rxBytes) this.rxBytes.push(byte);
    this.rxHead = snap.rxHead;
    this.refreshInterruptSourcesEnabled();
    this.updateRxFlag();
    this.updateInterrupts();
    this.scheduleInterruptPoll();
  }
}
