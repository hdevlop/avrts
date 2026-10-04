import { OnRead, OnWrite } from "../core";
import {
  DOR0,
  FE0,
  MPCM0,
  RXB80,
  RXC0,
  RXCIE0,
  RXEN0,
  TXB80,
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
  UMSEL00,
  UPE0,
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

const UCSR0A_HARDWARE_MASK =
  (1 << RXC0) | (1 << TXC0) | (1 << UDRE0) | (1 << FE0) | (1 << DOR0) | (1 << UPE0);
const UCSR0A_WRITABLE_MASK = (1 << U2X0) | (1 << MPCM0);

// Datasheet: the receiver has a two-level FIFO behind the shift register.
const RX_FIFO_DEPTH = 2;

// UMSEL01:UMSEL00 values (UCSR0C bits 7:6).
const MODE_ASYNC = 0;
const MODE_MSPIM = 3;

/** One received frame: 9 data bits plus the error state it arrived with. */
export interface UsartRxFrame {
  /** 9-bit data value; bit 8 is the ninth data bit (address bit under MPCM). */
  value: number;
  /** Simulated framing error (stop bit low) — surfaces as FE0 at the FIFO head. */
  framingError?: boolean;
  /** Simulated parity error — surfaces as UPE0 when parity mode is enabled. */
  parityError?: boolean;
}

interface RxFrame {
  value: number;
  framingError: boolean;
  parityError: boolean;
}

type MspimResponder = (byte: number) => number;

// Snapshot encoding: 9 data bits, then framing/parity error flags.
function encodeFrame(frame: RxFrame): number {
  return (frame.value & 0x1ff) | (frame.framingError ? 0x200 : 0) | (frame.parityError ? 0x400 : 0);
}

function decodeFrame(encoded: number): RxFrame {
  return {
    value: encoded & 0x1ff,
    framingError: (encoded & 0x200) !== 0,
    parityError: (encoded & 0x400) !== 0,
  };
}

/**
 * USART0 model. TX and RX are both scheduled by baud/frame timing: TX writes
 * fill the AVR's double buffer and reach host listeners when the frame ends;
 * host-injected RX frames cross a simulated wire one frame at a time into the
 * hardware 2-level FIFO (RXC0/FE0/DOR0/UPE0/RXB80 reflect the FIFO head).
 * Synchronous mode changes only the bit clock (XCK is not wired to a GPIO pin);
 * MSPIM transfers exchange bytes with a host responder at frame completion.
 */
export class Usart0 {
  private readonly txListeners = new Set<SerialByteListener>();
  private readonly rxWire: RxFrame[] = [];
  private rxShift: RxFrame | null = null;
  private readonly rxFifo: RxFrame[] = [];
  private rxOverrun = false;
  private interruptSourcesEnabled = false;
  private txShiftByte: number | null = null;
  private txBufferByte: number | null = null;
  private mspimResponder: MspimResponder = () => 0xff;
  private powerReduced = false;
  private frozenTxRemainingCycles = 0;
  private frozenRxRemainingCycles = 0;
  private frozenInterruptRemainingCycles = 0;
  private readonly onTxCompleteEvent = (): void => {
    this.completeTxFrame();
  };
  private readonly onRxCompleteEvent = (): void => {
    this.completeRxFrame();
  };
  private readonly onInterruptEvent = (): void => {
    this.updateInterrupts();
    this.scheduleInterruptPoll();
  };

  constructor(private readonly cpu: CPU) {
    this.reset();
  }

  reset(): void {
    this.powerReduced = false;
    this.frozenTxRemainingCycles = 0;
    this.frozenRxRemainingCycles = 0;
    this.frozenInterruptRemainingCycles = 0;
    this.cpu.clearClockEvent(this.onTxCompleteEvent);
    this.cpu.clearClockEvent(this.onRxCompleteEvent);
    this.rxWire.length = 0;
    this.rxFifo.length = 0;
    this.rxShift = null;
    this.rxOverrun = false;
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

  /** Supply the byte clocked in for each MSPIM (UMSEL=11) transfer. */
  respondWith(responder: MspimResponder): void {
    this.mspimResponder = responder;
  }

  /** Queue host bytes on the simulated RX wire (one frame time each). */
  receive(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    for (const byte of bytes) this.inject({ value: byte & 0xff });
  }

  /** Queue one RX frame with full control over the ninth bit and error flags. */
  inject(frame: UsartRxFrame): void {
    this.rxWire.push({
      value: frame.value & 0x1ff,
      framingError: frame.framingError === true,
      parityError: frame.parityError === true,
    });
    this.maybeStartRxShift();
    this.refreshStatusFlagsAndInterrupts();
  }

  @OnWrite(UCSR0A)
  onWriteUcsr0a(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    // TXC0 is write-1-to-clear. U2X0/MPCM0 are writable; RXC0/UDRE0 and the
    // error flags (FE0/DOR0/UPE0) are hardware-owned in this model.
    const hardware = (oldValue & UCSR0A_HARDWARE_MASK) & ~(value & (1 << TXC0));
    this.cpu.data[UCSR0A] = hardware | (value & UCSR0A_WRITABLE_MASK);
    this.refreshStatusFlagsAndInterrupts();
  }

  @OnWrite(UCSR0B)
  onWriteUcsr0b(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.refreshInterruptSourcesEnabled();
    if ((oldValue & (1 << RXEN0)) !== 0 && (value & (1 << RXEN0)) === 0) {
      // Disabling the receiver flushes the FIFO and aborts the in-flight frame.
      this.rxFifo.length = 0;
      this.rxShift = null;
      this.rxOverrun = false;
      this.cpu.clearClockEvent(this.onRxCompleteEvent);
    }
    // Enabling RXEN0 starts shifting any frames already queued on the wire.
    this.maybeStartRxShift();
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
      this.cpu.data[UDR0] = this.txBufferByte & 0xff;
      return;
    }

    const ninth = (this.cpu.data[UCSR0B]! & (1 << TXB80)) !== 0 ? 0x100 : 0;
    this.cpu.data[UDR0] = byte;
    this.cpu.data[UCSR0A] = this.cpu.readData(UCSR0A) & ~(1 << TXC0);
    if (this.txShiftByte === null) {
      this.startTxFrame(byte | ninth);
    } else {
      this.txBufferByte = byte | ninth;
      this.updateTxDataRegisterEmptyFlag();
    }
    this.updateInterrupts();
    this.scheduleInterruptPoll();
  }

  /** Firmware read of UDR0: pop the FIFO head and refresh the status flags. */
  @OnRead(UDR0)
  readUdr0(): number {
    if (this.rxEnabled() && this.rxFifo.length > 0) {
      const entry = this.rxFifo.shift()!;
      this.cpu.data[UDR0] = entry.value & 0xff;
      // Error flags are valid until the receive buffer is read.
      this.rxOverrun = false;
    }
    const byte = this.cpu.data[UDR0]!;
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

  /** UMSEL01:UMSEL00 — 0 async, 1 synchronous, 3 master SPI (MSPIM). */
  private mode(): number {
    return (this.cpu.data[UCSR0C]! >> UMSEL00) & 0b11;
  }

  private isMspim(): boolean {
    return this.mode() === MODE_MSPIM;
  }

  private mpcmEnabled(): boolean {
    return !this.isMspim() && (this.cpu.data[UCSR0A]! & (1 << MPCM0)) !== 0;
  }

  private parityEnabled(): boolean {
    return (this.cpu.data[UCSR0C]! & (1 << UPM01)) !== 0;
  }

  private maybeStartRxShift(): void {
    if (this.rxShift !== null) return;
    if (this.powerReduced) return;
    // Frames wait on the wire while the receiver is disabled; MSPIM receives
    // only through transfers (the master supplies the clock).
    if (!this.rxEnabled() || this.isMspim()) return;
    const frame = this.rxWire.shift();
    if (frame === undefined) return;
    this.rxShift = frame;
    this.cpu.addClockEvent(this.onRxCompleteEvent, this.frameCycles());
  }

  private completeRxFrame(): void {
    const frame = this.rxShift;
    this.rxShift = null;
    if (frame !== null && this.rxEnabled()) this.receiveIntoFifo(frame);
    this.maybeStartRxShift();
    this.refreshStatusFlagsAndInterrupts();
  }

  private receiveIntoFifo(frame: RxFrame): void {
    // MPCM: frames whose ninth (address) bit is clear are ignored.
    if (this.mpcmEnabled() && (frame.value & 0x100) === 0) return;
    if (this.rxFifo.length >= RX_FIFO_DEPTH) {
      // Character lost between the buffer and the shift register.
      this.rxOverrun = true;
      return;
    }
    this.rxFifo.push(frame);
  }

  private emitByte(byte: number): void {
    if (this.txListeners.size === 0) return;
    if (this.txListeners.size === 1) {
      this.txListeners.values().next().value?.(byte);
      return;
    }
    for (const listener of [...this.txListeners]) listener(byte);
  }

  /** RXC0, FE0/DOR0/UPE0, and RXB80 all describe the FIFO head, per datasheet. */
  private updateRxFlag(): void {
    const head = this.rxEnabled() ? this.rxFifo[0] : undefined;
    let status =
      this.cpu.data[UCSR0A]! & ~((1 << RXC0) | (1 << FE0) | (1 << DOR0) | (1 << UPE0));
    if (head !== undefined) {
      status |= 1 << RXC0;
      if (head.framingError) status |= 1 << FE0;
      if (head.parityError && this.parityEnabled()) status |= 1 << UPE0;
    }
    if (this.rxOverrun && this.rxEnabled()) status |= 1 << DOR0;
    this.cpu.data[UCSR0A] = status;
    const controlB = this.cpu.data[UCSR0B]!;
    this.cpu.data[UCSR0B] =
      head !== undefined && (head.value & 0x100) !== 0
        ? controlB | (1 << RXB80)
        : controlB & ~(1 << RXB80);
  }

  private updateTxDataRegisterEmptyFlag(): void {
    if (this.txBufferByte === null) {
      this.cpu.data[UCSR0A] = this.cpu.data[UCSR0A]! | (1 << UDRE0);
    } else {
      this.cpu.data[UCSR0A] = this.cpu.data[UCSR0A]! & ~(1 << UDRE0);
    }
  }

  private startTxFrame(byte9: number, remainingCycles = this.frameCycles()): void {
    this.txShiftByte = byte9 & 0x1ff;
    this.updateTxDataRegisterEmptyFlag();
    if (this.powerReduced) {
      this.frozenTxRemainingCycles = remainingCycles;
      return;
    }
    this.cpu.addClockEvent(this.onTxCompleteEvent, remainingCycles);
  }

  private completeTxFrame(): void {
    const byte9 = this.txShiftByte;
    this.txShiftByte = null;
    if (byte9 !== null) {
      this.emitByte(byte9 & 0xff);
      // MSPIM clocks a byte in with every byte out, straight into the FIFO.
      if (this.isMspim() && this.rxEnabled()) {
        this.receiveIntoFifo({
          value: this.mspimResponder(byte9 & 0xff) & 0xff,
          framingError: false,
          parityError: false,
        });
      }
    }

    if (this.txBufferByte !== null) {
      const next = this.txBufferByte;
      this.txBufferByte = null;
      this.startTxFrame(next);
    } else {
      this.updateTxDataRegisterEmptyFlag();
      this.cpu.data[UCSR0A] = this.cpu.data[UCSR0A]! | (1 << TXC0);
    }
    this.updateRxFlag();
    this.updateInterrupts();
    this.scheduleInterruptPoll();
  }

  private frameCycles(): number {
    const ubrr = this.cpu.data[UBRR0L]! | (this.cpu.data[UBRR0H]! << 8);
    const mode = this.mode();
    // Async: 16 (or 8 with U2X0) clocks per bit; synchronous and MSPIM: 2.
    const perBit =
      mode === MODE_ASYNC ? ((this.cpu.data[UCSR0A]! & (1 << U2X0)) !== 0 ? 8 : 16) : 2;
    // simavr surfaces TXC0 one bit-time after the raw frame bits have shifted;
    // MSPIM is a raw 8-bit exchange with no start/stop/idle bits.
    const bits = mode === MODE_MSPIM ? 8 : this.frameBits() + 1;
    return Math.max(1, (ubrr + 1) * perBit * bits);
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
    if (this.powerReduced && this.txShiftByte !== null) return this.frozenTxRemainingCycles;
    return this.txShiftByte === null ? 0 : this.cpu.clockEventRemainingCycles(this.onTxCompleteEvent);
  }

  private rxRemainingCycles(): number {
    if (this.powerReduced && this.rxShift !== null) return this.frozenRxRemainingCycles;
    return this.rxShift === null ? 0 : this.cpu.clockEventRemainingCycles(this.onRxCompleteEvent);
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
    if (this.powerReduced) {
      this.cpu.clearClockEvent(this.onInterruptEvent);
      return;
    }
    if (this.hasEnabledReadySource()) {
      this.cpu.addClockEvent(this.onInterruptEvent, 1);
    } else {
      this.cpu.clearClockEvent(this.onInterruptEvent);
    }
  }

  private updateInterrupts(): void {
    if (this.powerReduced) return;
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
        this.cpu.data[UCSR0A] = this.cpu.data[UCSR0A]! & ~(1 << TXC0);
      });
    }
  }

  // --- Snapshot / restore (Phase 10) ---

  /** Capture RX wire/shift/FIFO frames and in-flight TX. Flags live in CPU data. */
  snapshot(): Usart0Snapshot {
    const pending = [...this.rxFifo, ...(this.rxShift !== null ? [this.rxShift] : []), ...this.rxWire];
    return {
      // Legacy field: pending RX bytes without frame metadata.
      rxBytes: Uint8Array.from(pending, (frame) => frame.value & 0xff),
      rxHead: 0,
      txShiftByte: this.txShiftByte,
      txBufferByte: this.txBufferByte,
      txRemainingCycles: this.txRemainingCycles(),
      rxFifo: this.rxFifo.map(encodeFrame),
      rxShiftFrame: this.rxShift === null ? null : encodeFrame(this.rxShift),
      rxRemainingCycles: this.rxRemainingCycles(),
      rxWire: this.rxWire.map(encodeFrame),
      rxOverrun: this.rxOverrun,
    };
  }

  /** Restore RX pipeline and TX state. UCSR0A/UCSR0B are restored with CPU data. */
  restore(snap: Usart0Snapshot): void {
    this.powerReduced = false;
    this.frozenTxRemainingCycles = 0;
    this.frozenRxRemainingCycles = 0;
    this.frozenInterruptRemainingCycles = 0;
    this.rxWire.length = 0;
    this.rxFifo.length = 0;
    this.rxShift = null;
    this.rxOverrun = false;
    this.cpu.clearClockEvent(this.onRxCompleteEvent);

    if (snap.rxFifo !== undefined) {
      for (const encoded of snap.rxFifo) this.rxFifo.push(decodeFrame(encoded));
      for (const encoded of snap.rxWire ?? []) this.rxWire.push(decodeFrame(encoded));
      this.rxOverrun = snap.rxOverrun === true;
      if (snap.rxShiftFrame !== null && snap.rxShiftFrame !== undefined) {
        this.rxShift = decodeFrame(snap.rxShiftFrame);
        this.cpu.addClockEvent(this.onRxCompleteEvent, snap.rxRemainingCycles ?? this.frameCycles());
      }
    } else {
      // Legacy snapshot: bytes were instantly readable; keep the first FIFO's
      // worth readable now and re-shift the rest over the wire.
      const bytes = snap.rxBytes.subarray(snap.rxHead);
      for (const byte of bytes) {
        const frame = { value: byte & 0xff, framingError: false, parityError: false };
        if (this.rxFifo.length < RX_FIFO_DEPTH) this.rxFifo.push(frame);
        else this.rxWire.push(frame);
      }
      this.maybeStartRxShift();
    }

    this.txShiftByte = snap.txShiftByte ?? null;
    this.txBufferByte = snap.txBufferByte ?? null;
    this.cpu.clearClockEvent(this.onTxCompleteEvent);
    if (this.txShiftByte !== null) {
      this.cpu.addClockEvent(this.onTxCompleteEvent, snap.txRemainingCycles ?? this.frameCycles());
    }
    this.refreshInterruptSourcesEnabled();
    this.refreshStatusFlagsAndInterrupts();
  }

  setPowerReduced(reduced: boolean): void {
    if (this.powerReduced === reduced) return;
    if (reduced) {
      this.frozenTxRemainingCycles = this.txRemainingCycles();
      this.frozenRxRemainingCycles = this.rxRemainingCycles();
      this.frozenInterruptRemainingCycles = this.cpu.clockEventRemainingCycles(this.onInterruptEvent);
      this.powerReduced = true;
      this.cpu.clearClockEvent(this.onTxCompleteEvent);
      this.cpu.clearClockEvent(this.onRxCompleteEvent);
      this.cpu.clearClockEvent(this.onInterruptEvent);
      return;
    }

    this.powerReduced = false;
    if (this.txShiftByte !== null) {
      this.cpu.addClockEvent(this.onTxCompleteEvent, this.frozenTxRemainingCycles || this.frameCycles());
    }
    if (this.rxShift !== null) {
      this.cpu.addClockEvent(this.onRxCompleteEvent, this.frozenRxRemainingCycles || this.frameCycles());
    } else {
      this.maybeStartRxShift();
    }
    if (this.frozenInterruptRemainingCycles > 0 && this.hasEnabledReadySource()) {
      this.cpu.addClockEvent(this.onInterruptEvent, this.frozenInterruptRemainingCycles);
    } else {
      this.scheduleInterruptPoll();
    }
    this.frozenTxRemainingCycles = 0;
    this.frozenRxRemainingCycles = 0;
    this.frozenInterruptRemainingCycles = 0;
  }
}
