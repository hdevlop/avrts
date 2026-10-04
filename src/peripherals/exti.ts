import { OnWrite } from "../core";
import {
  EICRA,
  EIFR,
  EIMSK,
  INT0,
  INT0_VECTOR,
  INT1,
  INT1_VECTOR,
  INTF0,
  INTF1,
  ISC00,
  ISC10,
} from "../cpu";
import type { CPU } from "../cpu";
import type { ExternalInterruptsSnapshot } from "../snapshot";
import type { Gpio } from "./gpio";

interface ExtIntConfig {
  /** Bit index in PIND for this external interrupt's pin. */
  pinBit: number;
  /** Bit index in EIMSK (the enable register). */
  enableBit: number;
  /** Bit index in EIFR (the flag register). */
  flagBit: number;
  /** Interrupt vector word address. */
  vector: number;
  /** Bit position in EICRA of ISCn0 (low sense bit). */
  iscLow: number;
}

const INT0_CONFIG: ExtIntConfig = {
  pinBit: 2, // PD2 = Arduino D2
  enableBit: INT0,
  flagBit: INTF0,
  vector: INT0_VECTOR,
  iscLow: ISC00,
};

const INT1_CONFIG: ExtIntConfig = {
  pinBit: 3, // PD3 = Arduino D3
  enableBit: INT1,
  flagBit: INTF1,
  vector: INT1_VECTOR,
  iscLow: ISC10,
};

const CONFIGS: readonly ExtIntConfig[] = [INT0_CONFIG, INT1_CONFIG];

/**
 * External interrupts on INT0 (PD2 / D2) and INT1 (PD3 / D3). Trigger mode is
 * selected via EICRA's ISCn bits:
 *   00 = low level (interrupt requested every cycle while the pin is LOW)
 *   01 = any change (rising or falling edge)
 *   10 = falling edge
 *   11 = rising edge
 *
 * For level mode, INTFn is never set in EIFR — the request is re-issued on
 * every cycle so long as the pin is LOW. For edge modes, INTFn is set on the
 * matching edge and the ISR clears it on entry.
 */
export class ExternalInterrupts {
  private prevPinLevels = { int0: false, int1: false };
  private levelModeActive = false;
  private readonly onLevelEvent = (): void => {
    this.evaluateLevelMode();
    this.scheduleLevelEvent();
  };

  constructor(
    private readonly cpu: CPU,
    private readonly gpio: Gpio,
  ) {}

  /** Subscribe to GPIO port D changes; standalone use also wires level-mode ticking. */
  attach(options: { cycleListener?: boolean } = {}): void {
    this.prevPinLevels.int0 = this.gpio.readPin("D", INT0_CONFIG.pinBit);
    this.prevPinLevels.int1 = this.gpio.readPin("D", INT1_CONFIG.pinBit);
    this.refreshLevelModeActive();
    this.gpio.onPortTouched("D", () => {
      this.evaluateEdges();
      this.evaluateLevelMode();
      this.scheduleLevelEvent();
    });
    if (options.cycleListener !== false) this.cpu.onCycles(() => this.tick());
  }

  reset(): void {
    this.prevPinLevels.int0 = this.gpio.readPin("D", INT0_CONFIG.pinBit);
    this.prevPinLevels.int1 = this.gpio.readPin("D", INT1_CONFIG.pinBit);
    this.refreshLevelModeActive();
    this.scheduleLevelEvent();
  }

  tick(): void {
    if (!this.levelModeActive) return;
    this.evaluateLevelMode();
    this.scheduleLevelEvent();
  }

