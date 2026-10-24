import type { CPU } from "../cpu";
import type { TimerExternalClockSnapshot } from "../snapshot";

/** Integer-phase T0/T1 sampler: next I/O clock sample plus two pipeline clocks. */
export class TimerExternalClock {
  private enabled = false;
  private rising = true;
  private sampledHigh: boolean;
  private readonly pending = new Set<() => void>();
  private readonly sample = () => {
    if (!this.enabled) return;
    const high = this.read();
    if (high === this.sampledHigh) return;
    this.sampledHigh = high;
    if (high !== this.rising) return;
    this.queuePulse(2);
  };

  constructor(private readonly cpu: CPU, private readonly read: () => boolean,
    private readonly pulse: () => void) {
    this.sampledHigh = read();
  }

  configure(enabled: boolean, rising: boolean): void {
    if (enabled === this.enabled && rising === this.rising) return;
    this.cancel();
    this.enabled = enabled;
    this.rising = rising;
    this.sampledHigh = this.read();
  }

  changed(): void {
    if (this.enabled) this.cpu.addClockEvent(this.sample, 1);
  }

  reset(): void {
    this.cancel();
    this.enabled = false;
    this.sampledHigh = this.read();
  }

  snapshot(): TimerExternalClockSnapshot {
    return { sampledHigh: this.sampledHigh,
      sampleRemainingCycles: this.cpu.clockEventRemainingCycles(this.sample),
      pulses: [...this.pending].map((event) => this.cpu.clockEventRemainingCycles(event)) };
  }

  restore(snapshot: TimerExternalClockSnapshot | undefined): void {
    this.cancel();
    this.sampledHigh = snapshot?.sampledHigh ?? this.read();
    if (!this.enabled) return;
    if (snapshot?.sampleRemainingCycles) this.cpu.addClockEvent(this.sample, snapshot.sampleRemainingCycles);
    for (const cycles of snapshot?.pulses ?? []) this.queuePulse(cycles);
  }

  private queuePulse(cycles: number): void {
    const event = () => {
      this.pending.delete(event);
      if (this.enabled) this.pulse();
    };
    this.pending.add(event);
    this.cpu.addClockEvent(event, Math.max(1, cycles));
  }

  private cancel(): void {
    this.cpu.clearClockEvent(this.sample);
    for (const event of this.pending) this.cpu.clearClockEvent(event);
    this.pending.clear();
  }
}
