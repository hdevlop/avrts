import type { CPU } from "../cpu";

/** Timer0/1's free-running ten-bit divider; CS and PRR gate counters, not taps. */
export class TimerPrescaler {
  private phaseAtCycle = 0;
  private cycle: number;
  private held = false;
  private sleepPaused = false;

  constructor(private readonly cpu: CPU) {
    this.cycle = cpu.cycles;
  }

  phase(): number {
    if (this.held) return 0;
    return (this.phaseAtCycle + (this.sleepPaused ? 0 : this.cpu.cycles - this.cycle)) & 1023;
  }

  reset(): void {
    this.phaseAtCycle = 0;
    this.cycle = this.cpu.cycles;
  }

  /** Compatibility for explicit tick() calls without advancing CPU.cycles. */
  advance(cycles: number): void {
    const phase = this.phase();
    this.phaseAtCycle = (phase + (this.held || this.sleepPaused ? 0 : cycles)) & 1023;
    this.cycle = this.cpu.cycles;
  }

  setHeld(held: boolean): void {
    if (this.held === held) return;
    this.reset();
    this.held = held;
  }

  setSleepPaused(paused: boolean): void {
    if (this.sleepPaused === paused) return;
    this.phaseAtCycle = this.phase();
    this.cycle = this.cpu.cycles;
    this.sleepPaused = paused;
  }

  restore(phase: number): void {
    this.phaseAtCycle = phase & 1023;
    this.cycle = this.cpu.cycles;
    this.held = false;
    this.sleepPaused = false;
  }
}
