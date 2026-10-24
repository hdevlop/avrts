import { OnRead, OnWrite } from "../core";
import {
  DDRB,
  DDRC,
  DDRD,
  DIDR0,
  DIDR1,
  PINB,
  PINC,
  PIND,
  PORTB,
  PORTC,
  PORTD,
} from "../cpu";
import type { CPU } from "../cpu";
import type { GpioSnapshot } from "../snapshot";
import type { PortName } from "./types";

const PORT_ADDR: Record<PortName, number> = { B: PORTB, C: PORTC, D: PORTD };
const DDR_ADDR: Record<PortName, number> = { B: DDRB, C: DDRC, D: DDRD };
const PIN_ADDR: Record<PortName, number> = { B: PINB, C: PINC, D: PIND };

/**
 * Digital I/O for ports B, C and D. The @OnWrite hooks fire when the CPU writes a
 * PORT or DDR register; each notifies that port's subscribers, which then re-read
 * and report any actual change. External input is injected via `setInput`.
 */
export class Gpio {
  private readonly touched = new Map<PortName, Set<(restored: boolean) => void>>();
  private readonly peripheralMask: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  private readonly peripheralValue: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  private readonly forcedMask: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  private readonly drainMask: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  private readonly drainLow: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  private readonly ownedMask: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  private readonly ownedValue: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  private readonly ownedForced: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  private readonly ownedInput: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  private readonly drainListeners = new Set<() => void>();

  constructor(private readonly cpu: CPU) {}

  // PORT writes (driven output level).
  @OnWrite(PORTB) onWritePortB(): void {
    this.notify("B");
  }
  @OnWrite(PORTC) onWritePortC(): void {
    this.cpu.data[PORTC] = this.cpu.data[PORTC]! & 0x7f;
    this.notify("C");
  }
  @OnWrite(PORTD) onWritePortD(): void {
    this.notify("D");
  }

  // DDR writes (direction) can change a pin's effective level too.
  @OnWrite(DDRB) onWriteDdrB(): void {
    this.notify("B");
  }
  @OnWrite(DDRC) onWriteDdrC(): void {
    this.cpu.data[DDRC] = this.cpu.data[DDRC]! & 0x7f;
    this.notify("C");
  }
  @OnWrite(DDRD) onWriteDdrD(): void {
    this.notify("D");
  }

  // AVR writes a 1 to PINx to toggle the corresponding PORTx output latch.
  @OnWrite(PINB) onWritePinB(_cpu: CPU, _addr: number, value: number, oldValue: number, mask = 0xff): void {
    this.togglePortFromPinWrite("B", value & mask, oldValue);
  }
  @OnWrite(PINC) onWritePinC(_cpu: CPU, _addr: number, value: number, oldValue: number, mask = 0xff): void {
    this.togglePortFromPinWrite("C", value & mask, oldValue);
  }
  @OnWrite(PIND) onWritePinD(_cpu: CPU, _addr: number, value: number, oldValue: number, mask = 0xff): void {
    this.togglePortFromPinWrite("D", value & mask, oldValue);
  }

  // Reading PINx returns the *effective* pin levels, so firmware (digitalRead,
  // IN PINx) sees driven outputs and injected inputs, not just the input latch.
  @OnRead(PINB) readPinRegB(): number {
    return this.effectivePinByte("B");
  }
  @OnRead(PINC) readPinRegC(): number {
    return this.effectivePinByte("C") & ~this.cpu.data[DIDR0]!;
  }
  @OnRead(PIND) readPinRegD(): number {
    return this.effectivePinByte("D") & ~((this.cpu.data[DIDR1]! & 3) << 6);
  }

  /** Current PORT register value. */
  readPort(port: PortName): number {
    return this.cpu.readData(PORT_ADDR[port]);
  }

  /** Effective level of one pin: PORT bit if it's an output, else the injected input bit. */
  readPin(port: PortName, bit: number): boolean {
    return ((this.effectivePinByte(port) >> bit) & 1) === 1;
  }

  /** Inject an external input level onto a pin (writes the PIN register, then notifies). */
  setInput(port: PortName, bit: number, high: boolean): void {
    const mask = (1 << bit) & (port === "C" ? 0x7f : 0xff);
    if (mask === 0) return;
    const addr = PIN_ADDR[port];
    const cur = this.cpu.data[addr]!;
    this.cpu.data[addr] = high ? cur | mask : cur & ~mask;
    this.notify(port);
  }

