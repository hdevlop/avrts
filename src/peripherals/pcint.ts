import { OnWrite } from "../core";
import {
  PCICR,
  PCIFR,
  PCINT0_VECTOR,
  PCINT1_VECTOR,
  PCINT2_VECTOR,
  PCMSK0,
  PCMSK1,
  PCMSK2,
} from "../cpu";
import type { CPU } from "../cpu";
import type { PcintSnapshot } from "../snapshot";
import type { Gpio } from "./gpio";
import type { PortName } from "./types";

interface PcintGroup {
  port: PortName;
  maskReg: number;
  vector: number;
  index: number; // PCIE/PCIF bit position
}

const GROUPS: readonly PcintGroup[] = [
  { port: "B", maskReg: PCMSK0, vector: PCINT0_VECTOR, index: 0 },
  { port: "C", maskReg: PCMSK1, vector: PCINT1_VECTOR, index: 1 },
  { port: "D", maskReg: PCMSK2, vector: PCINT2_VECTOR, index: 2 },
];

/**
 * Pin-change interrupts for ports B/C/D. Watches each port's effective pin levels;
 * when an enabled pin (PCMSKn) toggles it sets the PCIFn flag and, if PCIEn is on,
 * requests the matching PCINTn vector. `attach()` wires it to the GPIO device.
 */
export class PinChangeInterrupt {
  private readonly snapshots = new Map<PortName, number>();

  constructor(
    private readonly cpu: CPU,
    private readonly gpio: Gpio,
  ) {}

  /** Subscribe to GPIO port changes. Call once after construction. */
  attach(): void {
    for (const group of GROUPS) {
      this.snapshots.set(group.port, this.gpio.readPinByte(group.port));
      this.gpio.onPortTouched(group.port, () => this.evaluate(group));
    }
  }

  reset(): void {
    for (const group of GROUPS) {
      this.snapshots.set(group.port, this.gpio.readPinByte(group.port));
    }
  }

  @OnWrite(PCIFR)
  onWritePcifr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.cpu.data[PCIFR] = oldValue & ~value; // flags are write-1-to-clear
  }

  private evaluate(group: PcintGroup): void {
    const current = this.gpio.readPinByte(group.port);
    const previous = this.snapshots.get(group.port) ?? 0;
    this.snapshots.set(group.port, current);

    const enabledPins = this.cpu.readData(group.maskReg);
    const changed = (current ^ previous) & enabledPins;
    if (changed === 0) return;

    this.cpu.data[PCIFR] = this.cpu.readData(PCIFR) | (1 << group.index);
    if ((this.cpu.readData(PCICR) & (1 << group.index)) !== 0) {
      this.cpu.requestInterrupt(group.vector, () => {
        this.cpu.data[PCIFR] = this.cpu.readData(PCIFR) & ~(1 << group.index);
      });
    }
  }

  // --- Snapshot / restore (Phase 10) ---

  /** Capture the per-port last-seen pin byte used for edge detection. */
  snapshot(): PcintSnapshot {
    return {
      snapshots: {
        B: this.snapshots.get("B") ?? 0,
        C: this.snapshots.get("C") ?? 0,
        D: this.snapshots.get("D") ?? 0,
      },
    };
  }

  restore(snap: PcintSnapshot): void {
    this.snapshots.set("B", snap.snapshots.B & 0xff);
    this.snapshots.set("C", snap.snapshots.C & 0xff);
    this.snapshots.set("D", snap.snapshots.D & 0xff);
  }
}
