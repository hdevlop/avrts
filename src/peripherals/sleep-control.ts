import { AS2, ASSR } from "../cpu";
import type { CPU } from "../cpu";

interface SleepTimer {
  setSleepPaused(paused: boolean): void;
}

const MODE_IDLE = 0b000;
const MODE_ADC_NOISE_REDUCTION = 0b001;
const MODE_POWER_SAVE = 0b011;
const MODE_EXTENDED_STANDBY = 0b111;

/**
 * Sleep clock-domain gating. Synchronous I/O stops in non-idle sleep; ADC
 * remains active in noise-reduction mode and async Timer2 can run in that mode,
 * power-save, and extended standby. PRR is an independent gate on each target.
 */
export class SleepControl {
  constructor(
    private readonly cpu: CPU,
    private readonly syncTimers: readonly SleepTimer[],
    private readonly timer2: SleepTimer,
    private readonly adc?: SleepTimer,
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
    this.adc?.setSleepPaused(!idle && mode !== MODE_ADC_NOISE_REDUCTION);
  }

  private onWake(): void {
    for (const timer of this.syncTimers) timer.setSleepPaused(false);
    this.timer2.setSleepPaused(false);
    this.adc?.setSleepPaused(false);
  }

  private timer2RunsInMode(mode: number): boolean {
    if (mode === MODE_IDLE) return true;
    if (mode !== MODE_ADC_NOISE_REDUCTION && mode !== MODE_POWER_SAVE && mode !== MODE_EXTENDED_STANDBY) return false;
    return (this.cpu.data[ASSR]! & (1 << AS2)) !== 0;
  }
}
