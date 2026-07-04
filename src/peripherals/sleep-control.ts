import { AS2, ASSR } from "../cpu";
import type { CPU } from "../cpu";

interface SleepTimer {
  setSleepPaused(paused: boolean): void;
}

const MODE_IDLE = 0b000;
const MODE_POWER_SAVE = 0b011;
const MODE_EXTENDED_STANDBY = 0b111;

/**
 * Sleep clock-domain gating for timers. The CPU owns sleep entry and interrupt
 * wake-up; this controller applies the ATmega328P timer clock table: sync
 * timers stop in every non-idle sleep mode, while Timer2 can keep running from
 * the asynchronous TOSC source in power-save and extended standby.
 */
export class SleepControl {
  constructor(
    private readonly cpu: CPU,
    private readonly syncTimers: readonly SleepTimer[],
    private readonly timer2: SleepTimer,
  ) {
    this.cpu.onSleep((mode) => this.onSleep(mode));
    this.cpu.onWake(() => this.onWake());
  }

  reset(): void {
    this.onWake();
  }

  restore(): void {
    if (this.cpu.isSleeping) {
      this.onSleep(this.cpu.sleepMode);
    } else {
      this.onWake();
    }
  }

  private onSleep(mode: number): void {
    const idle = mode === MODE_IDLE;
    for (const timer of this.syncTimers) timer.setSleepPaused(!idle);
    this.timer2.setSleepPaused(!this.timer2RunsInMode(mode));
  }

  private onWake(): void {
    for (const timer of this.syncTimers) timer.setSleepPaused(false);
    this.timer2.setSleepPaused(false);
  }

  private timer2RunsInMode(mode: number): boolean {
    if (mode === MODE_IDLE) return true;
    if (mode !== MODE_POWER_SAVE && mode !== MODE_EXTENDED_STANDBY) return false;
    return (this.cpu.data[ASSR]! & (1 << AS2)) !== 0;
  }
}
