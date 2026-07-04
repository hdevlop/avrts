import { OnWrite } from "../core";
import { GTCCR, PSRASY, PSRSYNC, TSM } from "../cpu";
import type { CPU } from "../cpu";

/** A timer that exposes its prescaler to GTCCR reset/hold control. */
export interface PrescalerTarget {
  resetPrescaler(): void;
  setPrescalerHeld(held: boolean): void;
}

/**
 * GTCCR: shared timer prescaler control. PSRSYNC resets the Timer0/Timer1
 * prescaler and PSRASY resets the Timer2 prescaler. With TSM set, the written
 * PSR bits stay set and hold their prescalers in reset (counters frozen) until
 * TSM is cleared — the datasheet's synchronized-start mode.
 */
export class TimerSync {
  constructor(
    private readonly cpu: CPU,
    private readonly syncTargets: readonly PrescalerTarget[],
    private readonly asyncTargets: readonly PrescalerTarget[],
  ) {}

  reset(): void {
    this.applyHolds(0);
  }

  @OnWrite(GTCCR)
  onWriteGtccr(_cpu: CPU, _addr: number, value: number): void {
    if ((value & (1 << TSM)) === 0) {
      // Without TSM the PSR strobes fire once and read back as zero.
      if ((value & (1 << PSRSYNC)) !== 0) {
        for (const target of this.syncTargets) target.resetPrescaler();
      }
      if ((value & (1 << PSRASY)) !== 0) {
        for (const target of this.asyncTargets) target.resetPrescaler();
      }
      this.cpu.data[GTCCR] = 0;
      this.applyHolds(0);
      return;
    }
    const held = value & ((1 << PSRSYNC) | (1 << PSRASY));
    this.cpu.data[GTCCR] = (1 << TSM) | held;
    this.applyHolds(held);
  }

  /** Re-apply holds from the restored GTCCR register byte. */
  restore(): void {
    const value = this.cpu.data[GTCCR]!;
    this.applyHolds((value & (1 << TSM)) !== 0 ? value : 0);
  }

  private applyHolds(heldBits: number): void {
    const syncHeld = (heldBits & (1 << PSRSYNC)) !== 0;
    const asyncHeld = (heldBits & (1 << PSRASY)) !== 0;
    for (const target of this.syncTargets) {
      target.setPrescalerHeld(syncHeld);
      if (syncHeld) target.resetPrescaler();
    }
    for (const target of this.asyncTargets) {
      target.setPrescalerHeld(asyncHeld);
      if (asyncHeld) target.resetPrescaler();
    }
  }
}
