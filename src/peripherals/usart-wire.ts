import { DDRD, RXEN0, TXEN0, U2X0, UBRR0H, UBRR0L, UCSR0A, UCSR0B, UCSR0C } from "../cpu";
import type { CPU } from "../cpu";
import type { Gpio } from "./gpio";
import type { UsartRxFrame } from "./usart";

export interface UsartWireSnapshot {
  txBits: boolean[]; txIndex: number; txPeriod: number; txControl: number;
  rxIndex: number; rxValue: number; rxParity: boolean; rxError: boolean;
  rxSize: number; rxParityMode: number; rxPeriod: number; rxVotes: number; rxSamples: number;
  rxSampleWidth: number; rxControl: number;
  txRemaining: number; rxRemaining: number; clockHigh: boolean;
  txLevel?: boolean;
  startOnResume: boolean;
}

/** Optional pin-level USART clock/shift engine. Byte FIFOs remain owned by Usart0. */
export class UsartWire {
  private state: UsartWireSnapshot = this.empty();
  private paused = false;
  private enabled = false;
  private subscriptions: (() => void)[] = [];
  private readonly txEvent = () => this.txTick();
  private readonly rxEvent = () => this.rxTick();

  constructor(private readonly cpu: CPU, private readonly gpio: Gpio,
    private readonly receive: (frame: UsartRxFrame) => void,
    private readonly transmitted: () => void) {}

