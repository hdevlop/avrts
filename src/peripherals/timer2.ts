import { OnRead, OnWrite } from "../core";
import {
  AS2,
  ASSR,
  COM2A0,
  COM2A1,
  COM2B0,
  COM2B1,
  CS20,
  CS21,
  CS22,
  OCF2A,
  OCF2B,
  OCIE2A,
  OCIE2B,
  OCR2A,
  OCR2AUB,
  OCR2B,
  OCR2BUB,
  TCCR2A,
  TCCR2B,
  TCN2UB,
  TCNT2,
  TCR2AUB,
  TCR2BUB,
  TIFR2,
  TIMER2_COMPA_VECTOR,
  TIMER2_COMPB_VECTOR,
  TIMER2_OVF_VECTOR,
  TIMSK2,
  TOIE2,
  TOV2,
  WGM20,
  WGM21,
  WGM22,
} from "../cpu";
import type { CPU } from "../cpu";
import type { Gpio } from "./gpio";
import { PwmBroadcaster, pwmSignal } from "./pwm";
import type { PwmConfig } from "./pwm";
import type { Timer2Snapshot } from "../snapshot";
import type { PortName, PwmChannel, PwmSignal, PwmSource } from "./types";

// Timer2's prescaler set is richer than Timer0/Timer1 (it adds /32 and /128).
const TIMER2_PRESCALER: Readonly<Record<number, number | undefined>> = {
  0b000: undefined,
  0b001: 1,
  0b010: 8,
  0b011: 32,
  0b100: 64,
  0b101: 128,
  0b110: 256,
  0b111: 1024,
};

const TIMER2_FLAG_MASK = (1 << TOV2) | (1 << OCF2A) | (1 << OCF2B);

// Timer2 asynchronous mode clocks from a 32.768 kHz watch crystal on TOSC.
const TOSC_HZ = 32768;
const ASSR_BUSY_MASK =
  (1 << TCN2UB) | (1 << OCR2AUB) | (1 << OCR2BUB) | (1 << TCR2AUB) | (1 << TCR2BUB);
const DEFAULT_CLOCK_HZ = 16_000_000;
const ASYNC_REGISTERS = [TCNT2, OCR2A, OCR2B, TCCR2A, TCCR2B] as const;
const ASYNC_BUSY_BITS: Readonly<Record<number, number>> = {
  [TCNT2]: TCN2UB, [OCR2A]: OCR2AUB, [OCR2B]: OCR2BUB,
  [TCCR2A]: TCR2AUB, [TCCR2B]: TCR2BUB,
};

/**
 * Timer2 (8-bit): Timer0's counting/PWM/compare behavior with its own prescaler,
 * asynchronous TOSC clock, ASSR busy windows, OC2A (pin 11) and OC2B (pin 3).
 */
export class Timer2 implements PwmSource {
  private countingDown = false;
  private activeOcrA = 0;
  private activeOcrB = 0;
  private compareBlocked = false;
  private prescalerRemainder = 0;
  private lastCycle = 0;
  private powerReduced = false;
  // GTCCR TSM+PSRASY holds the timer2 prescaler in reset (counter frozen).
  private prescalerHeld = false;
  private sleepPaused = false;
  private clockHz = DEFAULT_CLOCK_HZ;
  private toscCycleBase = 0;
  private toscPausedAt: number | undefined;
  // CPU-domain counter read latch: stale until the first TOSC edge after wake.
  private asyncSleepCounter: number | undefined;
  private asyncWakeReadUntil: number | undefined;
  private asyncOverflowPending = false;
  private asyncIoPaused = false;
  private counterEventCycle = 0;
  private readonly asyncFlags = new Map<number, { remainingCycles: number; dueCycle?: number }>();
  // Independent ten-bit divider phase, separate from the oscillator's phase.
  private dividerCycleBase = 0;
  private dividerPausedAt: number | undefined;
  private readonly asyncWrites = new Map<number, { value?: number; dueCycle: number }>();
  // Cached prescaler divisor, recomputed only when the CS bits (TCCR2B) change.
  // In async mode (ASSR.AS2) it is scaled by the CPU-cycles-per-TOSC-tick ratio.
  // tick() runs every instruction, so it must not re-read/re-map the register.
  private cachedPrescaler: number | undefined = undefined;
  private readonly pwm = new PwmBroadcaster();
  private readonly onClockEvent = (): void => {
    this.syncToCpuCycle();
    this.scheduleClockEvent();
    this.transferAsyncFlags();
  };
  private readonly onAsyncUpdateEvent = (): void => this.applyAsyncWrites();
  private readonly onAsyncFlagEvent = (): void => this.transferAsyncFlags();

