import { OnWrite } from "../core";
import { PRADC, PRR, PRSPI, PRTIM0, PRTIM1, PRTIM2, PRTWI, PRUSART0 } from "../cpu";
import type { CPU } from "../cpu";

export interface PowerReductionTarget {
  setPowerReduced(reduced: boolean): void;
}

const PRR_MODELED_MASK =
  (1 << PRADC) |
  (1 << PRUSART0) |
  (1 << PRSPI) |
  (1 << PRTIM1) |
  (1 << PRTIM0) |
  (1 << PRTIM2) |
  (1 << PRTWI);

export class PowerReduction {
  constructor(
    private readonly cpu: CPU,
    private readonly targets: ReadonlyArray<{ bit: number; target: PowerReductionTarget }>,
  ) {}

  reset(): void {
    this.cpu.data[PRR] = 0;
    for (const { target } of this.targets) target.setPowerReduced(false);
  }

  @OnWrite(PRR)
  onWritePrr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    const next = value & PRR_MODELED_MASK;
    this.cpu.data[PRR] = next;
    this.applyChanged(oldValue & PRR_MODELED_MASK, next);
  }

  restore(): void {
    this.applyChanged(~this.cpu.data[PRR]! & PRR_MODELED_MASK, this.cpu.data[PRR]! & PRR_MODELED_MASK);
  }

  private applyChanged(previous: number, next: number): void {
    const changed = previous ^ next;
    if (changed === 0) return;
    for (const { bit, target } of this.targets) {
      if ((changed & (1 << bit)) !== 0) target.setPowerReduced((next & (1 << bit)) !== 0);
    }
  }
}
