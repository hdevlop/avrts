import {
  DATA_SIZE,
  FLASH_WORDS,
  IO_BASE,
  RAMEND,
  SE,
  SMCR,
  SPH_ADDR,
  SPL_ADDR,
} from "./constants";
import { Sreg } from "./sreg";
import { UnknownOpcodeError } from "./errors";
import type {
  CycleListener,
  Executor,
  InterruptAcknowledgeResolver,
  IoReadHook,
  IoWriteHook,
  PendingInterrupt,
  TraceListener,
  TraceState,
} from "./types";
import type { CpuSnapshot } from "../snapshot";

/**
 * The ATmega328P core: program memory (flash), the flat data space (registers +
 * I/O + SRAM), and the CPU's own state (PC, cycles, SP, SREG).
 *
 * Phase 1 is the shell — no instruction execution yet. `writeData` is the single
 * choke point peripherals will hook in later phases.
 */
export class CPU {
  /** Program memory: 16-bit words, indexed by the program counter. */
  readonly flash: Uint16Array;
  /** Data space: R0..R31, I/O registers, then SRAM — one flat byte array. */
  readonly data: Uint8Array;
  /** Status register accessor (mirrors data[0x5F]). */
  readonly sreg: Sreg;

  /** Program counter (word index into `flash`). */
  pc = 0;
  /** Internal cycle counter (the unit of simulated time). */
  private _cycles = 0;

  /**
   * Total elapsed clock cycles — the unit of simulated time. Writes to this
   * property fire cycle listeners immediately via the setter so that timers
   * and other peripherals can observe per-cycle boundaries when running in
   * `"cycle-exact"` timing mode. In `"fast"` mode (default) the setter still
   * fires the listeners, but coalesces the whole instruction's worth of
   * cycles into one call — preserving the existing performance profile.
   */
  get cycles(): number {
    return this._cycles;
  }
  set cycles(value: number) {
    const delta = value - this._cycles;
    this._cycles = value;
    if (delta <= 0) return;
    if (this.timing === "cycle-exact") {
      for (let i = 0; i < delta; i += 1) this.notifyCycles(1);
    } else {
      this.notifyCycles(delta);
    }
  }

  private readonly traceListeners: TraceListener[] = [];
  private readonly cycleListeners: CycleListener[] = [];
  private readonly pendingInterrupts: PendingInterrupt[] = [];
  // Sparse, indexed by data-space address; peripherals install hooks here.
  private readonly writeHooks: Array<IoWriteHook[] | undefined> = [];
  private readonly readHooks: Array<IoReadHook[] | undefined> = [];
  private readonly wdrListeners: Array<() => void> = [];
  private sleeping = false;
  private executor?: Executor;

  // --- Debug state (Phase 11) ---
  /** PC addresses that should pause execution before the instruction runs. */
  readonly breakpoints = new Set<number>();
  /** When true, an unknown opcode stops execution and is captured as `error`. */
  pauseOnUnknownOpcode = false;
  private _breakpointHit = false;
  private _error: unknown = null;

  // --- Timing mode (Phase 12) ---
  /**
   * How peripherals observe simulated time:
   *   - `"fast"`: one notifyCycles(N) per instruction (cheap).
   *   - `"cycle-exact"`: N notifyCycles(1) calls so peripheral events line up
   *     with individual CPU cycles inside multi-cycle instructions.
   */
  timing: "fast" | "cycle-exact" = "fast";

  constructor(flash?: Uint16Array) {
    this.flash = flash ?? new Uint16Array(FLASH_WORDS);
    this.data = new Uint8Array(DATA_SIZE);
    this.sreg = new Sreg(this.data);
    this.reset();
  }

  /** Power-on state: clear data space, PC=0, cycles=0, SP=RAMEND. */
  reset(): void {
    this.pc = 0;
    this.cycles = 0;
    this.sleeping = false;
    this.data.fill(0);
    this.SP = RAMEND;
  }

  /** Enter sleep (SLEEP instruction). Only sleeps if SMCR.SE is set, per hardware. */
  sleep(): void {
    if ((this.data[SMCR]! & (1 << SE)) !== 0) this.sleeping = true;
  }

  get isSleeping(): boolean {
    return this.sleeping;
  }

  /** Register a listener fired by the WDR instruction (watchdog reset). */
  onWdr(listener: () => void): () => void {
    this.wdrListeners.push(listener);
    return () => {
      const index = this.wdrListeners.indexOf(listener);
      if (index >= 0) this.wdrListeners.splice(index, 1);
    };
  }