  constructor(
    private readonly cpu: CPU,
    private readonly gpio?: Gpio,
  ) {
    this.cpu.onSleep((mode) => {
      // Capture the visible value, including a previous wake window if firmware
      // re-enters power-save before its read synchronizer has caught up.
      this.asyncSleepCounter = mode === 0b011 && this.asyncMode() ? this.readTcnt2() : undefined;
      this.asyncWakeReadUntil = undefined;
      this.asyncIoPaused = mode !== 0;
      if (this.asyncIoPaused) {
        for (const pending of this.asyncFlags.values()) {
          if (pending.dueCycle === undefined) continue;
          pending.remainingCycles = Math.max(0, pending.dueCycle - this.cpu.cycles);
          pending.dueCycle = undefined;
        }
      } else {
        for (const pending of this.asyncFlags.values()) {
          pending.dueCycle ??= this.cpu.cycles + pending.remainingCycles;
        }
      }
      this.scheduleAsyncFlags();
    });
    this.cpu.onWakeStart(() => {
      this.asyncIoPaused = false;
      for (const pending of this.asyncFlags.values()) {
        pending.dueCycle ??= this.cpu.cycles + pending.remainingCycles;
      }
      this.scheduleAsyncFlags();
    });
    this.cpu.onWake((wakeCycle) => {
      if (this.asyncSleepCounter === undefined) return;
      const period = this.clockHz / TOSC_HZ;
      const edge = Math.floor((wakeCycle - this.toscCycleBase) / period) + 1;
      this.asyncWakeReadUntil = this.toscCycleBase + edge * period;
    });
  }

  private get pwmConfig(): PwmConfig {
    return {
      tccrA: TCCR2A,
      tccrB: TCCR2B,
      wgm2Bit: WGM22,
      max: 255,
      topValue: () => this.modeTop(),
      mode: () => this.pwmMode(),
      compareMode: (channel) => this.compareMode(channel),
      ocrValue: (channel) => this.ocrValue(channel),
    };
  }