  private attach(): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(this.gpio.onPinChange("D", 0, (high) => {
      if (!high && this.enabled && !this.paused && this.mode() === 0 && this.rxEnabled() && this.state.rxIndex < 0) this.startRx();
    }, true));
    this.subscriptions.push(this.gpio.onPinChange("D", 4, (high) => {
      if (!this.enabled || this.paused || this.mode() === 0 || this.master()) return;
      this.syncEdge(high);
    }, true));
  }

  private empty(): UsartWireSnapshot {
    return { txBits: [], txIndex: 0, txPeriod: 0, txControl: 0, rxIndex: -1, rxValue: 0,
      rxParity: false, rxError: false, rxSize: 8, rxParityMode: 0, rxPeriod: 0, rxVotes: 0, rxSamples: 0,
      rxSampleWidth: 1, rxControl: 0,
      txRemaining: 0, rxRemaining: 0, clockHigh: false, txLevel: true, startOnResume: false };
  }

  reset(): void {
    this.cpu.clearClockEvent(this.txEvent);
    this.cpu.clearClockEvent(this.rxEvent);
    this.state = this.empty();
    this.paused = false;
    this.refresh();
  }

  use(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.attach();
    else { for (const off of this.subscriptions) off(); this.subscriptions = []; }
    this.reset();
  }
  busy(): boolean { return this.state.txBits.length > 0 || this.state.rxIndex >= 0; }
  private mode(): number { return this.cpu.data[UCSR0C]! >> 6; }
  private master(): boolean { return (this.cpu.data[DDRD]! & 16) !== 0; }
  private rxEnabled(): boolean { return (this.cpu.data[UCSR0B]! & (1 << RXEN0)) !== 0; }
  private dataSize(): number {
    const code = (this.cpu.data[UCSR0B]! & 4) | ((this.cpu.data[UCSR0C]! >> 1) & 3);
    return code === 7 ? 9 : Math.min(8, code + 5);
  }
  private period(): number {
    const ubrr = this.cpu.data[UBRR0L]! | (this.cpu.data[UBRR0H]! << 8);
    return (ubrr + 1) * (this.mode() === 0 ? ((this.cpu.data[UCSR0A]! & (1 << U2X0)) ? 8 : 16) : 2);
  }

  refresh(): void {
    const tx = this.enabled && ((this.cpu.data[UCSR0B]! & (1 << TXEN0)) !== 0 || this.state.txBits.length > 0);
    this.gpio.setPeripheralPin("D", 0, this.enabled && this.rxEnabled() ? "input" : undefined);
    if (tx) this.driveTx(this.state.txBits.length > 0
      ? this.state.txLevel ?? this.state.txBits[this.state.txIndex] ?? true : true);
    else this.gpio.setPeripheralPin("D", 1, undefined, true);
    if (!this.enabled || this.mode() === 0 || !this.master()) this.gpio.setPeripheralPin("D", 4, undefined);
    else if (this.state.txBits.length === 0) this.gpio.setPeripheralPin("D", 4, (this.cpu.data[UCSR0C]! & 1) !== 0);
    if (!this.rxEnabled()) {
      this.state.rxIndex = -1;
      this.cpu.clearClockEvent(this.rxEvent);
    }
  }

  startTx(value: number): void {
    const c = this.cpu.data[UCSR0C]!;
    const mspim = this.mode() === 3;
    const size = mspim ? 8 : this.dataSize();
    const bits: boolean[] = mspim ? [] : [false];
    let parity = false;
    for (let i = 0; i < size; i++) {
      const high = ((value >> (mspim && (c & 4) === 0 ? 7 - i : i)) & 1) !== 0;
      bits.push(high); parity = parity !== high;
    }
    if (!mspim) {
      if (c & 32) bits.push((c & 16) !== 0 ? !parity : parity);
      bits.push(true);
      if (c & 8) bits.push(true);
    }
    this.state.txBits = bits;
    this.state.txIndex = 0;
    this.state.txPeriod = this.period();
    this.state.txControl = c;
    this.state.clockHigh = (c & 1) !== 0;
    const preload = this.mode() === 0 || mspim;
    this.state.startOnResume = this.paused && preload;
    if (!this.paused && preload) this.driveTx(bits[0]!);
    if (this.mode() !== 0 && this.master()) this.gpio.setPeripheralPin("D", 4, this.state.clockHigh);
    const cycles = this.state.txPeriod / (this.mode() === 0 ? 1 : 2);
    if (this.paused) this.state.txRemaining = cycles;
    else if (this.mode() === 0 || this.master()) this.cpu.addClockEvent(this.txEvent, cycles);
  }

  private txTick(): void {
    if (this.state.txBits.length === 0) return;
    if (this.mode() !== 0) {
      this.state.clockHigh = !this.state.clockHigh;
      if ((this.state.txControl >> 6) === 3 && (this.state.txControl & 2) !== 0 && this.state.clockHigh !== ((this.state.txControl & 1) !== 0)) {
        this.driveTx(this.state.txBits[this.state.txIndex]!);
      }
      this.gpio.setPeripheralPin("D", 4, this.state.clockHigh);
      this.syncEdge(this.state.clockHigh);
      if (this.state.txBits.length > 0) this.cpu.addClockEvent(this.txEvent, this.state.txPeriod / 2);
      return;
    }
    this.advanceTx();
    if (this.state.txBits.length > 0) this.cpu.addClockEvent(this.txEvent, this.state.txPeriod);
  }

  private driveTx(high: boolean): void {
    this.state.txLevel = high;
    this.gpio.setPeripheralPin("D", 1, high, true);
  }

  private advanceTx(): void {
    if (++this.state.txIndex >= this.state.txBits.length) {
      this.state.txBits = [];
      this.driveTx(true);
      this.transmitted();
      this.refresh();
    } else this.driveTx(this.state.txBits[this.state.txIndex]!);
  }

  private syncEdge(high: boolean): void {
    const c = this.state.txBits.length ? this.state.txControl : this.cpu.data[UCSR0C]!;
    const idle = (c & 1) !== 0;
    const mspim = this.mode() === 3;
    const leading = high !== idle;
    const sampleEdge = mspim && (c & 2) === 0 ? leading : !leading;
    if (sampleEdge && this.rxEnabled()) {
      const level = this.gpio.readPin("D", 0);
      if (this.state.rxIndex < 0) {
        if (mspim) { this.startRx(); this.sampleRx(level, true); }
        else if (!level) { this.startRx(); this.sampleRx(false); }
      } else this.sampleRx(level, mspim);
    }
    // Synchronous USART changes TX on the leading edge and samples on the
    // trailing edge. MSPIM phase zero preloads and samples the first bit early.
    if (this.state.txBits.length > 0) {
      if (!mspim || (c & 2) !== 0) {
        if (leading) this.driveTx(this.state.txBits[this.state.txIndex]!);
        else if (++this.state.txIndex >= this.state.txBits.length) {
          this.state.txBits = [];
          this.transmitted(); this.refresh();
        }
      } else if (!leading) this.advanceTx();
    }
  }

  private startRx(): void {
    this.state.rxIndex = 0;
    this.state.rxValue = 0;
    this.state.rxParity = false;
    this.state.rxError = false;
    this.state.rxSize = this.mode() === 3 ? 8 : this.dataSize();
    this.state.rxParityMode = (this.cpu.data[UCSR0C]! >> 4) & 3;
    this.state.rxPeriod = this.period();
    this.state.rxControl = this.cpu.data[UCSR0C]!;
    this.state.rxSampleWidth = this.state.rxPeriod / ((this.cpu.data[UCSR0A]! & (1 << U2X0)) ? 8 : 16);
    this.state.rxSamples = 0;
    this.state.rxVotes = 0;
    if (this.mode() === 0) this.cpu.addClockEvent(this.rxEvent,
      this.state.rxPeriod / 2 - this.sampleWidth());
  }

  private sampleWidth(): number {
    return this.state.rxSampleWidth;
  }

  private rxTick(): void {
    if (this.state.rxIndex < 0) return;
    if (this.gpio.readPin("D", 0)) this.state.rxVotes++;
    if (++this.state.rxSamples < 3) this.cpu.addClockEvent(this.rxEvent, this.sampleWidth());
    else {
      this.sampleRx(this.state.rxVotes >= 2);
      this.state.rxSamples = 0; this.state.rxVotes = 0;
      if (this.state.rxIndex >= 0) this.cpu.addClockEvent(this.rxEvent, this.state.rxPeriod - 2 * this.sampleWidth());
    }
  }

  private sampleRx(high: boolean, mspim = false): void {
    const s = this.state;
    const index = s.rxIndex++;
    if (!mspim && index === 0) {
      if (high) s.rxIndex = -1; // Majority-high start bit is noise.
      return;
    }
    const dataIndex = mspim ? index : index - 1;
    if (dataIndex < s.rxSize) {
      const pos = mspim && (s.rxControl & 4) === 0 ? 7 - dataIndex : dataIndex;
      if (high) s.rxValue |= 1 << pos;
      s.rxParity = s.rxParity !== high;
      if (!mspim || dataIndex < 7) return;
    } else if (!mspim && s.rxParityMode >= 2 && dataIndex === s.rxSize) {
      s.rxError = high !== (s.rxParityMode === 3 ? !s.rxParity : s.rxParity);
      return;
    }
    this.receive({ value: s.rxValue, parityError: s.rxError, framingError: !mspim && !high });
    s.rxIndex = -1;
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.state.txRemaining = this.cpu.clockEventRemainingCycles(this.txEvent);
      this.state.rxRemaining = this.cpu.clockEventRemainingCycles(this.rxEvent);
      this.cpu.clearClockEvent(this.txEvent); this.cpu.clearClockEvent(this.rxEvent);
    } else {
      if (this.state.startOnResume) {
        this.state.startOnResume = false;
        this.driveTx(this.state.txBits[0]!);
      }
      if (this.state.txRemaining > 0) this.cpu.addClockEvent(this.txEvent, this.state.txRemaining);
      if (this.state.rxRemaining > 0) this.cpu.addClockEvent(this.rxEvent, this.state.rxRemaining);
    }
  }

  snapshot(): UsartWireSnapshot {
    return { ...this.state, txBits: [...this.state.txBits],
      txRemaining: this.paused ? this.state.txRemaining : this.cpu.clockEventRemainingCycles(this.txEvent),
      rxRemaining: this.paused ? this.state.rxRemaining : this.cpu.clockEventRemainingCycles(this.rxEvent) };
  }

  restore(snap: UsartWireSnapshot): void {
    this.cpu.clearClockEvent(this.txEvent); this.cpu.clearClockEvent(this.rxEvent);
    this.state = { ...snap, txBits: [...snap.txBits] };
    this.enabled = true; this.paused = false;
    this.attach();
    if (snap.txRemaining > 0) this.cpu.addClockEvent(this.txEvent, snap.txRemaining);
    if (snap.rxRemaining > 0) this.cpu.addClockEvent(this.rxEvent, snap.rxRemaining);
  }
}
