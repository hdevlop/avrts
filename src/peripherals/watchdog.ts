import { OnWrite } from "../core";
import { MCUSR, WDCE, WDE, WDIE, WDIF, WDP3, WDRF, WDT_VECTOR, WDTCSR } from "../cpu";
import type { CPU } from "../cpu";
import type { WatchdogSnapshot } from "../snapshot";

// Watchdog timeout periods in milliseconds, indexed by the 4-bit WDP value.
const PERIOD_MS = [16, 32, 64, 125, 250, 500, 1000, 2000, 4000, 8000] as const;
const PRESCALER_MASK = (1 << WDP3) | 0x07;

/**
 * Watchdog timer (Phase 7 event-driven). Instead of being ticked every
 * instruction, it schedules a single CPU clock event at its timeout cycle and
 * re-arms on `WDR` and prescaler changes. On timeout it either
 * fires the WDT interrupt (WDIE mode) or resets the CPU (WDE mode). Only the
 * combined interrupt/reset mode clears WDIE when its interrupt is serviced.
 */
export class Watchdog {
  private scheduled = false;
  private fireAtCycle = 0;
  private changeWindowOpen = false;
  private readonly closeChangeWindowEvent = (): void => {
    this.changeWindowOpen = false;
    this.cpu.data[WDTCSR] = this.cpu.data[WDTCSR]! & ~(1 << WDCE);
  };
  private readonly onSystemReset: () => void;
  private readonly alwaysOn: () => boolean;
  // Stable callback identity so addClockEvent/clearClockEvent pair up.
  private readonly timeoutEvent = (): void => this.onTimeout();

  constructor(
    private readonly cpu: CPU,
    private clockHz: number,
    options: { onSystemReset?: () => void; alwaysOn?: () => boolean } = {},
  ) {
    this.onSystemReset =
      options.onSystemReset ??
      (() => {
        this.cpu.reset();
        this.cpu.data[MCUSR] = 1 << WDRF;
      });
    this.alwaysOn = options.alwaysOn ?? (() => false);
    this.cpu.onWdr(() => this.kick());
  }

  setClock(clockHz: number): void {
    const remaining = this.scheduled ? Math.max(1, this.fireAtCycle - this.cpu.cycles) : 0;
    const previousClockHz = this.clockHz;
    this.clockHz = clockHz;
    if (this.scheduled) this.scheduleTimeout(Math.max(1, Math.round(remaining * clockHz / previousClockHz)));
  }

  reset(): void {
    this.cpu.clearClockEvent(this.closeChangeWindowEvent);
    this.changeWindowOpen = false;
    this.forceWdeIfNeeded();
    this.reschedule();
  }

  /** Reset the timeout window (the WDR instruction). */
  kick(): void {
    this.reschedule();
  }