  /**
   * Drive an output pin from a peripheral such as a timer compare unit. This
   * affects effective PINx reads/listeners without mutating the PORT latch.
   * Pass `undefined` to release the pin back to normal PORT/DDR behavior.
   */
  setPeripheralOutput(port: PortName, bit: number, high: boolean | undefined, forceDirection = false): void {
    const mask = (1 << bit) & (port === "C" ? 0x7f : 0xff);
    if (mask === 0) return;
    const before = this.effectivePinByte(port);
    if (high === undefined) {
      this.forcedMask[port] &= ~mask;
      this.peripheralMask[port] &= ~mask;
      this.peripheralValue[port] &= ~mask;
    } else {
      this.forcedMask[port] = forceDirection ? this.forcedMask[port] | mask : this.forcedMask[port] & ~mask;
      this.peripheralMask[port] |= mask;
      this.peripheralValue[port] = high
        ? this.peripheralValue[port] | mask
        : this.peripheralValue[port] & ~mask;
    }
    if (this.effectivePinByte(port) !== before) this.notify(port);
  }

  /** Open-drain ownership: false pulls low, true releases to external input, undefined releases ownership. */
  setOpenDrain(port: PortName, bit: number, released: boolean | undefined): void {
    const mask = 1 << bit;
    const before = this.effectivePinByte(port);
    const beforeMask = this.drainMask[port];
    const beforeLow = this.drainLow[port];
    if (released === undefined) {
      this.drainMask[port] &= ~mask;
      this.drainLow[port] &= ~mask;
    } else {
      this.drainMask[port] |= mask;
      this.drainLow[port] = released ? this.drainLow[port] & ~mask : this.drainLow[port] | mask;
    }
    if (this.effectivePinByte(port) !== before) this.notify(port);
    if (port === "C" && (bit === 4 || bit === 5) && (beforeMask !== this.drainMask[port] || beforeLow !== this.drainLow[port])) {
      for (const listener of [...this.drainListeners]) listener();
    }
  }

  readTwiDrive(): { sdaReleased: boolean; sclReleased: boolean } {
    return { sdaReleased: (this.drainLow.C & 16) === 0, sclReleased: (this.drainLow.C & 32) === 0 };
  }
  onTwiDrive(listener: () => void): () => void {
    this.drainListeners.add(listener); return () => { this.drainListeners.delete(listener); };
  }

  /** Serial alternate-function ownership takes precedence over PORT and timer outputs. */
  setPeripheralPin(port: PortName, bit: number, state: boolean | "input" | undefined, forceDirection = false): void {
    const mask = 1 << bit;
    const before = this.effectivePinByte(port);
    this.ownedMask[port] = state === undefined ? this.ownedMask[port] & ~mask : this.ownedMask[port] | mask;
    this.ownedValue[port] = state === true ? this.ownedValue[port] | mask : this.ownedValue[port] & ~mask;
    this.ownedForced[port] = forceDirection && state !== undefined && state !== "input" ? this.ownedForced[port] | mask : this.ownedForced[port] & ~mask;
    this.ownedInput[port] = state === "input" ? this.ownedInput[port] | mask : this.ownedInput[port] & ~mask;
    if (this.effectivePinByte(port) !== before) this.notify(port);
  }

  /** Subscribe to raw PORT-register value changes. */
  onPortValueChange(port: PortName, listener: (value: number, oldValue: number) => void): () => void {
    let prev = this.readPort(port);
    return this.onTouched(port, () => {
      const value = this.readPort(port);
      if (value !== prev) {
        const oldValue = prev;
        prev = value;
        listener(value, oldValue);
      }
    });
  }

  /** Subscribe to effective level changes of a single pin. */
  onPinChange(port: PortName, bit: number, listener: (high: boolean) => void, ignoreRestore = false): () => void {
    let prev = this.readPin(port, bit);
    return this.onTouched(port, (restored) => {
      const high = this.readPin(port, bit);
      if (high !== prev) {
        prev = high;
        if (!restored || !ignoreRestore) listener(high);
      }
    });
  }

  /** Effective levels of all 8 pins of a port, packed into a byte (for PCINT). */
  readPinByte(port: PortName): number {
    return this.effectivePinByte(port);
  }