  /** Called by the WDR instruction to reset the watchdog timer. */
  kickWatchdog(): void {
    for (const listener of [...this.wdrListeners]) listener();
  }

  // --- Stack pointer: little-endian across SPL (0x5D) / SPH (0x5E) ---
  get SP(): number {
    return this.data[SPL_ADDR]! | (this.data[SPH_ADDR]! << 8);
  }
  set SP(value: number) {
    this.data[SPL_ADDR] = value & 0xff;
    this.data[SPH_ADDR] = (value >> 8) & 0xff;
  }

  // --- Data-space access (the peripheral hook point) ---
  readData(addr: number): number {
    const hooks = this.readHooks[addr];
    if (hooks === undefined) return this.data[addr]!;
    let value = this.data[addr]!;
    for (const hook of hooks) {
      const result = hook(this, addr);
      if (result !== undefined) value = result & 0xff;
    }
    return value;
  }
  writeData(addr: number, value: number): void {
    const masked = value & 0xff;
    const hooks = this.writeHooks[addr];
    if (hooks === undefined) {
      this.data[addr] = masked;
      return;
    }
    const oldValue = this.data[addr]!;
    this.data[addr] = masked;
    for (const hook of hooks) hook(this, addr, masked, oldValue);
  }

  /** Register a peripheral hook fired after `addr` is written (via writeData/OUT/ST...). */
  installWriteHook(addr: number, hook: IoWriteHook): void {
    (this.writeHooks[addr] ??= []).push(hook);
  }

  /** Register a peripheral hook consulted when `addr` is read (via readData/IN/LD...). */
  installReadHook(addr: number, hook: IoReadHook): void {
    (this.readHooks[addr] ??= []).push(hook);
  }

  /** Register a peripheral clock listener fired after every instruction. */
  onCycles(listener: CycleListener): () => void {
    this.cycleListeners.push(listener);
    return () => this.removeCycleListener(listener);
  }

  /** Queue an interrupt by vector address; lowest vector has highest priority. */
  requestInterrupt(vector: number, acknowledge?: () => void): void {
    if (this.pendingInterrupts.some((pending) => pending.vector === vector)) return;
    this.pendingInterrupts.push({ vector, acknowledge });
    this.pendingInterrupts.sort((a, b) => a.vector - b.vector);
  }

  // --- I/O-space access: IN/OUT address A maps to data[A + 0x20] ---
  readIo(ioAddr: number): number {
    return this.readData(ioAddr + IO_BASE);
  }
  writeIo(ioAddr: number, value: number): void {
    this.writeData(ioAddr + IO_BASE, value);
  }

  // --- Stack (grows downward; SP points at the next free byte) ---
  pushByte(value: number): void {
    this.data[this.SP] = value & 0xff;
    this.SP = (this.SP - 1) & 0xffff;
  }

  popByte(): number {
    this.SP = (this.SP + 1) & 0xffff;
    return this.data[this.SP]!;
  }

  /** Push a 16-bit word (e.g. a return address): high byte lands at the lower address. */
  pushWord(value: number): void {
    this.pushByte(value & 0xff);
    this.pushByte((value >> 8) & 0xff);
  }

  popWord(): number {
    const high = this.popByte();
    const low = this.popByte();
    return (high << 8) | low;
  }

  // --- Execution ---
  /** Attach the decoder/executor that runs opcodes (keeps modules acyclic). */
  setExecutor(executor: Executor): void {
    this.executor = executor;
  }

  /** Fetch, decode, and execute one instruction (or idle one cycle while asleep). */
  tick(): void {
    if (this.breakpoints.has(this.pc)) {
      this._breakpointHit = true;
      return;
    }
    if (this.sleeping) {
      // The `cycles` setter fires cycle listeners (one per simulated cycle in
      // cycle-exact mode, otherwise coalesced).
      this.cycles += 1;
      this.serviceInterrupts();
      return;
    }
    const executor = this.executor;
    if (!executor) {
      throw new Error("CPU has no executor — call setExecutor(new Decoder()) first.");
    }
    const pc = this.pc;
    const opcode = this.flash[pc]!;
    try {
      // Each `cpu.cycles += N` inside the handler goes through the setter and
      // fires cycle listeners with the configured granularity. No explicit
      // notifyCycles call is needed here.
      executor.execute(this, opcode);
    } catch (e) {
      if (e instanceof UnknownOpcodeError && this.pauseOnUnknownOpcode) {
        this._error = e;
        return;
      }
      throw e;
    }
    this.serviceInterrupts();
    if (this.traceListeners.length > 0) {
      this.emitTrace({
        pc,
        opcode,
        mnemonic: executor.mnemonicOf(opcode) ?? "???",
        cycles: this.cycles,
      });
    }
  }