  reset(): void {
    this.countingDown = false;
    this.activeOcrA = 0;
    this.activeOcrB = 0;
    this.compareBlocked = false;
    this.powerReduced = false;
    this.prescalerHeld = false;
    this.sleepPaused = false;
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.toscCycleBase = this.cpu.cycles;
    this.toscPausedAt = undefined;
    this.asyncSleepCounter = undefined;
    this.asyncWakeReadUntil = undefined;
    this.asyncOverflowPending = false;
    this.asyncIoPaused = false;
    this.asyncFlags.clear();
    this.cpu.clearClockEvent(this.onAsyncFlagEvent);
    this.dividerCycleBase = this.cpu.cycles;
    this.dividerPausedAt = undefined;
    this.asyncWrites.clear();
    this.cpu.clearClockEvent(this.onAsyncUpdateEvent);
    this.refreshPrescaler();
    this.scheduleClockEvent();
    this.driveOutput("A", undefined);
    this.driveOutput("B", undefined);
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  /** The async TOSC ratio depends on the system clock; wired from useClock(). */
  setClock(clockHz: number): void {
    if (clockHz === this.clockHz) return;
    const scale = clockHz / this.clockHz;
    this.syncToCpuCycle();
    if (this.asyncMode()) {
      const now = this.toscNow();
      const dividerNow = this.dividerPausedAt ?? this.cpu.cycles;
      this.dividerCycleBase = dividerNow - (dividerNow - this.dividerCycleBase) * scale;
      this.toscCycleBase = now - (now - this.toscCycleBase) * scale;
      for (const pending of this.asyncWrites.values()) {
        pending.dueCycle = now + (pending.dueCycle - now) * scale;
      }
      if (this.asyncWakeReadUntil !== undefined) {
        this.asyncWakeReadUntil = now + (this.asyncWakeReadUntil - now) * scale;
      }
    }
    this.clockHz = clockHz;
    this.scheduleAsyncUpdate();
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }

  tick(cycles: number): void {
    if (this.cpu.cycles === this.lastCycle && !this.dividerPaused()) this.dividerCycleBase -= cycles;
    if (this.frozen()) {
      this.lastCycle = this.cpu.cycles;
      return;
    }
    const prescaler = this.cachedPrescaler;
    if (prescaler === undefined) {
      this.lastCycle = this.cpu.cycles;
      return;
    }

    if (cycles > 1 && prescaler === 1) {
      const total = this.prescalerRemainder + cycles;
      this.prescalerRemainder = 0;
      this.advanceCounter(total);
      this.lastCycle = this.cpu.cycles;
      this.scheduleClockEvent();
      return;
    }

    this.prescalerRemainder += cycles;
    while (this.prescalerRemainder >= prescaler) {
      this.prescalerRemainder -= prescaler;
      this.counterEventCycle = this.cpu.cycles;
      this.incrementCounter();
    }
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  @OnWrite(TIFR2)
  onWriteTifr2(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    this.cpu.data[TIFR2] = oldValue & TIMER2_FLAG_MASK & ~value;
    this.onWriteTimsk2();
  }

  @OnWrite(TCNT2)
  onWriteTcnt2(_cpu: CPU, addr: number, value: number, oldValue: number): void {
    if (this.deferAsyncWrite(addr, value, oldValue)) return;
    this.syncWithOldRegister(addr, oldValue);
    this.compareBlocked = true;
    this.lastCycle = this.cpu.cycles;
    this.scheduleClockEvent();
  }

  @OnWrite(ASSR)
  onWriteAssr(_cpu: CPU, _addr: number, value: number, oldValue: number): void {
    // AS2/EXCLK are writable; the update-busy flags are hardware-owned.
    const next = (value & 0x60) | (oldValue & ASSR_BUSY_MASK);
    this.cpu.data[ASSR] = next;
    if (((next ^ oldValue) & (1 << AS2)) === 0) return;
    // Clock-domain switch: settle elapsed time at the old cached rate first.
    this.cpu.data[ASSR] = oldValue;
    this.syncToCpuCycle();
    // Hardware declares these contents undefined on a clock-domain switch.
    // Keep destinations deterministic and discard unfinished transfers.
    this.cpu.data[ASSR] = next & ~ASSR_BUSY_MASK;
    this.asyncWrites.clear();
    this.cpu.clearClockEvent(this.onAsyncUpdateEvent);
    this.asyncSleepCounter = undefined;
    this.asyncWakeReadUntil = undefined;
    this.asyncOverflowPending = false;
    this.asyncFlags.clear();
    this.cpu.clearClockEvent(this.onAsyncFlagEvent);
    this.toscCycleBase = this.cpu.cycles;
    this.toscPausedAt = this.sleepPaused ? this.cpu.cycles : undefined;
    this.dividerCycleBase = this.cpu.cycles;
    this.dividerPausedAt = this.dividerPaused() ? this.cpu.cycles : undefined;
    this.prescalerRemainder = 0;
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }

  @OnWrite(TCCR2B)
  onWriteTccr2b(_cpu: CPU, addr: number, value: number, oldValue: number): void {
    if (this.deferAsyncWrite(addr, value, oldValue)) return;
    const oldMode = this.syncWithOldRegister(addr, oldValue);
    // FOC strobes read as zero and never set flags or clear CTC.
    const strobes = this.cpu.data[TCCR2B]! & 0xc0;
    this.cpu.data[TCCR2B] = this.cpu.data[TCCR2B]! & 0x0f;
    this.updateWaveformMode(oldMode);
    if (!this.isPwmMode()) {
      if ((strobes & 0x80) !== 0) this.handleCompareOutput("A");
      if ((strobes & 0x40) !== 0) this.handleCompareOutput("B");
    }
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(TIMSK2)
  onWriteTimsk2(): void {
    this.cpu.data[TIMSK2] = this.cpu.data[TIMSK2]! & TIMER2_FLAG_MASK;
    this.requestCompareIfEnabled("A");
    this.requestCompareIfEnabled("B");
    this.requestOverflowIfEnabled();
    this.scheduleAsyncFlags();
  }

  @OnWrite(TCCR2A)
  onWriteTccr2a(_cpu: CPU, addr: number, value: number, oldValue: number): void {
    if (this.deferAsyncWrite(addr, value, oldValue)) return;
    const oldMode = this.syncWithOldRegister(addr, oldValue);
    this.cpu.data[addr] = this.cpu.data[addr]! & 0xf3;
    this.updateWaveformMode(oldMode);
    this.scheduleClockEvent();
    this.notifyPwm("A");
    this.notifyPwm("B");
  }

  @OnWrite(OCR2A)
  @OnWrite(OCR2B)
  onWriteOcr2(_cpu: CPU, addr: number, value: number, oldValue: number): void {
    if (this.deferAsyncWrite(addr, value, oldValue)) return;
    this.syncWithOldRegister(addr, oldValue);
    if (!this.isPwmMode()) {
      this.updateCompareBuffers();
      this.scheduleClockEvent();
    }
  }

  @OnRead(TCNT2)
  readTcnt2(): number {
    this.syncToCpuCycle();
    if (this.asyncWakeReadUntil !== undefined) {
      if (this.cpu.cycles < this.asyncWakeReadUntil) return this.asyncSleepCounter!;
      this.asyncSleepCounter = undefined;
      this.asyncWakeReadUntil = undefined;
    }
    return this.cpu.data[TCNT2]!;
  }

  @OnRead(OCR2A)
  @OnRead(OCR2B)
  @OnRead(TCCR2A)
  @OnRead(TCCR2B)
  readAsyncTemporary(_cpu: CPU, addr: number): number {
    const value = this.asyncWrites.get(addr)?.value ?? this.cpu.data[addr]!;
    return addr === TCCR2B ? value & 0x0f : addr === TCCR2A ? value & 0xf3 : value;
  }

  readPwm(channel: PwmChannel): PwmSignal {
    this.syncToCpuCycle();
    return pwmSignal(this.cpu, this.pwmConfig, channel);
  }

  onPwmChange(channel: PwmChannel, listener: (signal: PwmSignal) => void): () => void {
    return this.pwm.on(channel, listener);
  }

  setPowerReduced(reduced: boolean): void {
    if (this.powerReduced === reduced) return;
    this.syncToCpuCycle();
    this.powerReduced = reduced;
    this.updateDividerPause();
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }

  /** GTCCR TSM+PSRASY: hold the timer2 prescaler in reset (counter frozen). */
  setPrescalerHeld(held: boolean): void {
    if (this.prescalerHeld === held) return;
    if (held) {
      this.syncToCpuCycle();
      this.prescalerHeld = true;
      this.dividerCycleBase = this.cpu.cycles;
      this.dividerPausedAt = this.cpu.cycles;
      this.cpu.clearClockEvent(this.onClockEvent);
      return;
    }
    this.prescalerHeld = false;
    // Release on the existing source grid; holding the divider does not stop TOSC.
    this.dividerCycleBase = this.cpu.cycles - (this.asyncMode() ? this.toscPhase() : 0);
    this.dividerPausedAt = this.dividerPaused() ? this.cpu.cycles : undefined;
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }

  /** GTCCR PSRASY: reset the timer2 prescaler (counter value untouched). */
  resetPrescaler(): void {
    this.syncToCpuCycle();
    this.dividerCycleBase = (this.dividerPausedAt ?? this.cpu.cycles)
      - (this.asyncMode() ? this.toscPhase() : 0);
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }

  setSleepPaused(paused: boolean): void {
    if (this.sleepPaused === paused) return;
    if (paused) {
      this.syncToCpuCycle();
      this.sleepPaused = true;
      if (this.asyncMode()) {
        this.toscPausedAt = this.cpu.cycles;
        this.cpu.clearClockEvent(this.onAsyncUpdateEvent);
      }
      this.updateDividerPause();
      this.cpu.clearClockEvent(this.onClockEvent);
      return;
    }
    this.sleepPaused = false;
    if (this.toscPausedAt !== undefined) {
      const elapsed = this.cpu.cycles - this.toscPausedAt;
      this.toscCycleBase += elapsed;
      for (const pending of this.asyncWrites.values()) pending.dueCycle += elapsed;
      this.toscPausedAt = undefined;
      this.scheduleAsyncUpdate();
    }
    this.updateDividerPause();
    this.lastCycle = this.cpu.cycles;
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }

  private frozen(): boolean {
    return this.dividerPaused();
  }

  private dividerPaused(): boolean {
    return (this.powerReduced && !this.asyncMode()) || this.prescalerHeld || this.sleepPaused;
  }

  private updateDividerPause(): void {
    if (this.dividerPaused()) {
      this.dividerPausedAt ??= this.cpu.cycles;
    } else if (this.dividerPausedAt !== undefined) {
      this.dividerCycleBase += this.cpu.cycles - this.dividerPausedAt;
      this.dividerPausedAt = undefined;
    }
  }

  /** CPU-cycle phase of all 1024 source clocks, including a partial TOSC period. */
  private dividerPhase(): number {
    if (this.prescalerHeld) return 0;
    return ((this.dividerPausedAt ?? this.cpu.cycles) - this.dividerCycleBase)
      % (1024 * this.asyncScale());
  }

  private asyncMode(): boolean {
    return (this.cpu.data[ASSR]! & (1 << AS2)) !== 0;
  }

  /**
   * CPU cycles per timer2 clock-source tick: 1 in sync mode, or the exact
   * `clockHz / 32768` ratio in async mode. The ratio is deliberately fractional
   * (488.28125 at 16 MHz) so the counter tracks the 32.768 kHz TOSC crystal
   * without accumulating rounding drift over a long run — the prescaler
   * remainder carries the fraction, matching native simavr's virtual TOSC.
   */
  private asyncScale(): number {
    return this.asyncMode() ? this.clockHz / TOSC_HZ : 1;
  }

  private toscNow(): number {
    return this.toscPausedAt ?? this.cpu.cycles;
  }

  private toscPhase(): number {
    return (this.toscNow() - this.toscCycleBase) % (this.clockHz / TOSC_HZ);
  }

  /** Each register has its own temporary value and two-rising-edge transfer. */
  private deferAsyncWrite(addr: number, value: number, oldValue: number): boolean {
    if (!this.asyncMode()) return false;
    this.cpu.data[addr] = oldValue;
    this.syncToCpuCycle();
    const mask = 1 << ASYNC_BUSY_BITS[addr]!;
    // Silicon leaves busy-write corruption undefined. Preserve the first write
    // rather than inventing a replacement value or extending another deadline.
    if ((this.cpu.data[ASSR]! & mask) !== 0) return true;
    const period = this.clockHz / TOSC_HZ;
    const edge = Math.floor((this.toscNow() - this.toscCycleBase) / period) + 2;
    this.asyncWrites.set(addr, { value, dueCycle: this.toscCycleBase + edge * period });
    this.cpu.data[ASSR] = this.cpu.data[ASSR]! | mask;
    this.scheduleAsyncUpdate();
    return true;
  }

  private scheduleAsyncUpdate(): void {
    this.cpu.clearClockEvent(this.onAsyncUpdateEvent);
    if (this.toscPausedAt !== undefined || this.asyncWrites.size === 0) return;
    let due = Infinity;
    for (const pending of this.asyncWrites.values()) due = Math.min(due, pending.dueCycle);
    this.cpu.addClockEvent(this.onAsyncUpdateEvent, Math.max(1, Math.ceil(due - this.cpu.cycles)));
  }

  private applyAsyncWrites(): void {
    this.syncToCpuCycle();
    const oldMode = this.waveformMode();
    let controls = false;
    let counter = false;
    let compare = false;
    let strobes = 0;
    for (const [addr, pending] of this.asyncWrites) {
      if (pending.dueCycle > this.cpu.cycles) continue;
      this.asyncWrites.delete(addr);
      this.cpu.data[ASSR] = this.cpu.data[ASSR]! & ~(1 << ASYNC_BUSY_BITS[addr]!);
      if (pending.value === undefined) continue; // Legacy: destination already updated.
      this.cpu.data[addr] = addr === TCCR2B ? pending.value & 0x0f
        : addr === TCCR2A ? pending.value & 0xf3 : pending.value;
      if (addr === TCNT2) counter = true;
      else if (addr === TCCR2A || addr === TCCR2B) controls = true;
      else compare = true;
      if (addr === TCCR2B) strobes = pending.value & 0xc0;
    }
    if (counter) this.compareBlocked = true;
    if (controls) this.updateWaveformMode(oldMode);
    if (compare && !this.isPwmMode()) this.updateCompareBuffers();
    this.refreshPrescaler();
    if (!this.isPwmMode()) {
      if ((strobes & 0x80) !== 0) this.handleCompareOutput("A");
      if ((strobes & 0x40) !== 0) this.handleCompareOutput("B");
    }
    this.scheduleClockEvent();
    this.scheduleAsyncUpdate();
    if (controls) {
      this.notifyPwm("A");
      this.notifyPwm("B");
    }
  }

  private compareBusy(channel: PwmChannel): boolean {
    const mask = (1 << TCN2UB) | (1 << (channel === "A" ? OCR2AUB : OCR2BUB));
    return (this.cpu.data[ASSR]! & mask) !== 0;
  }

  private incrementCounter(): void {
    if (this.asyncOverflowPending) {
      this.asyncOverflowPending = false;
      this.raiseFlag(1 << TOV2);
    }
    const counter = this.cpu.data[TCNT2]!;
    const mode = this.waveformMode();
    const top = this.modeTop();
    // Equality is sampled before counting: OCF appears on the following clock.
    const blocked = this.compareBlocked;
    this.assertCompareFlags(counter, blocked);
    this.compareBlocked = false;
    if (mode === 1 || mode === 5) {
      if (top === 0) {
        this.cpu.data[TCNT2] = 0;
        this.updateCompareBuffers();
        this.handleBottom();
        this.setOverflowFlag();
        return;
      }
      const next = (counter + (this.countingDown ? -1 : 1)) & 0xff;
      this.cpu.data[TCNT2] = next;
      this.handleCompare(next, this.countingDown ? "down" : "up");
      if (this.countingDown && next === 0) {
        this.countingDown = false;
        this.handleBottom();
        this.setOverflowFlag();
      } else if (!this.countingDown && next === top && (mode === 1 || !this.compareBusy("A"))) {
        this.countingDown = true;
        this.updateCompareBuffers();
        // A new duty after a full-duty period must start the falling slope low.
        this.syncPwmAtTop("A");
        this.syncPwmAtTop("B");
      }
      return;
    }

    if ((mode === 2 || mode === 3 || mode === 7) && counter === top &&
        (mode === 3 || (!blocked && !this.compareBusy("A")))) {
      this.cpu.data[TCNT2] = 0;
      if (mode !== 2) {
        this.updateCompareBuffers();
        this.handleBottom();
        // The 8-bit fast-PWM overflow edge is TOP -> BOTTOM (timing diagrams).
        this.setOverflowFlag();
      } else if (counter === 0xff) this.setOverflowFlag();
      this.handleCompare(0);
      return;
    }

    const next = (counter + 1) & 0xff;
    this.cpu.data[TCNT2] = next;
    if (next === 0) {
      if (this.isPwmMode()) this.updateCompareBuffers();
      this.handleBottom();
      if (mode !== 3 && mode !== 7) this.setOverflowFlag();
    }
    if (counter === 0 && !blocked && (mode === 3 || mode === 7)) {
      if (this.activeOcrA === 0) this.handleCompareOutput("A");
      if (this.activeOcrB === 0) this.handleCompareOutput("B");
    }
    this.handleCompare(next);
  }

  private setOverflowFlag(): void {
    if (this.asyncMode()) {
      // Overflow has no existing next-clock compare stage: retain it until
      // the following timer clock, then cross the three CPU-clock stages.
      if ((this.cpu.data[TIFR2]! & (1 << TOV2)) === 0) this.asyncOverflowPending = true;
      return;
    }
    this.raiseFlag(1 << TOV2);
  }

  private advanceCounter(steps: number, firstCycle = this.cpu.cycles, period = this.cachedPrescaler ?? 0): void {
    let remaining = steps;
    while (remaining > 0) {
      const untilEvent = this.stepsUntilNextEvent();
      if (untilEvent > remaining) {
        this.cpu.data[TCNT2] = (this.cpu.data[TCNT2]! + (this.countingDown ? -remaining : remaining)) & 0xff;
        return;
      }
      if (untilEvent > 1) {
        this.cpu.data[TCNT2] = (this.cpu.data[TCNT2]! + (this.countingDown ? 1 - untilEvent : untilEvent - 1)) & 0xff;
        remaining -= untilEvent - 1;
        firstCycle += (untilEvent - 1) * period;
      }
      this.counterEventCycle = firstCycle;
      this.incrementCounter();
      remaining -= 1;
      firstCycle += period;
    }
  }

  private syncToCpuCycle(): void {
    const now = this.cpu.cycles;
    const elapsed = now - this.lastCycle;
    if (elapsed <= 0) return;
    this.lastCycle = now;
    if (this.frozen()) return;
    const prescaler = this.cachedPrescaler;
    if (prescaler === undefined) return;
    const total = this.prescalerRemainder + elapsed;
    const steps = Math.floor(total / prescaler);
    this.prescalerRemainder = total - steps * prescaler;
    if (steps > 0) this.advanceCounter(steps, now - this.prescalerRemainder - (steps - 1) * prescaler);
  }

  private syncWithOldRegister(addr: number, oldValue: number): number {
    const current = this.cpu.data[addr]!;
    this.cpu.data[addr] = oldValue & 0xff;
    const mode = this.waveformMode();
    this.syncToCpuCycle();
    this.cpu.data[addr] = current;
    return mode;
  }

  private scheduleClockEvent(): void {
    const prescaler = this.cachedPrescaler;
    if (this.frozen() || prescaler === undefined) {
      this.cpu.clearClockEvent(this.onClockEvent);
      return;
    }
    const steps = this.stepsUntilNextEvent();
    const cycles =
      prescaler - this.prescalerRemainder + (steps > 1 ? (steps - 1) * prescaler : 0);
    this.cpu.addClockEvent(this.onClockEvent, Math.ceil(cycles));
  }

  private stepsUntilNextEvent(): number {
    const counter = this.cpu.data[TCNT2]!;
    const mode = this.waveformMode();
    if (this.asyncOverflowPending || this.compareBlocked || counter === this.activeOcrA || counter === this.activeOcrB) return 1;
    if ((mode === 2 || this.isPwmMode()) && (counter === this.modeTop() || counter === 0)) return 1;
    if ((mode === 1 || mode === 5) && this.countingDown) {
      return Math.min(
        counter,
        this.activeOcrA < counter ? counter - this.activeOcrA : counter,
        this.activeOcrB < counter ? counter - this.activeOcrB : counter,
      );
    }
    return Math.min(
      stepsUntil8BitValue(counter, this.activeOcrA),
      stepsUntil8BitValue(counter, this.activeOcrB),
      stepsUntil8BitValue(counter, this.modeTop()),
      stepsUntil8BitValue(counter, 0),
    );
  }

  private assertCompareFlags(counter: number, blocked: boolean): void {
    if (blocked) return;
    if (counter === this.activeOcrA && !this.compareBusy("A")) {
      this.raiseFlag(1 << OCF2A);
    }
    if (counter === this.activeOcrB && !this.compareBusy("B")) {
      this.raiseFlag(1 << OCF2B);
    }
  }

  private raiseFlag(mask: number): void {
    if (!this.asyncMode()) {
      this.publishFlag(mask);
      return;
    }
    if ((this.cpu.data[TIFR2]! & mask) !== 0 || this.asyncFlags.has(mask)) return;
    this.asyncFlags.set(mask, {
      remainingCycles: 3,
      dueCycle: this.asyncIoPaused ? undefined : Math.ceil(this.counterEventCycle) + 3,
    });
    this.scheduleAsyncFlags();
  }

  private publishFlag(mask: number): void {
    this.cpu.setInterruptFlag(TIFR2, mask);
    if (mask === (1 << TOV2)) this.requestOverflowIfEnabled();
    else this.requestCompareIfEnabled(mask === (1 << OCF2A) ? "A" : "B");
  }

  private asyncWakeEnabled(): boolean {
    return this.asyncIoPaused && this.cpu.isSleeping && [1, 3, 7].includes(this.cpu.sleepMode)
      && [...this.asyncFlags.keys()].some((mask) => (this.cpu.data[TIMSK2]! & mask) !== 0);
  }

  private scheduleAsyncFlags(): void {
    this.cpu.clearClockEvent(this.onAsyncFlagEvent);
    if (this.asyncFlags.size === 0) return;
    if (this.asyncIoPaused) {
      if (this.asyncWakeEnabled()) this.cpu.addClockEvent(this.onAsyncFlagEvent, 1);
      return;
    }
    let due = Infinity;
    for (const pending of this.asyncFlags.values()) due = Math.min(due, pending.dueCycle!);
    this.cpu.addClockEvent(this.onAsyncFlagEvent, Math.max(1, Math.ceil(due - this.cpu.cycles)));
  }

  private transferAsyncFlags(): void {
    if (this.asyncFlags.size === 0) return;
    if (this.asyncIoPaused) {
      if (this.asyncWakeEnabled()) {
        this.cpu.clearClockEvent(this.onAsyncFlagEvent);
        this.cpu.wakeForPeripheral();
      }
      return;
    }
    for (const [mask, pending] of this.asyncFlags) {
      if (pending.dueCycle! > this.cpu.cycles) continue;
      this.asyncFlags.delete(mask);
      this.publishFlag(mask);
    }
    this.scheduleAsyncFlags();
  }

  private handleCompare(counter: number, direction: "up" | "down" = "up"): void {
    if (counter === this.activeOcrA) this.handleCompareOutput("A", direction);
    if (counter === this.activeOcrB) this.handleCompareOutput("B", direction);
  }

  private requestCompareIfEnabled(channel: PwmChannel): void {
    const flagBit = channel === "A" ? OCF2A : OCF2B;
    const enableBit = channel === "A" ? OCIE2A : OCIE2B;
    const vector = channel === "A" ? TIMER2_COMPA_VECTOR : TIMER2_COMPB_VECTOR;
    const flag = (this.cpu.data[TIFR2]! & (1 << flagBit)) !== 0;
    const enabled = (this.cpu.data[TIMSK2]! & (1 << enableBit)) !== 0;
    if (!flag || !enabled) {
      this.cpu.clearInterrupt(vector);
      return;
    }
    this.cpu.requestInterrupt(vector, () => {
      this.cpu.data[TIFR2] = this.cpu.data[TIFR2]! & ~(1 << flagBit);
    });
  }

  private requestOverflowIfEnabled(): void {
    const overflowFlag = (this.cpu.data[TIFR2]! & (1 << TOV2)) !== 0;
    const overflowEnabled = (this.cpu.data[TIMSK2]! & (1 << TOIE2)) !== 0;
    if (!overflowFlag || !overflowEnabled) {
      this.cpu.clearInterrupt(TIMER2_OVF_VECTOR);
      return;
    }
    this.cpu.requestInterrupt(TIMER2_OVF_VECTOR, () => {
      this.cpu.data[TIFR2] = this.cpu.data[TIFR2]! & ~(1 << TOV2);
    });
  }

  private prescaler(): number | undefined {
    const bits = this.cpu.data[TCCR2B]! & ((1 << CS22) | (1 << CS21) | (1 << CS20));
    return TIMER2_PRESCALER[bits];
  }

  /**
   * Recompute the cached prescaler from TCCR2B (scaled by the TOSC ratio in
   * async mode); call on every CS-bit, AS2, or clock change.
   */
  private refreshPrescaler(): void {
    const base = this.prescaler();
    this.cachedPrescaler = base === undefined ? undefined : base * this.asyncScale();
    this.prescalerRemainder = this.cachedPrescaler === undefined ? 0
      : this.dividerPhase() % this.cachedPrescaler;
  }

  private waveformMode(): number {
    return ((this.cpu.data[TCCR2B]! >> WGM22) & 1) << 2 | (this.cpu.data[TCCR2A]! & 3);
  }

  private modeTop(): number {
    const mode = this.waveformMode();
    return mode === 2 || mode === 5 || mode === 7 ? this.activeOcrA : 255;
  }

  private pwmMode(): PwmSignal["mode"] {
    const mode = this.waveformMode();
    return mode === 1 || mode === 5 ? "phase-correct-pwm"
      : mode === 3 || mode === 7 ? "fast-pwm" : mode === 0 ? "off" : "other";
  }

  private ocrValue(channel: PwmChannel): number {
    return channel === "A" ? this.activeOcrA : this.activeOcrB;
  }

  private updateWaveformMode(oldMode: number): void {
    if (oldMode === this.waveformMode()) return;
    if (this.waveformMode() !== 1 && this.waveformMode() !== 5) this.countingDown = false;
    if (!this.isPwmMode()) this.updateCompareBuffers();
  }

  private updateCompareBuffers(): void {
    const nextA = this.cpu.data[OCR2A]!;
    const nextB = this.cpu.data[OCR2B]!;
    if (nextA === this.activeOcrA && nextB === this.activeOcrB) return;
    this.activeOcrA = nextA;
    this.activeOcrB = nextB;
    this.emitPwm("A");
    this.emitPwm("B");
  }

  private notifyPwm(channel: PwmChannel): void {
    this.syncOutput(channel);
    this.emitPwm(channel);
  }

  private emitPwm(channel: PwmChannel): void {
    this.pwm.emit(channel, this.readPwm(channel));
  }

  private handleBottom(): void {
    if (!this.isPwmMode()) return;
    this.syncPwmOutput("A", "bottom");
    this.syncPwmOutput("B", "bottom");
  }

  private handleCompareOutput(channel: PwmChannel, direction: "up" | "down" = "up"): void {
    if (this.compareBusy(channel)) return;
    if (this.isPwmMode()) {
      this.syncPwmOutput(channel, "compare", direction);
      return;
    }

    const mode = this.compareMode(channel);
    if (mode === 0) {
      this.driveOutput(channel, undefined);
    } else if (mode === 1) {
      const pin = this.outputPin(channel);
      this.driveOutput(channel, !this.gpio?.readPin(pin.port, pin.bit));
    } else {
      this.driveOutput(channel, mode === 3);
    }
  }

  private syncOutput(channel: PwmChannel): void {
    if (this.isPwmMode()) {
      const compare = this.compareMode(channel);
      if (compare === 0 || (compare === 1 && !this.pwmToggleEnabled(channel))) this.driveOutput(channel, undefined);
      else if (this.cpu.data[TCNT2] === 0) this.syncPwmOutput(channel, "bottom");
    } else if (this.compareMode(channel) === 0) this.driveOutput(channel, undefined);
  }

  private syncPwmOutput(channel: PwmChannel, edge: "bottom" | "compare", direction: "up" | "down" = "up"): void {
    const mode = this.compareMode(channel);
    if (mode === 1 && this.pwmToggleEnabled(channel)) {
      if (edge === "compare") {
        const pin = this.outputPin(channel);
        this.driveOutput(channel, !this.gpio?.readPin(pin.port, pin.bit));
      }
      return;
    }
    if (!this.isPwmMode() || mode < 2) {
      this.driveOutput(channel, undefined);
      return;
    }
    if (this.syncPwmExtremes(channel)) return;
    if (edge === "compare" && this.pwmMode() === "fast-pwm" && this.ocrValue(channel) === 0 && this.cpu.data[TCNT2] === 0) return;
    this.driveOutput(channel, edge === "bottom" || direction === "down" ? mode !== 3 : mode === 3);
  }

  private syncPwmAtTop(channel: PwmChannel): void {
    if (this.compareBusy(channel)) return;
    if (this.compareMode(channel) < 2 || this.syncPwmExtremes(channel) || this.ocrValue(channel) > this.modeTop()) return;
    this.driveOutput(channel, this.compareMode(channel) === 3);
  }

  private syncPwmExtremes(channel: PwmChannel): boolean {
    const mode = this.compareMode(channel);
    if (mode < 2) return false;
    if (this.ocrValue(channel) === this.modeTop()) {
      this.driveOutput(channel, mode !== 3);
      return true;
    }
    if (this.ocrValue(channel) === 0 && this.pwmMode() === "phase-correct-pwm") {
      this.driveOutput(channel, mode === 3);
      return true;
    }
    return false;
  }

  private pwmToggleEnabled(channel: PwmChannel): boolean {
    const mode = this.waveformMode();
    return channel === "A" && (mode === 5 || mode === 7);
  }

  private compareMode(channel: PwmChannel): number {
    const value = this.cpu.data[TCCR2A]!;
    return channel === "A"
      ? (value >> COM2A0) & ((1 << (COM2A1 - COM2A0 + 1)) - 1)
      : (value >> COM2B0) & ((1 << (COM2B1 - COM2B0 + 1)) - 1);
  }

  private isPwmMode(): boolean {
    const mode = this.waveformMode();
    return mode === 1 || mode === 3 || mode === 5 || mode === 7;
  }

  private outputPin(channel: PwmChannel): { port: PortName; bit: number } {
    return channel === "A" ? { port: "B", bit: 3 } : { port: "D", bit: 3 };
  }

  private driveOutput(channel: PwmChannel, high: boolean | undefined): void {
    const pin = this.outputPin(channel);
    this.gpio?.setPeripheralOutput(pin.port, pin.bit, high);
  }

  // --- Snapshot / restore (Phase 10) ---

  snapshot(): Timer2Snapshot {
    this.syncToCpuCycle();
    return {
      countingDown: this.countingDown,
      activeOcrA: this.activeOcrA,
      activeOcrB: this.activeOcrB,
      compareBlocked: this.compareBlocked,
      prescalerRemainder: this.prescalerRemainder,
      dividerPhase: this.dividerPhase(),
      asyncBusyMask: this.cpu.data[ASSR]! & ASSR_BUSY_MASK,
      asyncBusyRemaining: this.cpu.clockEventRemainingCycles(this.onAsyncUpdateEvent),
      toscPhase: this.toscPhase(),
      asyncWrites: [...this.asyncWrites].map(([register, pending]) => ({
        register, value: pending.value, remainingCycles: pending.dueCycle - this.toscNow(),
      })),
      asyncSleepCounter: this.asyncWakeReadUntil === undefined || this.asyncWakeReadUntil > this.cpu.cycles
        ? this.asyncSleepCounter : undefined,
      asyncWakeReadRemaining: this.asyncWakeReadUntil === undefined ? undefined
        : Math.max(0, this.asyncWakeReadUntil - this.cpu.cycles),
      asyncOverflowPending: this.asyncOverflowPending,
      asyncFlags: [...this.asyncFlags].map(([mask, pending]) => ({
        mask, remainingCycles: pending.dueCycle === undefined ? pending.remainingCycles
          : Math.max(0, pending.dueCycle - this.cpu.cycles),
      })),
    };
  }

  restore(snap: Timer2Snapshot, clockHz = this.clockHz): void {
    this.clockHz = clockHz;
    this.countingDown = snap.countingDown ?? false;
    this.activeOcrA = (snap.activeOcrA ?? this.cpu.data[OCR2A]!) & 0xff;
    this.activeOcrB = (snap.activeOcrB ?? this.cpu.data[OCR2B]!) & 0xff;
    this.compareBlocked = snap.compareBlocked ?? false;
    this.prescalerHeld = false;
    this.powerReduced = false;
    this.sleepPaused = false;
    this.prescalerRemainder = snap.prescalerRemainder ?? 0;
    this.lastCycle = this.cpu.cycles;
    this.toscCycleBase = this.cpu.cycles - (snap.toscPhase ?? 0);
    this.toscPausedAt = undefined;
    this.asyncSleepCounter = snap.asyncSleepCounter;
    this.asyncWakeReadUntil = snap.asyncSleepCounter !== undefined && (snap.asyncWakeReadRemaining ?? 0) > 0
      ? this.cpu.cycles + snap.asyncWakeReadRemaining! : undefined;
    this.asyncOverflowPending = snap.asyncOverflowPending ?? false;
    this.asyncIoPaused = this.cpu.isSleeping && this.cpu.sleepMode !== 0;
    this.asyncFlags.clear();
    for (const pending of snap.asyncFlags ?? []) {
      if (![1 << TOV2, 1 << OCF2A, 1 << OCF2B].includes(pending.mask)) continue;
      this.asyncFlags.set(pending.mask, {
        remainingCycles: pending.remainingCycles,
        dueCycle: this.asyncIoPaused ? undefined : this.cpu.cycles + pending.remainingCycles,
      });
    }
    this.scheduleAsyncFlags();
    this.dividerCycleBase = this.cpu.cycles - (snap.dividerPhase ?? snap.prescalerRemainder ?? 0);
    this.dividerPausedAt = undefined;
    this.cpu.clearClockEvent(this.onAsyncUpdateEvent);
    this.asyncWrites.clear();
    if (snap.asyncWrites !== undefined) {
      for (const pending of snap.asyncWrites) {
        if (ASYNC_BUSY_BITS[pending.register] === undefined) continue;
        this.asyncWrites.set(pending.register, {
          value: pending.value === undefined ? undefined : pending.value & 0xff,
          dueCycle: this.cpu.cycles + pending.remainingCycles,
        });
      }
    } else if ((snap.asyncBusyRemaining ?? 0) > 0) {
      for (const register of ASYNC_REGISTERS) {
        if (((snap.asyncBusyMask ?? 0) & (1 << ASYNC_BUSY_BITS[register]!)) === 0) continue;
        this.asyncWrites.set(register, { dueCycle: this.cpu.cycles + snap.asyncBusyRemaining! });
      }
    }
    this.scheduleAsyncUpdate();
    this.refreshPrescaler();
    this.scheduleClockEvent();
  }
}

function stepsUntil8BitValue(counter: number, target: number): number {
  return ((target - counter + 255) & 0xff) + 1;
}
