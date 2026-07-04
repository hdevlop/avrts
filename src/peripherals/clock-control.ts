import { OnWrite } from "../core";
import { CLKPCE, CLKPR } from "../cpu";
import type { CPU } from "../cpu";
import type { ClockControlSnapshot } from "../snapshot";

const CLKPS_MASK = 0x0f;
const VALID_MAX_CLKPS = 8;

export class ClockControl {
  private unlocked = false;
  private readonly lockEvent = (): void => {
    this.unlocked = false;
    this.cpu.data[CLKPR] = this.cpu.data[CLKPR]! & ~(1 << CLKPCE);
  };

  constructor(
    private readonly cpu: CPU,
    private readonly onDividerChange: (divider: number) => void,
  ) {}

  reset(): void {
    this.unlocked = false;
    this.cpu.clearClockEvent(this.lockEvent);
    this.cpu.data[CLKPR] = 0;
    this.onDividerChange(1);
  }

  @OnWrite(CLKPR)
  onWriteClkpr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    if ((value & (1 << CLKPCE)) !== 0 && (value & CLKPS_MASK) === 0) {
      this.unlocked = true;
      this.cpu.data[CLKPR] = (oldValue & CLKPS_MASK) | (1 << CLKPCE);
      this.cpu.addClockEvent(this.lockEvent, 4);
      return;
    }

    if (this.unlocked) {
      const clkps = value & CLKPS_MASK;
      if (clkps <= VALID_MAX_CLKPS) {
        this.cpu.data[CLKPR] = clkps;
        this.onDividerChange(1 << clkps);
      } else {
        this.cpu.data[CLKPR] = oldValue & CLKPS_MASK;
      }
      this.unlocked = false;
      this.cpu.clearClockEvent(this.lockEvent);
      return;
    }

    this.cpu.data[CLKPR] = oldValue & CLKPS_MASK;
  }

  snapshot(): ClockControlSnapshot {
    return {
      unlocked: this.unlocked,
      remainingCycles: this.cpu.clockEventRemainingCycles(this.lockEvent),
    };
  }

  restore(snap: ClockControlSnapshot | undefined): void {
    this.cpu.clearClockEvent(this.lockEvent);
    this.unlocked = snap?.unlocked ?? false;
    if (this.unlocked) {
      this.cpu.addClockEvent(this.lockEvent, snap?.remainingCycles ?? 1);
    }
    this.onDividerChange(1 << (this.cpu.data[CLKPR]! & CLKPS_MASK));
  }
}
