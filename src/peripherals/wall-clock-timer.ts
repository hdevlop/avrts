import type { CPU } from "../cpu";

/** Internal RC-timed operation whose wall duration survives CPU clock changes. */
export class WallClockTimer {
  private clockHz = 16_000_000;
  private armed = false;
  private readonly complete = () => {
    this.armed = false;
    this.onComplete();
  };

  constructor(private readonly cpu: CPU, private readonly onComplete: () => void) {}

  // Round to the nearest CPU cycle so cycles -> ms -> cycles is lossless.
  start(milliseconds: number): void { this.startCycles(Math.round(milliseconds * this.clockHz / 1000)); }

  startCycles(cycles: number): void {
    this.armed = true;
    this.cpu.addClockEvent(this.complete, Math.max(1, cycles));
  }

  remainingCycles(): number {
    return this.armed ? this.cpu.clockEventRemainingCycles(this.complete) : 0;
  }

  stop(): void {
    this.armed = false;
    this.cpu.clearClockEvent(this.complete);
  }

  remainingMs(): number {
    return this.armed ? this.cpu.clockEventRemainingCycles(this.complete) * 1000 / this.clockHz : 0;
  }

  setClock(hz: number): void {
    const remaining = this.remainingMs();
    this.clockHz = hz;
    if (this.armed) this.start(remaining);
  }
}