  /** Run until at least `maxCycles` additional cycles have elapsed or a debug stop fires. */
  run(maxCycles: number): void {
    this._breakpointHit = false;
    const target = this.cycles + maxCycles;
    while (this.cycles < target) {
      this.tick();
      if (this._breakpointHit) return;
      if (this._error !== null) return;
    }
  }

  // --- Debug/trace hook (used heavily from Phase 2 on) ---
  onTrace(listener: TraceListener): () => void {
    this.traceListeners.push(listener);
    return () => this.removeTrace(listener);
  }

  /** Emit a trace record to all listeners (called by the execute loop later). */
  emitTrace(state: TraceState): void {
    for (const listener of this.traceListeners) listener(state);
  }

  private removeTrace(listener: TraceListener): void {
    const index = this.traceListeners.indexOf(listener);
    if (index >= 0) this.traceListeners.splice(index, 1);
  }

  private removeCycleListener(listener: CycleListener): void {
    const index = this.cycleListeners.indexOf(listener);
    if (index >= 0) this.cycleListeners.splice(index, 1);
  }

  /** Fire cycle listeners for `elapsed` consumed cycles (peripherals advance time). */
  private notifyCycles(elapsed: number): void {
    if (elapsed <= 0) return;
    for (const listener of [...this.cycleListeners]) listener(elapsed, this);
  }

  /**
   * Service one pending interrupt, then bill its entry cost (the 4 dispatch
   * cycles) to the peripherals so timers/watchdog/ADC keep accurate time while an
   * interrupt is taken. Peripherals have already ticked for this instruction, so
   * any interrupt they just queued is honored here before the cost is billed.
   */
  private serviceInterrupts(): void {
    // The `cycles += 4` in serviceNextInterrupt goes through the setter, which
    // already fires cycle listeners at the configured granularity. No extra
    // notifyCycles call is needed here.
    this.serviceNextInterrupt();
  }

  private serviceNextInterrupt(): void {
    if (!this.sreg.I || this.pendingInterrupts.length === 0) return;
    const interrupt = this.pendingInterrupts.shift()!;
    this.sleeping = false; // an enabled interrupt wakes the CPU from sleep
    interrupt.acknowledge?.();
    this.pushWord(this.pc);
    this.sreg.I = false;
    this.pc = interrupt.vector;
    this.cycles += 4;
  }

  // --- Debug accessors (Phase 11) ---

  /** True when the most recent `tick()` / `run()` was stopped by a breakpoint. */
  get wasBreakpointHit(): boolean {
    return this._breakpointHit;
  }

  /** Clear the breakpoint-hit flag at the start of a new run. */
  clearBreakpointHit(): void {
    this._breakpointHit = false;
  }

  /**
   * Captured error from the most recent `tick()` / `run()` (e.g. an unknown
   * opcode when `pauseOnUnknownOpcode` is enabled). Null when no error.
   */
  get error(): unknown {
    return this._error;
  }

  /** Clear the captured error so a subsequent run starts fresh. */
  clearError(): void {
    this._error = null;
  }

  // --- Snapshot / restore (Phase 10) ---

  /**
   * Capture CPU state as plain data. Flash and the data-space are copied so the
   * snapshot is independent of further CPU activity. Pending interrupt acknowledge
   * callbacks (which capture `this` of peripherals) are intentionally dropped —
   * ISRs will clear their own flags via TIFR writes on entry.
   */
  snapshot(): CpuSnapshot {
    return {
      pc: this.pc,
      cycles: this.cycles,
      sleeping: this.sleeping,
      data: new Uint8Array(this.data),
      flash: new Uint16Array(this.flash),
      pendingInterrupts: this.pendingInterrupts.map((p) => p.vector),
    };
  }

  /**
   * Replace CPU state from a snapshot. Does not fire peripheral write hooks (it
   * writes `data` directly) — peripherals that need a resync should call their own
   * `resync()` or be restored explicitly by the runtime.
   */
  restore(snap: CpuSnapshot, acknowledgeForVector?: InterruptAcknowledgeResolver): void {
    this.pc = snap.pc;
    this._cycles = snap.cycles;
    this.sleeping = snap.sleeping;
    this.data.set(snap.data);
    this.flash.set(snap.flash);
    this.pendingInterrupts.length = 0;
    for (const vector of snap.pendingInterrupts) {
      this.pendingInterrupts.push({ vector, acknowledge: acknowledgeForVector?.(vector) });
    }
    this.pendingInterrupts.sort((a, b) => a.vector - b.vector);
  }
}
