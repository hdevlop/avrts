import { OnWrite } from "../core";
import { WDE, WDIE, WDP3, WDT_VECTOR, WDTCSR } from "../cpu";
import type { CPU } from "../cpu";
import type { WatchdogSnapshot } from "../snapshot";

// Watchdog timeout periods in milliseconds, indexed by the 4-bit WDP value.
const PERIOD_MS = [16, 32, 64, 125, 250, 500, 1000, 2000, 4000, 8000] as const;

/**
 * Watchdog timer. Counts elapsed CPU cycles (a proxy for real time) and, on
 * timeout, either fires the WDT interrupt (WDIE mode, clearing WDIE so a second
 * timeout would reset) or resets the CPU (WDE mode). `WDR` resets the count.
 */
export class Watchdog {
  private accumulatedCycles = 0;

  constructor(
    private readonly cpu: CPU,
    private clockHz: number,
  ) {
    this.cpu.onWdr(() => this.kick());
  }

  setClock(clockHz: number): void {
    this.clockHz = clockHz;
  }

  reset(): void {
    this.accumulatedCycles = 0;
  }

  /** Reset the timeout window (the WDR instruction). */
  kick(): void {
    this.accumulatedCycles = 0;
  }

  tick(cycles: number): void {
    if (!this.enabled()) {
      this.accumulatedCycles = 0;
      return;
    }
    this.accumulatedCycles += cycles;
    if (this.accumulatedCycles < this.timeoutCycles()) return;
    this.accumulatedCycles = 0;
    this.fire();
  }

  @OnWrite(WDTCSR)
  onWriteWdtcsr(): void {
    this.accumulatedCycles = 0; // reconfiguring restarts the timeout window
  }

  private fire(): void {
    const wdtcsr = this.cpu.readData(WDTCSR);
    if ((wdtcsr & (1 << WDIE)) !== 0) {
      this.cpu.requestInterrupt(WDT_VECTOR);
      // Interrupt-and-reset mode: hardware clears WDIE after the interrupt fires.
      this.cpu.data[WDTCSR] = wdtcsr & ~(1 << WDIE);
    } else if ((wdtcsr & (1 << WDE)) !== 0) {
      this.cpu.reset();
    }
  }

  private enabled(): boolean {
    const wdtcsr = this.cpu.readData(WDTCSR);
    return (wdtcsr & (1 << WDE)) !== 0 || (wdtcsr & (1 << WDIE)) !== 0;
  }

  private timeoutCycles(): number {
    const wdtcsr = this.cpu.readData(WDTCSR);
    const wdp = (((wdtcsr >> WDP3) & 1) << 3) | (wdtcsr & 0x07);
    const ms = PERIOD_MS[Math.min(wdp, PERIOD_MS.length - 1)]!;
    return Math.max(1, Math.round((ms / 1000) * this.clockHz));
  }

  // --- Snapshot / restore (Phase 10) ---

  snapshot(): WatchdogSnapshot {
    return { accumulatedCycles: this.accumulatedCycles };
  }

  restore(snap: WatchdogSnapshot): void {
    this.accumulatedCycles = snap.accumulatedCycles;
  }
}