  @OnWrite(WDTCSR)
  onWriteWdtcsr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    // WDIF belongs to hardware and is write-one-to-clear.
    const wasEnabled = this.scheduled;
    const unlock = (value & ((1 << WDCE) | (1 << WDE))) === ((1 << WDCE) | (1 << WDE));
    let control = (value & (1 << WDIE)) | (oldValue & ~value & (1 << WDIF));
    if (unlock) {
      control |= (oldValue & PRESCALER_MASK) | (1 << WDE) | (1 << WDCE);
      this.changeWindowOpen = true;
      this.cpu.addClockEvent(this.closeChangeWindowEvent, 4);
    } else if (this.changeWindowOpen) {
      control |= value & (PRESCALER_MASK | (1 << WDE));
      this.changeWindowOpen = false;
      this.cpu.clearClockEvent(this.closeChangeWindowEvent);
    } else {
      control |= (oldValue & PRESCALER_MASK) | ((oldValue | value) & (1 << WDE));
    }
    this.cpu.data[WDTCSR] = control;
    this.forceWdeIfNeeded();
    this.updateInterrupt();
    if (wasEnabled !== this.enabled() || ((oldValue ^ this.cpu.data[WDTCSR]!) & PRESCALER_MASK) !== 0) {
      this.reschedule();
    }
  }

  /** Hardware acknowledgement, also used to rebuild pending snapshot callbacks. */
  acknowledgeInterrupt(): void {
    const control = this.cpu.data[WDTCSR]!;
    const cleared = (1 << WDIF) | ((control & (1 << WDE)) !== 0 ? 1 << WDIE : 0);
    this.cpu.data[WDTCSR] = control & ~cleared;
  }

  private updateInterrupt(): void {
    const required = (1 << WDIE) | (1 << WDIF);
    if ((this.cpu.data[WDTCSR]! & required) === required) {
      this.cpu.requestInterrupt(WDT_VECTOR, () => this.acknowledgeInterrupt());
    } else {
      this.cpu.clearInterrupt(WDT_VECTOR);
    }
  }

  /** Drop any pending event and, if enabled, arm a fresh timeout window. */
  private reschedule(): void {
    this.cpu.clearClockEvent(this.timeoutEvent);
    this.scheduled = false;
    if (!this.enabled()) return;
    this.scheduleTimeout(this.timeoutCycles());
  }

  private scheduleTimeout(timeout: number): void {
    this.cpu.clearClockEvent(this.timeoutEvent);
    this.cpu.addClockEvent(this.timeoutEvent, timeout);
    this.fireAtCycle = this.cpu.cycles + timeout;
    this.scheduled = true;
  }

  private onTimeout(): void {
    this.scheduled = false;
    const reset = this.fire();
    if (!reset) this.reschedule(); // re-arm the next window if still enabled
  }

  private fire(): boolean {
    const wdtcsr = this.cpu.data[WDTCSR]!;
    if (this.alwaysOn() || ((wdtcsr & (1 << WDE)) !== 0 && (wdtcsr & (1 << WDIF)) !== 0)) {
      this.onSystemReset();
      return true;
    }
    if ((wdtcsr & (1 << WDIE)) !== 0) {
      this.cpu.data[WDTCSR] = wdtcsr | (1 << WDIF);
      this.updateInterrupt();
    } else if ((wdtcsr & (1 << WDE)) !== 0) {
      this.onSystemReset();
      return true;
    }
    return false;
  }

  private enabled(): boolean {
    const wdtcsr = this.cpu.data[WDTCSR]!;
    return (wdtcsr & (1 << WDE)) !== 0 || (wdtcsr & (1 << WDIE)) !== 0;
  }

  private forceWdeIfNeeded(): void {
    if (this.alwaysOn() || (this.cpu.data[MCUSR]! & (1 << WDRF)) !== 0) {
      this.cpu.data[WDTCSR] = this.cpu.data[WDTCSR]! | (1 << WDE);
    }
  }

  private timeoutCycles(): number {
    const wdtcsr = this.cpu.data[WDTCSR]!;
    const wdp = (((wdtcsr >> WDP3) & 1) << 3) | (wdtcsr & 0x07);
    const ms = PERIOD_MS[Math.min(wdp, PERIOD_MS.length - 1)]!;
    return Math.max(1, Math.round((ms / 1000) * this.clockHz));
  }

  // --- Snapshot / restore (Phase 10) ---

  snapshot(): WatchdogSnapshot {
    // Store elapsed-in-window so a restore can re-arm the remaining time.
    const accumulatedCycles = this.scheduled
      ? Math.max(0, this.timeoutCycles() - (this.fireAtCycle - this.cpu.cycles))
      : 0;
    return { accumulatedCycles, changeWindowRemainingCycles: this.cpu.clockEventRemainingCycles(this.closeChangeWindowEvent) };
  }

  restore(snap: WatchdogSnapshot): void {
    this.cpu.clearClockEvent(this.timeoutEvent);
    this.cpu.clearClockEvent(this.closeChangeWindowEvent);
    this.scheduled = false;
    const window = snap.changeWindowRemainingCycles ?? 0;
    this.changeWindowOpen = window > 0;
    if (this.changeWindowOpen) this.cpu.addClockEvent(this.closeChangeWindowEvent, window);
    else this.cpu.data[WDTCSR] = this.cpu.data[WDTCSR]! & ~(1 << WDCE);
    this.updateInterrupt();
    if (!this.enabled()) return;
    const remaining = Math.max(1, this.timeoutCycles() - (snap.accumulatedCycles | 0));
    this.cpu.addClockEvent(this.timeoutEvent, remaining);
    this.fireAtCycle = this.cpu.cycles + remaining;
    this.scheduled = true;
  }
}
