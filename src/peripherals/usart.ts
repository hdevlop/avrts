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
  UBRR0H,
  UBRR0L,
  UCSR0A,
  UCSR0B,
  UCSR0C,
  UDR0,
  UDRIE0,
  UDRE0,
  UCSZ00,
  UCSZ01,
  UCSZ02,
  UPM00,
  UPM01,
  USBS0,
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
 * USART0 model for Serial-style firmware. TX is scheduled by baud/frame timing:
 * writes fill the AVR's double buffer and bytes become visible to host listeners
 * only when the simulated frame finishes. RX remains host-injected and queued.
 */
export class Usart0 {
  private readonly txListeners = new Set<SerialByteListener>();
  private readonly rxBytes: number[] = [];
  private rxHead = 0;
  private interruptSourcesEnabled = false;
  private txShiftByte: number | null = null;
  private txBufferByte: number | null = null;
  private readonly onTxCompleteEvent = (): void => {
    this.completeTxFrame();
  };
  private readonly onInterruptEvent = (): void => {
    this.updateInterrupts();
    this.scheduleInterruptPoll();
  };

  constructor(private readonly cpu: CPU) {
    this.reset();
  }

  reset(): void {
    this.cpu.clearClockEvent(this.onTxCompleteEvent);
    this.rxBytes.length = 0;
    this.rxHead = 0;
    this.txShiftByte = null;
    this.txBufferByte = null;
    this.cpu.data[UCSR0A] = (1 << UDRE0);
    this.cpu.data[UCSR0C] = (1 << UCSZ01) | (1 << UCSZ00);
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
    this.refreshStatusFlagsAndInterrupts();
  }

  @OnWrite(UCSR0A)
  onWriteUcsr0a(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    // TXC0 is write-1-to-clear. U2X0/MPCM0 are writable; RXC0/UDRE0 are
    // hardware-owned in this model.
    const hardware = (oldValue & UCSR0A_HARDWARE_MASK) & ~(value & (1 << TXC0));
    this.cpu.data[UCSR0A] = hardware | (value & UCSR0A_WRITABLE_MASK);
    this.refreshStatusFlagsAndInterrupts();
  }

  @OnWrite(UCSR0B)
  onWriteUcsr0b(): void {
    this.refreshInterruptSourcesEnabled();
    // Enabling RXEN0 should surface any already-queued RX bytes.
    this.refreshStatusFlagsAndInterrupts();
  }

  @OnWrite(UDR0)
  onWriteUdr0(_cpu: CPU, _addr: number, value: number): void {
    const byte = value & 0xff;
    if (!this.txEnabled()) {
      this.cpu.data[UDR0] = byte;
      return;
    }

    if (this.txBufferByte !== null) {
      // Hardware ignores writes while the transmit buffer is full.
      this.cpu.data[UDR0] = this.txBufferByte;
      return;
    }

    this.cpu.data[UDR0] = byte;
    this.cpu.data[UCSR0A] = this.cpu.readData(UCSR0A) & ~(1 << TXC0);
    if (this.txShiftByte === null) {
      this.startTxFrame(byte);
    } else {
      this.txBufferByte = byte;
      this.updateTxDataRegisterEmptyFlag();
    }
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

  private updateTxDataRegisterEmptyFlag(): void {
    if (this.txBufferByte === null) {
      this.cpu.data[UCSR0A] = this.cpu.data[UCSR0A]! | (1 << UDRE0);
    } else {
      this.cpu.data[UCSR0A] = this.cpu.data[UCSR0A]! & ~(1 << UDRE0);
    }
  }

  private startTxFrame(byte: number, remainingCycles = this.frameCycles()): void {
    this.txShiftByte = byte & 0xff;
    this.updateTxDataRegisterEmptyFlag();
    this.cpu.addClockEvent(this.onTxCompleteEvent, remainingCycles);
  }

  private completeTxFrame(): void {
    const byte = this.txShiftByte;
    this.txShiftByte = null;
    if (byte !== null) this.emitByte(byte);

    if (this.txBufferByte !== null) {
      const next = this.txBufferByte;
      this.txBufferByte = null;
      this.startTxFrame(next);
    } else {
      this.updateTxDataRegisterEmptyFlag();
      this.cpu.data[UCSR0A] = this.cpu.data[UCSR0A]! | (1 << TXC0);
    }
    this.updateInterrupts();
    this.scheduleInterruptPoll();
  }

  private frameCycles(): number {
    const ubrr = this.cpu.data[UBRR0L]! | (this.cpu.data[UBRR0H]! << 8);
    const baudDivider = (ubrr + 1) * ((this.cpu.data[UCSR0A]! & (1 << U2X0)) !== 0 ? 8 : 16);
    // simavr surfaces TXC0 one bit-time after the raw frame bits have shifted.
    return baudDivider * (this.frameBits() + 1);
  }

  private frameBits(): number {
    const controlB = this.cpu.data[UCSR0B]!;
    const controlC = this.cpu.data[UCSR0C]!;
    const sizeCode =
      ((controlB >> UCSZ02) & 1) << 2 |
      ((controlC >> UCSZ01) & 1) << 1 |
      ((controlC >> UCSZ00) & 1);
    const dataBits = sizeCode === 0b111 ? 9 : sizeCode + 5;
    const parityBits = (controlC & ((1 << UPM01) | (1 << UPM00))) === 0 ? 0 : 1;
    const stopBits = (controlC & (1 << USBS0)) === 0 ? 1 : 2;
    return 1 + dataBits + parityBits + stopBits;
  }

  private txRemainingCycles(): number {
    return this.txShiftByte === null ? 0 : this.cpu.clockEventRemainingCycles(this.onTxCompleteEvent);
  }

  private refreshStatusFlagsAndInterrupts(): void {
    this.updateTxDataRegisterEmptyFlag();
    this.updateRxFlag();
    this.updateInterrupts();
    this.scheduleInterruptPoll();
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
    return {
      rxBytes: bytes,
      rxHead: 0,
      txShiftByte: this.txShiftByte,
      txBufferByte: this.txBufferByte,
      txRemainingCycles: this.txRemainingCycles(),
    };
  }

  /** Restore queued RX bytes. UCSR0A/UCSR0B are restored with the CPU data. */
  restore(snap: Usart0Snapshot): void {
    this.rxBytes.length = 0;
    for (const byte of snap.rxBytes) this.rxBytes.push(byte);
    this.rxHead = snap.rxHead;
    this.txShiftByte = snap.txShiftByte ?? null;
    this.txBufferByte = snap.txBufferByte ?? null;
    this.cpu.clearClockEvent(this.onTxCompleteEvent);
    if (this.txShiftByte !== null) {
      this.cpu.addClockEvent(this.onTxCompleteEvent, snap.txRemainingCycles ?? this.frameCycles());
    }
    this.refreshInterruptSourcesEnabled();
    this.refreshStatusFlagsAndInterrupts();
  }
}