  /**
   * The byte a read of PINx yields: output bits come from the PORT latch, input
   * bits from the injected external level held in the PIN register.
   */
  private effectivePinByte(port: PortName): number {
    let ddr = this.cpu.readData(DDR_ADDR[port]);
    const owned = this.ownedMask[port];
    if (owned !== 0 || this.forcedMask[port] !== 0) ddr = (ddr | this.forcedMask[port] | this.ownedForced[port]) & ~this.ownedInput[port];
    const portReg = this.cpu.readData(PORT_ADDR[port]);
    const inputs = this.cpu.data[PIN_ADDR[port]]!;
    const peripheralMask = this.peripheralMask[port] & ddr;
    const timerOutput = (portReg & ~peripheralMask) | (this.peripheralValue[port] & peripheralMask);
    const output = owned === 0 ? timerOutput : (timerOutput & ~owned) | (this.ownedValue[port] & owned);
    const pushPull = (output & ddr) | (inputs & ~ddr);
    const drain = this.drainMask[port];
    return (drain === 0 ? pushPull : (pushPull & ~drain) | (inputs & drain & ~this.drainLow[port])) & (port === "C" ? 0x7f : 0xff);
  }

  /** Public subscription used by the pin-change-interrupt controller. */
  onPortTouched(port: PortName, cb: () => void): () => void {
    return this.onTouched(port, (restored) => { if (!restored) cb(); });
  }

  /** Low-level: run `cb` whenever anything on `port` is touched (PORT/DDR/PIN). */
  private onTouched(port: PortName, cb: (restored: boolean) => void): () => void {
    let set = this.touched.get(port);
    if (!set) {
      set = new Set();
      this.touched.set(port, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  private notify(port: PortName, restored = false): void {
    const set = this.touched.get(port);
    if (set) for (const cb of [...set]) cb(restored);
  }

  private togglePortFromPinWrite(port: PortName, value: number, oldValue: number): void {
    this.cpu.data[PIN_ADDR[port]] = oldValue;
    const mask = value & (port === "C" ? 0x7f : 0xff);
    if (mask === 0) return;
    this.cpu.writeData(PORT_ADDR[port], this.cpu.readData(PORT_ADDR[port]) ^ mask);
  }

  // --- Snapshot / restore (Phase 10) ---

  /**
   * Capture the injected input levels (PINB/PINC/PIND bytes) and the timer-driven
   * override mask+value per port. PORT/DDR latch bytes live in the CPU data
   * snapshot already, so we don't duplicate them here.
   */
  snapshot(): GpioSnapshot {
    return {
      pin: {
        B: this.cpu.data[PINB]!,
        C: this.cpu.data[PINC]!,
        D: this.cpu.data[PIND]!,
      },
      peripheralMask: { ...this.peripheralMask },
      peripheralValue: { ...this.peripheralValue },
      forcedMask: { ...this.forcedMask },
      drainMask: { ...this.drainMask },
      drainLow: { ...this.drainLow },
      ownedMask: { ...this.ownedMask }, ownedValue: { ...this.ownedValue },
      ownedForced: { ...this.ownedForced }, ownedInput: { ...this.ownedInput },
    };
  }

  /**
   * Replace injected input bytes and peripheral overrides directly, then fire the
   * host listeners for each port. Hardware edge detectors only synchronize their
   * cached levels: restoring state must not manufacture a new interrupt.
   */
  restore(snap: GpioSnapshot): void {
    for (const port of ["B", "C", "D"] as const) {
      this.forcedMask[port] = snap.forcedMask?.[port] ?? 0;
      this.drainMask[port] = snap.drainMask?.[port] ?? 0;
      this.drainLow[port] = snap.drainLow?.[port] ?? 0;
      this.ownedMask[port] = snap.ownedMask?.[port] ?? 0;
      this.ownedValue[port] = snap.ownedValue?.[port] ?? 0;
      this.ownedForced[port] = snap.ownedForced?.[port] ?? 0;
      this.ownedInput[port] = snap.ownedInput?.[port] ?? 0;
    }
    this.cpu.data[PINB] = snap.pin.B & 0xff;
    this.cpu.data[PINC] = snap.pin.C & 0x7f;
    this.cpu.data[PORTC] = this.cpu.data[PORTC]! & 0x7f;
    this.cpu.data[DDRC] = this.cpu.data[DDRC]! & 0x7f;
    this.cpu.data[PIND] = snap.pin.D & 0xff;
    this.peripheralMask.B = snap.peripheralMask.B & 0xff;
    this.peripheralMask.C = snap.peripheralMask.C & 0x7f;
    this.peripheralMask.D = snap.peripheralMask.D & 0xff;
    this.peripheralValue.B = snap.peripheralValue.B & 0xff;
    this.peripheralValue.C = snap.peripheralValue.C & 0x7f;
    this.peripheralValue.D = snap.peripheralValue.D & 0xff;
    this.notify("B", true);
    this.notify("C", true);
    this.notify("D", true);
  }
}
