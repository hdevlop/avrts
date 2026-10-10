import { TWAR, TWAMR, TWBR, TWCR, TWDR, TWEA, TWEN, TWINT, TWSTA, TWSTO, TWSR } from "../cpu";
import type { CPU } from "../cpu";
import type { Gpio } from "./gpio";

export interface TwiWireSnapshot {
  operation: "start" | "stop" | "write" | "read" | null;
  phase: number; index: number; value: number; received: number; ack: boolean;
  started: boolean; address: boolean; reading: boolean; waitHigh: boolean; remaining: number;
  slave: "address" | "receive" | "transmit" | null;
  slaveIndex: number; slaveValue: number; matched: boolean; generalCall: boolean; slaveAck: boolean;
  scl: boolean; sda: boolean;
  arbitrationLost: boolean;
}

/** Logical open-drain I2C engine, with clock stretching and sampled arbitration. */
export class TwiWire {
  private state: TwiWireSnapshot = this.empty();
  private enabled = false;
  private paused = false;
  private driving = false;
  private subscriptions: (() => void)[] = [];
  private readonly event = () => this.advance();
  constructor(private readonly cpu: CPU, private readonly gpio: Gpio,
    private readonly complete: (status: number) => void,
    private readonly stopped: () => void) {}
  private attach(): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(this.gpio.onPinChange("C", 5, (high) => this.clockChanged(high), true));
    this.subscriptions.push(this.gpio.onPinChange("C", 4, (high) => this.dataChanged(high), true));
  }
  private empty(): TwiWireSnapshot {
    return { operation: null, phase: 0, index: 0, value: 0, received: 0, ack: false,
      started: false, address: false, reading: false, waitHigh: false, remaining: 0,
      slave: null, slaveIndex: 0, slaveValue: 0, matched: false, generalCall: false, slaveAck: false,
      scl: true, sda: true, arbitrationLost: false };
  }
  use(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.attach();
    else { for (const off of this.subscriptions) off(); this.subscriptions = []; }
    this.reset();
  }
  busy(): boolean { return this.state.operation !== null || this.state.started || this.state.slave !== null; }
  reset(): void {
    this.cpu.clearClockEvent(this.event); this.state = this.empty(); this.paused = false;
    this.refresh();
  }
  refresh(): void {
    const active = this.enabled && (this.cpu.data[TWCR]! & (1 << TWEN)) !== 0;
    if (!active) {
      this.cpu.clearClockEvent(this.event);
      this.state = this.empty();
      this.drive(4, undefined); this.drive(5, undefined);
    } else if (this.state.operation === null && !this.state.started && !this.state.matched) {
      this.drive(4, true); this.drive(5, true);
    }
    this.state.scl = this.gpio.readPin("C", 5);
    this.state.sda = this.gpio.readPin("C", 4);
  }
  private drive(pin: number, released: boolean | undefined): void {
    this.driving = true;
    this.gpio.setOpenDrain("C", pin, released);
    this.state.scl = this.gpio.readPin("C", 5);
    this.state.sda = this.gpio.readPin("C", 4);
    this.driving = false;
  }
  private halfPeriod(): number {
    return (16 + 2 * this.cpu.data[TWBR]! * [1, 4, 16, 64][this.cpu.data[TWSR]! & 3]!) / 2;
  }
  private schedule(): void { if (!this.paused) this.cpu.addClockEvent(this.event, this.halfPeriod()); }
  command(value: number): void {
    if ((value & (1 << TWEN)) === 0) { this.refresh(); return; }
    if ((value & (1 << TWINT)) === 0 || this.state.operation !== null) return;
    this.cpu.data[TWCR] = value & ~(1 << TWINT);
    if (value & (1 << TWSTA)) {
      this.state.operation = "start"; this.state.phase = 0; this.schedule();
    } else if (value & (1 << TWSTO)) {
      if (this.state.started) { this.state.operation = "stop"; this.state.phase = 0; this.schedule(); }
      else { this.state.matched = false; this.state.slave = null; this.cpu.data[TWCR] = this.cpu.data[TWCR]! & ~(1 << TWSTO); this.refresh(); }
    } else if (this.state.started) {
      this.state.operation = this.state.reading && !this.state.address ? "read" : "write";
      this.state.phase = 0; this.state.index = 0; this.state.value = this.cpu.data[TWDR]!;
      this.state.received = 0; this.advance();
    } else if (this.state.matched) {
      this.state.slaveIndex = 0; this.state.slaveValue = this.cpu.data[TWDR]!;
      if (this.state.slave === "transmit") this.drive(4, (this.state.slaveValue & 128) !== 0);
      else this.drive(4, true);
      const wasHigh = this.gpio.readPin("C", 5);
      this.drive(5, true);
      if (!wasHigh && this.gpio.readPin("C", 5)) this.clockChanged(true);
    } else this.refresh();
  }
  private releaseClock(): boolean {
    this.drive(5, true);
    if (!this.gpio.readPin("C", 5)) { this.state.waitHigh = true; return false; }
    return true;
  }
  private advance(): void {
    if (this.paused || this.state.operation === null) return;
    const s = this.state;
    if (s.operation === "start") {
      if (s.phase === 0) {
        this.drive(4, true);
        if (!this.releaseClock()) return;
        if (!this.gpio.readPin("C", 4)) { s.waitHigh = true; return; }
        s.phase = 1; this.schedule();
      } else {
        this.drive(4, false); this.drive(5, false);
        const status = s.started ? 0x10 : 0x08;
        s.started = true; s.address = true; s.reading = false; s.operation = null;
        this.complete(status);
      }
      return;
    }
    if (s.operation === "stop") {
      if (s.phase === 0) {
        this.drive(5, false); this.drive(4, false); s.phase = 1; this.schedule();
      } else if (s.phase === 1) {
        if (!this.releaseClock()) return;
        s.phase = 2; this.schedule();
      } else {
        this.drive(4, true); s.operation = null; s.started = false; s.address = false;
        this.stopped();
      }
      return;
    }
    if (s.phase === 0) {
      this.drive(5, false);
      const released = s.index === 8 ? s.operation === "write" || (this.cpu.data[TWCR]! & (1 << TWEA)) === 0
        : s.operation === "read" || ((s.value >> (7 - s.index)) & 1) !== 0;
      this.drive(4, released); s.phase = 1; this.schedule();
    } else if (s.phase === 1) {
      if (!this.releaseClock()) return;
      const high = this.gpio.readPin("C", 4);
      if (s.index < 8) {
        s.received = (s.received << 1) | Number(high);
        if (s.operation === "write" && ((s.value >> (7 - s.index)) & 1) !== 0 && !high) {
          this.loseArbitration(); return;
        }
      } else {
        s.ack = !high;
        if (s.operation === "read" && (this.cpu.data[TWCR]! & (1 << TWEA)) === 0 && !high) { this.loseArbitration(); return; }
      }
      s.phase = 2; this.schedule();
    } else {
      this.drive(5, false);
      if (++s.index < 9) { s.phase = 0; this.advance(); }
      else {
        this.drive(4, true);
        let status: number;
        if (s.operation === "read") {
          this.cpu.data[TWDR] = s.received;
          status = (this.cpu.data[TWCR]! & (1 << TWEA)) !== 0 ? 0x50 : 0x58;
        } else if (s.address) {
          s.reading = (s.value & 1) !== 0; s.address = false;
          status = s.reading ? (s.ack ? 0x40 : 0x48) : (s.ack ? 0x18 : 0x20);
        } else status = s.ack ? 0x28 : 0x30;
        s.operation = null; this.complete(status);
      }
    }
  }
  private loseArbitration(): void {
    if (this.state.address && this.state.index < 8) {
      this.state.slave = "address";
      this.state.slaveIndex = this.state.index + 1;
      this.state.slaveValue = this.state.received;
      this.state.arbitrationLost = true;
    }
    this.cpu.clearClockEvent(this.event);
    this.state.operation = null; this.state.started = false; this.state.address = false;
    this.drive(4, true); this.drive(5, true);
    this.complete(0x38);
  }
  private active(): boolean { return this.enabled && !this.paused && (this.cpu.data[TWCR]! & (1 << TWEN)) !== 0; }
  private dataChanged(high: boolean): void {
    const s = this.state; const previous = s.sda; s.sda = high;
    if (this.driving || !this.active() || !this.gpio.readPin("C", 5)) return;
    if (s.waitHigh && s.operation === "start" && high) { s.waitHigh = false; this.advance(); return; }
    if (s.operation !== null || s.started || high === previous) return;
    if (s.matched) {
      const receiver = s.slave === "receive";
      s.matched = false; s.slave = null; this.drive(4, true); this.drive(5, true);
      if (receiver) this.complete(0xa0);
    }
    if (!high) { s.slave = "address"; s.slaveIndex = 0; s.slaveValue = 0; }
  }
  private clockChanged(high: boolean): void {
    const s = this.state; s.scl = high;
    if (this.driving || !this.active()) return;
    if (s.waitHigh && high && s.operation !== null) { s.waitHigh = false; this.advance(); return; }
    if (s.operation !== null || s.started || s.slave === null || ((this.cpu.data[TWCR]! & (1 << TWINT)) !== 0 && !s.arbitrationLost)) return;
    if (high) {
      if (s.slaveIndex < 8) {
        if (s.slave !== "transmit") s.slaveValue = (s.slaveValue << 1) | Number(this.gpio.readPin("C", 4));
      } else s.slaveAck = !this.gpio.readPin("C", 4);
      s.slaveIndex++;
    } else {
      if (s.slaveIndex === 8) {
        if (s.slave === "address") {
          const address = s.slaveValue >> 1; const own = this.cpu.data[TWAR]! >> 1;
          const mask = this.cpu.data[TWAMR]! >> 1;
          s.generalCall = address === 0 && (s.slaveValue & 1) === 0 && (this.cpu.data[TWAR]! & 1) !== 0;
          s.matched = (this.cpu.data[TWCR]! & (1 << TWEA)) !== 0 && (address === 0 ? s.generalCall : ((address ^ own) & ~mask) === 0);
          this.drive(4, !s.matched);
        } else if (s.slave === "receive") this.drive(4, (this.cpu.data[TWCR]! & (1 << TWEA)) === 0);
        else this.drive(4, true);
      } else if (s.slaveIndex === 9) {
        if (!s.matched) { s.slave = null; this.drive(4, true); return; }
        let code: number;
        if (s.slave === "address") {
          const read = (s.slaveValue & 1) !== 0;
          s.slave = read ? "transmit" : "receive";
          code = read ? 0xa8 : s.generalCall ? 0x70 : 0x60;
          if (s.arbitrationLost) { code += 8; s.arbitrationLost = false; }
        } else if (s.slave === "receive") {
          this.cpu.data[TWDR] = s.slaveValue & 255;
          const ack = (this.cpu.data[TWCR]! & (1 << TWEA)) !== 0;
          code = s.generalCall ? (ack ? 0x90 : 0x98) : (ack ? 0x80 : 0x88);
        } else code = s.slaveAck ? ((this.cpu.data[TWCR]! & (1 << TWEA)) !== 0 ? 0xb8 : 0xc8) : 0xc0;
        this.drive(5, false); this.drive(4, true); this.complete(code);
      } else if (s.slave === "transmit") {
        this.drive(4, ((s.slaveValue >> (7 - s.slaveIndex)) & 1) !== 0);
      }
    }
  }
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) { this.state.remaining = this.cpu.clockEventRemainingCycles(this.event); this.cpu.clearClockEvent(this.event); }
    else if (this.state.remaining > 0) this.cpu.addClockEvent(this.event, this.state.remaining);
  }
  snapshot(): TwiWireSnapshot {
    return { ...this.state, remaining: this.paused ? this.state.remaining : this.cpu.clockEventRemainingCycles(this.event) };
  }
  restore(snap: TwiWireSnapshot): void {
    this.cpu.clearClockEvent(this.event); this.state = { ...snap }; this.enabled = true; this.paused = false;
    this.attach();
    if (snap.remaining > 0) this.cpu.addClockEvent(this.event, snap.remaining);
  }
}