  @OnWrite(EIFR)
  onWriteEifr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    // Flags are write-1-to-clear.
    this.cpu.data[EIFR] = oldValue & ~value;
  }

  @OnWrite(EICRA)
  onWriteEicra(): void {
    this.refreshLevelModeActive();
    this.scheduleLevelEvent();
  }

  @OnWrite(EIMSK)
  onWriteEimsk(): void {
    this.refreshLevelModeActive();
    this.scheduleLevelEvent();
  }

  /** Edge detection runs on every GPIO port-D touch. */
  private evaluateEdges(): void {
    for (const cfg of CONFIGS) {
      const now = this.gpio.readPin("D", cfg.pinBit);
      const prev = cfg === INT0_CONFIG ? this.prevPinLevels.int0 : this.prevPinLevels.int1;
      if (cfg === INT0_CONFIG) this.prevPinLevels.int0 = now;
      else this.prevPinLevels.int1 = now;
      if (now === prev) continue;

      const rising = now && !prev;
      const falling = !now && prev;
      const mode = this.triggerMode(cfg);
      const matches =
        mode === 1 || (mode === 2 && falling) || (mode === 3 && rising);
      if (!matches) continue;
      if ((this.cpu.data[EIMSK]! & (1 << cfg.enableBit)) === 0) continue;

      this.cpu.data[EIFR] = this.cpu.data[EIFR]! | (1 << cfg.flagBit);
      this.cpu.requestInterrupt(cfg.vector, () => {
        this.cpu.data[EIFR] = this.cpu.readData(EIFR) & ~(1 << cfg.flagBit);
      });
    }
  }

  /**
   * Level-mode re-evaluation. Fires after every instruction so the interrupt is
   * continuously requested while the pin is LOW (matching real AVR behavior —
   * the ISR is taken again after RETI and one main-program instruction).
   */
  private evaluateLevelMode(): void {
    for (const cfg of CONFIGS) {
      const mode = this.triggerMode(cfg);
      if (mode !== 0) continue;
      if ((this.cpu.data[EIMSK]! & (1 << cfg.enableBit)) === 0) continue;
      const high = this.gpio.readPin("D", cfg.pinBit);
      if (high) continue;
      this.cpu.requestInterrupt(cfg.vector);
    }
  }

  /** Read the ISCn1:ISCn0 two-bit mode value from EICRA. */
  private triggerMode(cfg: ExtIntConfig): number {
    return (this.cpu.data[EICRA]! >> cfg.iscLow) & 0x03;
  }

  private refreshLevelModeActive(): void {
    const eicra = this.cpu.data[EICRA]!;
    const eimsk = this.cpu.data[EIMSK]!;
    this.levelModeActive =
      ((eimsk & (1 << INT0_CONFIG.enableBit)) !== 0 &&
        (((eicra >> INT0_CONFIG.iscLow) & 0x03) === 0)) ||
      ((eimsk & (1 << INT1_CONFIG.enableBit)) !== 0 &&
        (((eicra >> INT1_CONFIG.iscLow) & 0x03) === 0));
  }

  private hasAssertedLevelSource(): boolean {
    if (!this.levelModeActive) return false;
    for (const cfg of CONFIGS) {
      if (this.triggerMode(cfg) !== 0) continue;
      if ((this.cpu.data[EIMSK]! & (1 << cfg.enableBit)) === 0) continue;
      if (!this.gpio.readPin("D", cfg.pinBit)) return true;
    }
    return false;
  }

  private scheduleLevelEvent(): void {
    if (this.hasAssertedLevelSource()) {
      this.cpu.addClockEvent(this.onLevelEvent, 1);
    } else {
      this.cpu.clearClockEvent(this.onLevelEvent);
    }
  }

  // --- Snapshot / restore (Phase 10) ---

  snapshot(): ExternalInterruptsSnapshot {
    return {
      prevPinLevels: {
        int0: this.prevPinLevels.int0,
        int1: this.prevPinLevels.int1,
      },
    };
  }

  restore(snap: ExternalInterruptsSnapshot): void {
    this.prevPinLevels.int0 = !!snap.prevPinLevels.int0;
    this.prevPinLevels.int1 = !!snap.prevPinLevels.int1;
    this.refreshLevelModeActive();
    this.scheduleLevelEvent();
  }
}
