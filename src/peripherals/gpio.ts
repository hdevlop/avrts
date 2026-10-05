import { OnRead, OnWrite } from "../core";
import {
  DDRB,
  DDRC,
  DDRD,
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

  constructor(private readonly cpu: CPU) {}

  // PORT writes (driven output level).
  @OnWrite(PORTB) onWritePortB(): void {
    this.notify("B");
  }
  @OnWrite(PORTC) onWritePortC(): void {
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
    this.notify("C");
  }
  @OnWrite(DDRD) onWriteDdrD(): void {
    this.notify("D");
  }

  // AVR writes a 1 to PINx to toggle the corresponding PORTx output latch.
  @OnWrite(PINB) onWritePinB(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.togglePortFromPinWrite("B", value, oldValue);
  }
  @OnWrite(PINC) onWritePinC(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.togglePortFromPinWrite("C", value, oldValue);
  }
  @OnWrite(PIND) onWritePinD(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.togglePortFromPinWrite("D", value, oldValue);
  }

  // Reading PINx returns the *effective* pin levels, so firmware (digitalRead,
  // IN PINx) sees driven outputs and injected inputs, not just the input latch.
  @OnRead(PINB) readPinRegB(): number {
    return this.effectivePinByte("B");
  }
  @OnRead(PINC) readPinRegC(): number {
    return this.effectivePinByte("C");
  }
  @OnRead(PIND) readPinRegD(): number {
    return this.effectivePinByte("D");
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
    const addr = PIN_ADDR[port];
    const cur = this.cpu.data[addr]!;
    this.cpu.data[addr] = high ? cur | (1 << bit) : cur & ~(1 << bit);
    this.notify(port);
  }

  /**
   * Drive an output pin from a peripheral such as a timer compare unit. This
   * affects effective PINx reads/listeners without mutating the PORT latch.
   * Pass `undefined` to release the pin back to normal PORT/DDR behavior.
   */
  setPeripheralOutput(port: PortName, bit: number, high: boolean | undefined): void {
    const mask = 1 << bit;
    const before = this.effectivePinByte(port);
    if (high === undefined) {
      this.peripheralMask[port] &= ~mask;
      this.peripheralValue[port] &= ~mask;
    } else {
      this.peripheralMask[port] |= mask;
      this.peripheralValue[port] = high
        ? this.peripheralValue[port] | mask
        : this.peripheralValue[port] & ~mask;
    }
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
    const ddr = this.cpu.readData(DDR_ADDR[port]);
    const portReg = this.cpu.readData(PORT_ADDR[port]);
    const inputs = this.cpu.data[PIN_ADDR[port]]!;
    const peripheralMask = this.peripheralMask[port] & ddr;
    const output = (portReg & ~peripheralMask) | (this.peripheralValue[port] & peripheralMask);
    return ((output & ddr) | (inputs & ~ddr)) & 0xff;
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
    const mask = value & 0xff;
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
    };
  }

  /**
   * Replace injected input bytes and peripheral overrides directly, then fire the
   * host listeners for each port. Hardware edge detectors only synchronize their
   * cached levels: restoring state must not manufacture a new interrupt.
   */
  restore(snap: GpioSnapshot): void {
    this.cpu.data[PINB] = snap.pin.B & 0xff;
    this.cpu.data[PINC] = snap.pin.C & 0xff;
    this.cpu.data[PIND] = snap.pin.D & 0xff;
    this.peripheralMask.B = snap.peripheralMask.B & 0xff;
    this.peripheralMask.C = snap.peripheralMask.C & 0xff;
    this.peripheralMask.D = snap.peripheralMask.D & 0xff;
    this.peripheralValue.B = snap.peripheralValue.B & 0xff;
    this.peripheralValue.C = snap.peripheralValue.C & 0xff;
    this.peripheralValue.D = snap.peripheralValue.D & 0xff;
    this.notify("B", true);
    this.notify("C", true);
    this.notify("D", true);
  }
}
