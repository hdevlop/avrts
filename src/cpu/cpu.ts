import {
  DATA_SIZE,
  FLASH_WORDS,
  IO_BASE,
  RAMEND,
  SE,
  SMCR,
  SPH_ADDR,
  SPL_ADDR,
  SREG_ADDR,
} from "./constants";
import { Sreg } from "./sreg";
import { UnknownOpcodeError } from "./errors";
import type {
  CycleListener,
  Executor,
  InstructionHandler,
  InterruptAcknowledgeResolver,
  IoReadHook,
  IoWriteHook,
  PendingInterrupt,
  ProfileRunListener,
  ProfileRunState,
  TraceListener,
  TraceState,
} from "./types";
import type { CpuSnapshot } from "../snapshot";
import {
  SREG_ARITH_MASK,
  SREG_C,
  SREG_H,
  SREG_I,
  SREG_N,
  SREG_S,
  SREG_T,
  SREG_V,
  SREG_WORD_MASK,
  SREG_Z,
  imm8,
  regD4,
  regD5,
  regR5,
  sub8,
} from "./alu";

const NOOP = (): void => {};

export type Udivmodsi4RegionMode = "handwritten" | "generated-cfg";

/**
 * A scheduled clock event (Phase 7 event-driven peripherals). Peripherals call
 * `addClockEvent` to fire `callback` at an absolute `cycles` boundary instead of
 * being ticked every instruction. Nodes form a sorted singly-linked list and are
 * pooled to avoid per-schedule allocation.
 */
interface ClockEvent {
  cycles: number;
  callback: () => void;
  next: ClockEvent | undefined;
}

const FAST_BLOCK_UNKNOWN = 0;
const FAST_BLOCK_NONE = 1;
const FAST_BLOCK_RJMP_SELF = 2;
const FAST_BLOCK_ZERO_SBIW_BREQ = 3;
const FAST_BLOCK_SHIFT_LEFT_DEC = 4;
const FAST_BLOCK_SHIFT_RIGHT_DEC = 5;
const FAST_BLOCK_ARDUINO_MICROS = 6;
const FAST_BLOCK_SUBCMP_RUN = 7;
const FAST_BLOCK_UDIVMODSI4_LOOP = 8;
const FAST_BLOCK_UMULHISI3 = 9;

// Minimum straight-line subtract/compare run length worth executing as one block
// (the Arduino delay() 64-bit compare chain is 8 long).
const SUBCMP_RUN_MIN = 3;

// Subtract/compare-class descriptors (0 = not in the class).
const SUBCMP_SUB = 1;
const SUBCMP_SBC = 2;
const SUBCMP_CP = 3;
const SUBCMP_CPC = 4;
const SUBCMP_SUBI = 5;
const SUBCMP_SBCI = 6;
const SUBCMP_CPI = 7;

const FAST_BLOCK_PROFILE_KINDS: readonly ProfileRunState["blockKind"][] = [
  undefined,
  undefined,
  "rjmp-self",
  "zero-sbiw-breq",
  "shift-left-dec",
  "shift-right-dec",
  "arduino-micros",
  "subcmp-run",
  "udivmodsi4-loop",
  "umulhisi3",
];

/**
 * The ATmega328P core: program memory (flash), the flat data space (registers +
 * I/O + SRAM), and the CPU's own state (PC, cycles, SP, SREG).
 *
 * Phase 1 is the shell — no instruction execution yet. `writeData` is the single
 * choke point peripherals will hook in later phases.
 */
export class CPU {
  /**
   * Selector for the `__udivmodsi4` hot region. The generated CFG-style path is
   * the default after beating the handwritten FastBlock on sensor-format.
   */
  static udivmodsi4RegionMode: Udivmodsi4RegionMode = "generated-cfg";

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
    if (this.timing !== "cycle-exact") {
      this._cycles = value;
      if (delta <= 0) return;
      this.notifyCycles(delta);
      // Event-scheduled peripherals: fire anything now due. The inline guard keeps
      // this to one comparison when nothing is scheduled (the common case).
      const next = this.nextClockEvent;
      if (next !== undefined && next.cycles <= this._cycles) this.runDueClockEvents();
      return;
    }

    if (delta <= 0) {
      this._cycles = value;
      return;
    }
    this.advanceCycleExact(delta);
  }

  private advanceCycleExact(delta: number): void {
    for (let i = 0; i < delta; i += 1) {
      this._cycles += 1;
      const next = this.nextClockEvent;
      if (next !== undefined && next.cycles <= this._cycles) this.runDueClockEvents();
      this.notifyCycles(1);
    }
  }

  private readonly traceListeners: TraceListener[] = [];
  private readonly cycleListeners: CycleListener[] = [];
  private readonly pendingCycleListenerRemovals: CycleListener[] = [];
  private readonly pendingCycleListenerRemovalDepths = new Map<CycleListener, number>();
  private cycleListenerDispatchDepth = 0;
  private readonly pendingInterrupts: PendingInterrupt[] = [];
  // Sparse, indexed by data-space address; peripherals install hooks here.
  private readonly writeHooks: Array<IoWriteHook[] | undefined> = [];
  private readonly readHooks: Array<IoReadHook[] | undefined> = [];
  private readonly wdrListeners: Array<() => void> = [];
  // Event-scheduled peripheral clock events (sorted by absolute cycle), plus a
  // small reuse pool. `nextClockEvent === undefined` is the common case (no
  // peripheral has scheduled anything), so the hot path is a single null check.
  private nextClockEvent: ClockEvent | undefined = undefined;
  private readonly clockEventPool: ClockEvent[] = [];
  private sleeping = false;
  private executor?: Executor;
  /**
   * Phase 4 predecode: lazily filled handler-per-PC cache. `tick()` resolves the
   * handler from `flash[pc]` once and reuses it on later executions of the same
   * PC, dispatching without an `executor.execute()` call frame. Invalidated when
   * flash content changes (`reset`, `restore`, or an explicit
   * `invalidateDecodeCache()` after a direct `flash` write).
   */
  private decodeCache: Array<InstructionHandler | undefined> = [];
  /**
   * PC-local classifier for guarded fast blocks. Unlike `decodeCache`, this
   * stores only tiny numeric kinds for block shapes that were already proven by
   * parity tests; `FAST_BLOCK_NONE` avoids re-checking non-matching candidate PCs.
   */
  private fastBlockCache: number[] = [];

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
    // Flash may have been (re)loaded just before reset(); drop stale handlers.
    this.invalidateDecodeCache();
    // Power-on clears any scheduled peripheral events; peripherals re-arm in
    // their own reset()/write hooks from the freshly zeroed register state.
    this.nextClockEvent = undefined;
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

  /**
   * Schedule `callback` to fire once, `cyclesFromNow` cycles from the current
   * cycle (minimum 1). The event fires when `cycles` next advances past it. The
   * `callback` identity is the handle for `clearClockEvent`; re-scheduling the
   * same callback is "clear then add". Replaces per-instruction `tick()` for
   * peripherals that know when their next event is due (Phase 7).
   */
  addClockEvent(callback: () => void, cyclesFromNow: number): void {
    this.clearClockEvent(callback);
    const at = this._cycles + (cyclesFromNow > 1 ? cyclesFromNow : 1);
    const entry = this.clockEventPool.pop() ?? { cycles: 0, callback, next: undefined };
    entry.cycles = at;
    entry.callback = callback;
    let prev: ClockEvent | undefined;
    let cur = this.nextClockEvent;
    while (cur !== undefined && cur.cycles <= at) {
      prev = cur;
      cur = cur.next;
    }
    entry.next = cur;
    if (prev === undefined) this.nextClockEvent = entry;
    else prev.next = entry;
  }

  /** Cancel the pending event scheduled with `callback` (no-op if none). */
  clearClockEvent(callback: () => void): void {
    let prev: ClockEvent | undefined;
    let cur = this.nextClockEvent;
    while (cur !== undefined) {
      if (cur.callback === callback) {
        if (prev === undefined) this.nextClockEvent = cur.next;
        else prev.next = cur.next;
        this.recycleClockEvent(cur);
        return;
      }
      prev = cur;
      cur = cur.next;
    }
  }

  /** Fire every event whose cycle boundary has been reached. */
  private runDueClockEvents(): void {
    let event = this.nextClockEvent;
    while (event !== undefined && event.cycles <= this._cycles) {
      this.nextClockEvent = event.next;
      const callback = event.callback;
      this.recycleClockEvent(event);
      callback(); // may schedule new events (e.g. a peripheral re-arming)
      event = this.nextClockEvent;
    }
  }

  private recycleClockEvent(event: ClockEvent): void {
    event.callback = NOOP;
    event.next = undefined;
    if (this.clockEventPool.length < 16) this.clockEventPool.push(event);
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
    this.invalidateDecodeCache();
  }

  /**
   * Drop the predecode cache. Call this after mutating `flash` directly (the
   * low-level escape hatch) so stale handlers/blocks cannot execute old code.
   * `reset()`, `restore()`, and `setExecutor()` invalidate automatically.
   */
  invalidateDecodeCache(): void {
    this.decodeCache.length = 0;
    this.fastBlockCache.length = 0;
  }

  /** Fetch, decode, and execute one instruction (or idle one cycle while asleep). */
  tick(): void {
    // Guard on size first: the common case has no breakpoints, so this skips
    // the Set hash lookup on every instruction.
    if (this.breakpoints.size > 0 && this.breakpoints.has(this.pc)) {
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
      //
      // Phase 4 predecode: reuse the handler resolved for this PC. On a miss,
      // resolve once and cache it; an unknown opcode falls through to
      // `executor.execute()` so the rich UnknownOpcodeError is still thrown.
      let handler = this.decodeCache[pc];
      if (handler === undefined) {
        handler = executor.handlerFor(opcode);
        if (handler === undefined) {
          executor.execute(this, opcode); // throws UnknownOpcodeError
          return;
        }
        this.decodeCache[pc] = handler;
      }
      handler(this, opcode);
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
    const target = this._cycles + maxCycles;
    if (this.canUseFastRun()) {
      this.runGeneratedFastCore(target);
      return;
    }
    while (this._cycles < target) {
      this.tick();
      if (this._breakpointHit) return;
      if (this._error !== null) return;
    }
  }

  /**
   * Run with the same fast path as `run()`, but emit coarse profiling events.
   * Intended for benchmark scripts; debugger tracing still uses `onTrace()`.
   */
  profileRun(maxCycles: number, listener: ProfileRunListener): void {
    this._breakpointHit = false;
    const target = this._cycles + maxCycles;
    if (this.canUseFastRun()) {
      this.runFastProfiled(target, listener);
      return;
    }

    this.runProfiledTicks(target, listener);
  }

  private runProfiledTicks(target: number, listener: ProfileRunListener): void {
    const executor = this.executor;
    if (!executor) {
      throw new Error("CPU has no executor — call setExecutor(new Decoder()) first.");
    }
    while (this._cycles < target) {
      const pc = this.pc;
      const opcode = this.flash[pc]!;
      const before = this._cycles;
      const sleeping = this.sleeping;
      this.tick();
      if (this._cycles !== before) {
        listener(this.profileState(pc, opcode, before, sleeping ? "sleep" : "instruction"));
      }
      if (this._breakpointHit) return;
      if (this._error !== null) return;
    }
  }

  private canUseFastRun(): boolean {
    return (
      this.breakpoints.size === 0 &&
      this.traceListeners.length === 0 &&
      !this.pauseOnUnknownOpcode
    );
  }



  // BEGIN GENERATED FAST CORE
  private runGeneratedFastCore(target: number): void {
    const executor = this.executor;
    if (!executor) {
      throw new Error("CPU has no executor - call setExecutor(new Decoder()) first.");
    }
    const flash = this.flash;
    const data = this.data;
    const decodeCache = this.decodeCache;
    while (this._cycles < target) {
      if (this.sleeping) {
        this.tick();
      } else {
        const pc = this.pc;
        const opcode = flash[pc]!;
        if ((opcode & 0xffcf) === 0x9700 && this.tryRunFastBlock(pc, opcode, target)) {
          continue;
        }
        else if (opcode === 0x0000) {
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xf000) === 0xc000) {
          const k = opcode & 0x0fff;
          if (k === 0x0fff && this.tryRunFastBlock(pc, opcode, target)) continue;
          this.pc += (k >= 0x800 ? k - 0x1000 : k) + 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfc00) === 0xf000) {
          if ((data[SREG_ADDR]! & (1 << (opcode & 0x07))) !== 0) {
            const k = (opcode >> 3) & 0x7f;
            this.pc += (k >= 0x40 ? k - 0x80 : k) + 1;
            this.cycles += 2;
          } else {
            this.pc += 1;
            this.cycles += 1;
          }
        }
        else if ((opcode & 0xfc00) === 0xf400) {
          if ((data[SREG_ADDR]! & (1 << (opcode & 0x07))) === 0) {
            const k = (opcode >> 3) & 0x7f;
            this.pc += (k >= 0x40 ? k - 0x80 : k) + 1;
            this.cycles += 2;
          } else {
            this.pc += 1;
            this.cycles += 1;
          }
        }
        else if ((opcode & 0xff00) === 0x9700) {
          const d = 24 + (((opcode >> 4) & 0x03) * 2);
          const k = (opcode & 0x0f) | ((opcode >> 2) & 0x30);
          const before = data[d]! | (data[d + 1]! << 8);
          const result = (before - k) & 0xffff;
          data[d] = result & 0xff;
          data[d + 1] = (result >> 8) & 0xff;
          const n = (result & 0x8000) !== 0;
          const v = (before & ~result & 0x8000) !== 0;
          const flags =
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (before < k ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_WORD_MASK) | flags;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xf000) === 0xe000) {
          data[regD4(opcode)] = imm8(opcode);
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x2c00) {
          data[regD5(opcode)] = data[regR5(opcode)]!;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xff00) === 0x0100) {
          const d = ((opcode >> 4) & 0x0f) << 1;
          const r = (opcode & 0x0f) << 1;
          data[d] = data[r]!;
          data[d + 1] = data[r + 1]!;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x1800 && this.tryRunFastBlock(pc, opcode, target)) {
          continue;
        }
        else if ((opcode & 0xfc00) === 0x1800) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const result = (dv - rv) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (dv < rv ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x0800) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
          const prevZ = (data[SREG_ADDR]! & SREG_Z) !== 0;
          const result = (dv - rv - carry) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 && prevZ ? SREG_Z : 0) |
            (dv - rv - carry < 0 ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xf000) === 0x5000) {
          const d = regD4(opcode);
          const dv = data[d]!;
          const rv = imm8(opcode);
          const result = (dv - rv) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (dv < rv ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xf000) === 0x4000) {
          const d = regD4(opcode);
          const dv = data[d]!;
          const rv = imm8(opcode);
          const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
          const prevZ = (data[SREG_ADDR]! & SREG_Z) !== 0;
          const result = (dv - rv - carry) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 && prevZ ? SREG_Z : 0) |
            (dv - rv - carry < 0 ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x1400) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const result = (dv - rv) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (dv < rv ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x0400) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
          const prevZ = (data[SREG_ADDR]! & SREG_Z) !== 0;
          const result = (dv - rv - carry) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 && prevZ ? SREG_Z : 0) |
            (dv - rv - carry < 0 ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xf000) === 0x3000) {
          const d = regD4(opcode);
          const dv = data[d]!;
          const rv = imm8(opcode);
          const result = (dv - rv) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (dv < rv ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x0c00 && this.tryRunFastBlock(pc, opcode, target)) {
          continue;
        }
        else if ((opcode & 0xfe0f) === 0x9406 && this.tryRunFastBlock(pc, opcode, target)) {
          continue;
        }
        else if ((opcode & 0xfe0f) === 0x940a) {
          const d = regD5(opcode);
          const result = (data[d]! - 1) & 0xff;
          data[d] = result;
          const v = result === 0x7f;
          const n = (result & 0x80) !== 0;
          const flags =
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) | flags;
          this.pc += 1;
          this.cycles += 1;
        }
        else if (opcode === 0x1f66 && this.tryRunFastBlock(pc, opcode, target)) {
          continue;
        }
        else if (opcode === 0x9fa2 && this.tryRunFastBlock(pc, opcode, target)) {
          continue;
        }
        else if ((opcode & 0xfc00) === 0x0c00) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const sum = dv + rv;
          const result = sum & 0xff;
          const n = (result & 0x80) !== 0;
          const v = (~(dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) + (rv & 0x0f) > 0x0f ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (sum > 0xff ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x1c00) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
          const sum = dv + rv + carry;
          const result = sum & 0xff;
          const n = (result & 0x80) !== 0;
          const v = (~(dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) + (rv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (sum > 0xff ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xff00) === 0x9600) {
          const d = 24 + (((opcode >> 4) & 0x03) * 2);
          const k = (opcode & 0x0f) | ((opcode >> 2) & 0x30);
          const before = data[d]! | (data[d + 1]! << 8);
          const full = before + k;
          const result = full & 0xffff;
          data[d] = result & 0xff;
          data[d + 1] = (result >> 8) & 0xff;
          const n = (result & 0x8000) !== 0;
          const v = (~before & result & 0x8000) !== 0;
          const flags =
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (full > 0xffff ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_WORD_MASK) | flags;
          this.pc += 1;
          this.cycles += 2;
        }
        else if (opcode === 0xb73f && this.tryRunFastBlock(pc, opcode, target)) {
          continue;
        }
        else if ((opcode & 0xfe0f) === 0x920f) {
          this.pushByte(data[regD5(opcode)]!);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x900f) {
          data[regD5(opcode)] = this.popByte();
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0e) === 0x940e) {
          this.pushWord(pc + 2);
          const high = ((opcode & 0x01f0) >> 3) | (opcode & 0x0001);
          this.pc = (high << 16) | flash[pc + 1]!;
          this.cycles += 4;
        }
        else if (opcode === 0x9508) {
          this.pc = this.popWord();
          this.cycles += 4;
        }
        else if ((opcode & 0xfe0f) === 0x900c) {
          const d = regD5(opcode);
          const addr = data[26]! | (data[27]! << 8);
          data[d] = this.readData(addr);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x900d) {
          const d = regD5(opcode);
          const addr = data[26]! | (data[27]! << 8);
          data[d] = this.readData(addr);
          const next = (addr + 1) & 0xffff;
          data[26] = next & 0xff;
          data[27] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x900e) {
          const d = regD5(opcode);
          const addr = ((data[26]! | (data[27]! << 8)) - 1) & 0xffff;
          data[26] = addr & 0xff;
          data[27] = (addr >> 8) & 0xff;
          data[d] = this.readData(addr);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9009) {
          const d = regD5(opcode);
          const addr = data[28]! | (data[29]! << 8);
          data[d] = this.readData(addr);
          const next = (addr + 1) & 0xffff;
          data[28] = next & 0xff;
          data[29] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x900a) {
          const d = regD5(opcode);
          const addr = ((data[28]! | (data[29]! << 8)) - 1) & 0xffff;
          data[28] = addr & 0xff;
          data[29] = (addr >> 8) & 0xff;
          data[d] = this.readData(addr);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9001) {
          const d = regD5(opcode);
          const addr = data[30]! | (data[31]! << 8);
          data[d] = this.readData(addr);
          const next = (addr + 1) & 0xffff;
          data[30] = next & 0xff;
          data[31] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9002) {
          const d = regD5(opcode);
          const addr = ((data[30]! | (data[31]! << 8)) - 1) & 0xffff;
          data[30] = addr & 0xff;
          data[31] = (addr >> 8) & 0xff;
          data[d] = this.readData(addr);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x920c) {
          const r = regD5(opcode);
          const addr = data[26]! | (data[27]! << 8);
          this.writeData(addr, data[r]!);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x920d) {
          const r = regD5(opcode);
          const addr = data[26]! | (data[27]! << 8);
          this.writeData(addr, data[r]!);
          const next = (addr + 1) & 0xffff;
          data[26] = next & 0xff;
          data[27] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x920e) {
          const r = regD5(opcode);
          const addr = ((data[26]! | (data[27]! << 8)) - 1) & 0xffff;
          data[26] = addr & 0xff;
          data[27] = (addr >> 8) & 0xff;
          this.writeData(addr, data[r]!);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9209) {
          const r = regD5(opcode);
          const addr = data[28]! | (data[29]! << 8);
          this.writeData(addr, data[r]!);
          const next = (addr + 1) & 0xffff;
          data[28] = next & 0xff;
          data[29] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x920a) {
          const r = regD5(opcode);
          const addr = ((data[28]! | (data[29]! << 8)) - 1) & 0xffff;
          data[28] = addr & 0xff;
          data[29] = (addr >> 8) & 0xff;
          this.writeData(addr, data[r]!);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9201) {
          const r = regD5(opcode);
          const addr = data[30]! | (data[31]! << 8);
          this.writeData(addr, data[r]!);
          const next = (addr + 1) & 0xffff;
          data[30] = next & 0xff;
          data[31] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9202) {
          const r = regD5(opcode);
          const addr = ((data[30]! | (data[31]! << 8)) - 1) & 0xffff;
          data[30] = addr & 0xff;
          data[31] = (addr >> 8) & 0xff;
          this.writeData(addr, data[r]!);
          this.pc += 1;
          this.cycles += 2;
        }
        else if (opcode === 0x95c8) {
          const ld = 0;
          const z = data[30]! | (data[31]! << 8);
          const word = flash[z >> 1]!;
          data[ld] = z & 1 ? (word >> 8) & 0xff : word & 0xff;
          this.pc += 1;
          this.cycles += 3;
        }
        else if ((opcode & 0xfe0f) === 0x9004) {
          const ld = regD5(opcode);
          const z = data[30]! | (data[31]! << 8);
          const word = flash[z >> 1]!;
          data[ld] = z & 1 ? (word >> 8) & 0xff : word & 0xff;
          this.pc += 1;
          this.cycles += 3;
        }
        else if ((opcode & 0xfe0f) === 0x9005) {
          const ld = regD5(opcode);
          const z = data[30]! | (data[31]! << 8);
          const word = flash[z >> 1]!;
          data[ld] = z & 1 ? (word >> 8) & 0xff : word & 0xff;
          const next = (z + 1) & 0xffff;
          data[30] = next & 0xff;
          data[31] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 3;
        }
        else {
          let handler = decodeCache[pc];
          if (handler === undefined) {
            handler = executor.handlerFor(opcode);
            if (handler === undefined) {
              executor.execute(this, opcode);
              this.serviceInterrupts();
              continue;
            }
            decodeCache[pc] = handler;
          }
          handler(this, opcode);
        }
        this.serviceInterrupts();
      }
      if (
        this.breakpoints.size !== 0 ||
        this.traceListeners.length !== 0 ||
        this.pauseOnUnknownOpcode
      ) {
        this.runTicksUntil(target);
        return;
      }
    }
  }
  // END GENERATED FAST CORE

  private runTicksUntil(target: number): void {
    while (this._cycles < target) {
      this.tick();
      if (this._breakpointHit) return;
      if (this._error !== null) return;
    }
  }

  // BEGIN GENERATED FAST PROFILED
  private runFastProfiled(target: number, listener: ProfileRunListener): void {
    const executor = this.executor;
    if (!executor) {
      throw new Error("CPU has no executor - call setExecutor(new Decoder()) first.");
    }
    const flash = this.flash;
    const data = this.data;
    const decodeCache = this.decodeCache;
    while (this._cycles < target) {
      if (this.sleeping) {
        const pc = this.pc;
        const opcode = flash[pc]!;
        const before = this._cycles;
        this.tick();
        listener(this.profileState(pc, opcode, before, "sleep"));
      } else {
        const pc = this.pc;
        const opcode = flash[pc]!;
        const before = this._cycles;
        if ((opcode & 0xffcf) === 0x9700 && this.tryRunFastBlock(pc, opcode, target)) {
          this.profileFastBlock(listener, pc, opcode, before);
          continue;
        }
        else if (opcode === 0x0000) {
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xf000) === 0xc000) {
          const k = opcode & 0x0fff;
          if (k === 0x0fff && this.tryRunFastBlock(pc, opcode, target)) {
            this.profileFastBlock(listener, pc, opcode, before);
            continue;
          }
          this.pc += (k >= 0x800 ? k - 0x1000 : k) + 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfc00) === 0xf000) {
          if ((data[SREG_ADDR]! & (1 << (opcode & 0x07))) !== 0) {
            const k = (opcode >> 3) & 0x7f;
            this.pc += (k >= 0x40 ? k - 0x80 : k) + 1;
            this.cycles += 2;
          } else {
            this.pc += 1;
            this.cycles += 1;
          }
        }
        else if ((opcode & 0xfc00) === 0xf400) {
          if ((data[SREG_ADDR]! & (1 << (opcode & 0x07))) === 0) {
            const k = (opcode >> 3) & 0x7f;
            this.pc += (k >= 0x40 ? k - 0x80 : k) + 1;
            this.cycles += 2;
          } else {
            this.pc += 1;
            this.cycles += 1;
          }
        }
        else if ((opcode & 0xff00) === 0x9700) {
          const d = 24 + (((opcode >> 4) & 0x03) * 2);
          const k = (opcode & 0x0f) | ((opcode >> 2) & 0x30);
          const before = data[d]! | (data[d + 1]! << 8);
          const result = (before - k) & 0xffff;
          data[d] = result & 0xff;
          data[d + 1] = (result >> 8) & 0xff;
          const n = (result & 0x8000) !== 0;
          const v = (before & ~result & 0x8000) !== 0;
          const flags =
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (before < k ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_WORD_MASK) | flags;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xf000) === 0xe000) {
          data[regD4(opcode)] = imm8(opcode);
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x2c00) {
          data[regD5(opcode)] = data[regR5(opcode)]!;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xff00) === 0x0100) {
          const d = ((opcode >> 4) & 0x0f) << 1;
          const r = (opcode & 0x0f) << 1;
          data[d] = data[r]!;
          data[d + 1] = data[r + 1]!;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x1800 && this.tryRunFastBlock(pc, opcode, target)) {
          this.profileFastBlock(listener, pc, opcode, before);
          continue;
        }
        else if ((opcode & 0xfc00) === 0x1800) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const result = (dv - rv) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (dv < rv ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x0800) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
          const prevZ = (data[SREG_ADDR]! & SREG_Z) !== 0;
          const result = (dv - rv - carry) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 && prevZ ? SREG_Z : 0) |
            (dv - rv - carry < 0 ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xf000) === 0x5000) {
          const d = regD4(opcode);
          const dv = data[d]!;
          const rv = imm8(opcode);
          const result = (dv - rv) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (dv < rv ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xf000) === 0x4000) {
          const d = regD4(opcode);
          const dv = data[d]!;
          const rv = imm8(opcode);
          const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
          const prevZ = (data[SREG_ADDR]! & SREG_Z) !== 0;
          const result = (dv - rv - carry) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 && prevZ ? SREG_Z : 0) |
            (dv - rv - carry < 0 ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x1400) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const result = (dv - rv) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (dv < rv ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x0400) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
          const prevZ = (data[SREG_ADDR]! & SREG_Z) !== 0;
          const result = (dv - rv - carry) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 && prevZ ? SREG_Z : 0) |
            (dv - rv - carry < 0 ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xf000) === 0x3000) {
          const d = regD4(opcode);
          const dv = data[d]!;
          const rv = imm8(opcode);
          const result = (dv - rv) & 0xff;
          const n = (result & 0x80) !== 0;
          const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (dv < rv ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x0c00 && this.tryRunFastBlock(pc, opcode, target)) {
          this.profileFastBlock(listener, pc, opcode, before);
          continue;
        }
        else if ((opcode & 0xfe0f) === 0x9406 && this.tryRunFastBlock(pc, opcode, target)) {
          this.profileFastBlock(listener, pc, opcode, before);
          continue;
        }
        else if ((opcode & 0xfe0f) === 0x940a) {
          const d = regD5(opcode);
          const result = (data[d]! - 1) & 0xff;
          data[d] = result;
          const v = result === 0x7f;
          const n = (result & 0x80) !== 0;
          const flags =
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) | flags;
          this.pc += 1;
          this.cycles += 1;
        }
        else if (opcode === 0x1f66 && this.tryRunFastBlock(pc, opcode, target)) {
          this.profileFastBlock(listener, pc, opcode, before);
          continue;
        }
        else if (opcode === 0x9fa2 && this.tryRunFastBlock(pc, opcode, target)) {
          this.profileFastBlock(listener, pc, opcode, before);
          continue;
        }
        else if ((opcode & 0xfc00) === 0x0c00) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const sum = dv + rv;
          const result = sum & 0xff;
          const n = (result & 0x80) !== 0;
          const v = (~(dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) + (rv & 0x0f) > 0x0f ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (sum > 0xff ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xfc00) === 0x1c00) {
          const d = regD5(opcode);
          const dv = data[d]!;
          const rv = data[regR5(opcode)]!;
          const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
          const sum = dv + rv + carry;
          const result = sum & 0xff;
          const n = (result & 0x80) !== 0;
          const v = (~(dv ^ rv) & (dv ^ result) & 0x80) !== 0;
          const flags =
            ((dv & 0x0f) + (rv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (sum > 0xff ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
          data[d] = result;
          this.pc += 1;
          this.cycles += 1;
        }
        else if ((opcode & 0xff00) === 0x9600) {
          const d = 24 + (((opcode >> 4) & 0x03) * 2);
          const k = (opcode & 0x0f) | ((opcode >> 2) & 0x30);
          const before = data[d]! | (data[d + 1]! << 8);
          const full = before + k;
          const result = full & 0xffff;
          data[d] = result & 0xff;
          data[d + 1] = (result >> 8) & 0xff;
          const n = (result & 0x8000) !== 0;
          const v = (~before & result & 0x8000) !== 0;
          const flags =
            (v ? SREG_V : 0) |
            (n ? SREG_N : 0) |
            (result === 0 ? SREG_Z : 0) |
            (full > 0xffff ? SREG_C : 0) |
            (n !== v ? SREG_S : 0);
          data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_WORD_MASK) | flags;
          this.pc += 1;
          this.cycles += 2;
        }
        else if (opcode === 0xb73f && this.tryRunFastBlock(pc, opcode, target)) {
          this.profileFastBlock(listener, pc, opcode, before);
          continue;
        }
        else if ((opcode & 0xfe0f) === 0x920f) {
          this.pushByte(data[regD5(opcode)]!);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x900f) {
          data[regD5(opcode)] = this.popByte();
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0e) === 0x940e) {
          this.pushWord(pc + 2);
          const high = ((opcode & 0x01f0) >> 3) | (opcode & 0x0001);
          this.pc = (high << 16) | flash[pc + 1]!;
          this.cycles += 4;
        }
        else if (opcode === 0x9508) {
          this.pc = this.popWord();
          this.cycles += 4;
        }
        else if ((opcode & 0xfe0f) === 0x900c) {
          const d = regD5(opcode);
          const addr = data[26]! | (data[27]! << 8);
          data[d] = this.readData(addr);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x900d) {
          const d = regD5(opcode);
          const addr = data[26]! | (data[27]! << 8);
          data[d] = this.readData(addr);
          const next = (addr + 1) & 0xffff;
          data[26] = next & 0xff;
          data[27] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x900e) {
          const d = regD5(opcode);
          const addr = ((data[26]! | (data[27]! << 8)) - 1) & 0xffff;
          data[26] = addr & 0xff;
          data[27] = (addr >> 8) & 0xff;
          data[d] = this.readData(addr);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9009) {
          const d = regD5(opcode);
          const addr = data[28]! | (data[29]! << 8);
          data[d] = this.readData(addr);
          const next = (addr + 1) & 0xffff;
          data[28] = next & 0xff;
          data[29] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x900a) {
          const d = regD5(opcode);
          const addr = ((data[28]! | (data[29]! << 8)) - 1) & 0xffff;
          data[28] = addr & 0xff;
          data[29] = (addr >> 8) & 0xff;
          data[d] = this.readData(addr);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9001) {
          const d = regD5(opcode);
          const addr = data[30]! | (data[31]! << 8);
          data[d] = this.readData(addr);
          const next = (addr + 1) & 0xffff;
          data[30] = next & 0xff;
          data[31] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9002) {
          const d = regD5(opcode);
          const addr = ((data[30]! | (data[31]! << 8)) - 1) & 0xffff;
          data[30] = addr & 0xff;
          data[31] = (addr >> 8) & 0xff;
          data[d] = this.readData(addr);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x920c) {
          const r = regD5(opcode);
          const addr = data[26]! | (data[27]! << 8);
          this.writeData(addr, data[r]!);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x920d) {
          const r = regD5(opcode);
          const addr = data[26]! | (data[27]! << 8);
          this.writeData(addr, data[r]!);
          const next = (addr + 1) & 0xffff;
          data[26] = next & 0xff;
          data[27] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x920e) {
          const r = regD5(opcode);
          const addr = ((data[26]! | (data[27]! << 8)) - 1) & 0xffff;
          data[26] = addr & 0xff;
          data[27] = (addr >> 8) & 0xff;
          this.writeData(addr, data[r]!);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9209) {
          const r = regD5(opcode);
          const addr = data[28]! | (data[29]! << 8);
          this.writeData(addr, data[r]!);
          const next = (addr + 1) & 0xffff;
          data[28] = next & 0xff;
          data[29] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x920a) {
          const r = regD5(opcode);
          const addr = ((data[28]! | (data[29]! << 8)) - 1) & 0xffff;
          data[28] = addr & 0xff;
          data[29] = (addr >> 8) & 0xff;
          this.writeData(addr, data[r]!);
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9201) {
          const r = regD5(opcode);
          const addr = data[30]! | (data[31]! << 8);
          this.writeData(addr, data[r]!);
          const next = (addr + 1) & 0xffff;
          data[30] = next & 0xff;
          data[31] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 2;
        }
        else if ((opcode & 0xfe0f) === 0x9202) {
          const r = regD5(opcode);
          const addr = ((data[30]! | (data[31]! << 8)) - 1) & 0xffff;
          data[30] = addr & 0xff;
          data[31] = (addr >> 8) & 0xff;
          this.writeData(addr, data[r]!);
          this.pc += 1;
          this.cycles += 2;
        }
        else if (opcode === 0x95c8) {
          const ld = 0;
          const z = data[30]! | (data[31]! << 8);
          const word = flash[z >> 1]!;
          data[ld] = z & 1 ? (word >> 8) & 0xff : word & 0xff;
          this.pc += 1;
          this.cycles += 3;
        }
        else if ((opcode & 0xfe0f) === 0x9004) {
          const ld = regD5(opcode);
          const z = data[30]! | (data[31]! << 8);
          const word = flash[z >> 1]!;
          data[ld] = z & 1 ? (word >> 8) & 0xff : word & 0xff;
          this.pc += 1;
          this.cycles += 3;
        }
        else if ((opcode & 0xfe0f) === 0x9005) {
          const ld = regD5(opcode);
          const z = data[30]! | (data[31]! << 8);
          const word = flash[z >> 1]!;
          data[ld] = z & 1 ? (word >> 8) & 0xff : word & 0xff;
          const next = (z + 1) & 0xffff;
          data[30] = next & 0xff;
          data[31] = (next >> 8) & 0xff;
          this.pc += 1;
          this.cycles += 3;
        }
        else {
          let handler = decodeCache[pc];
          if (handler === undefined) {
            handler = executor.handlerFor(opcode);
            if (handler === undefined) {
              executor.execute(this, opcode);
              this.serviceInterrupts();
              listener(this.profileState(pc, opcode, before, "instruction"));
              continue;
            }
            decodeCache[pc] = handler;
          }
          handler(this, opcode);
        }
        this.serviceInterrupts();
        listener(this.profileState(pc, opcode, before, "instruction"));
      }
      if (
        this.breakpoints.size !== 0 ||
        this.traceListeners.length !== 0 ||
        this.pauseOnUnknownOpcode
      ) {
        this.runProfiledTicks(target, listener);
        return;
      }
    }
  }
  // END GENERATED FAST PROFILED

  private profileFastBlock(
    listener: ProfileRunListener,
    pc: number,
    opcode: number,
    before: number,
  ): void {
    listener(
      this.profileState(
        pc,
        opcode,
        before,
        "fast-block",
        this.fastBlockProfileKind(this.fastBlockCache[pc] ?? FAST_BLOCK_NONE),
      ),
    );
  }

  private profileState(
    pc: number,
    opcode: number,
    beforeCycles: number,
    kind: ProfileRunState["kind"],
    blockKind?: ProfileRunState["blockKind"],
  ): ProfileRunState {
    const state: ProfileRunState = {
      pc,
      opcode,
      mnemonic: this.executor?.mnemonicOf(opcode) ?? "???",
      cycles: this.cycles,
      elapsedCycles: this._cycles - beforeCycles,
      kind,
    };
    if (blockKind !== undefined) state.blockKind = blockKind;
    return state;
  }

  private fastBlockProfileKind(kind: number): ProfileRunState["blockKind"] {
    return FAST_BLOCK_PROFILE_KINDS[kind];
  }

  private tryRunFastBlock(pc: number, opcode: number, target: number): boolean {
    let kind = this.fastBlockCache[pc] ?? FAST_BLOCK_UNKNOWN;
    if (kind === FAST_BLOCK_UNKNOWN) {
      kind = this.classifyFastBlock(pc, opcode);
      this.fastBlockCache[pc] = kind;
    }

    switch (kind) {
      case FAST_BLOCK_RJMP_SELF:
        return this.runRjmpSelfLoopBlock(pc, target);
      case FAST_BLOCK_ZERO_SBIW_BREQ:
        return this.runZeroSbiwBreqLoopBlock(pc, opcode, target);
      case FAST_BLOCK_SHIFT_LEFT_DEC:
        return this.runShiftLeftDecLoopBlock(pc, opcode, target);
      case FAST_BLOCK_SHIFT_RIGHT_DEC:
        return this.runShiftRightDecLoopBlock(pc, opcode, target);
      case FAST_BLOCK_ARDUINO_MICROS:
        return this.runArduinoMicrosBlock(pc, target);
      case FAST_BLOCK_SUBCMP_RUN:
        return this.runSubCmpRunBlock(pc, target);
      case FAST_BLOCK_UDIVMODSI4_LOOP:
        if (CPU.udivmodsi4RegionMode === "generated-cfg") {
          return this.runGeneratedUdivmodsi4CfgBlock(pc, target);
        }
        return this.runUdivmodsi4LoopBlock(pc, target);
      case FAST_BLOCK_UMULHISI3:
        return this.runUmulhisi3Block(pc, target);
      default:
        return false;
    }
  }

  private classifyFastBlock(pc: number, opcode: number): number {
    if (opcode === 0xcfff) return FAST_BLOCK_RJMP_SELF;
    if ((opcode & 0xffcf) === 0x9700) {
      return this.flash[pc + 1] === 0xf3f1 ? FAST_BLOCK_ZERO_SBIW_BREQ : FAST_BLOCK_NONE;
    }
    if ((opcode & 0xfc00) === 0x0c00) {
      return this.isShiftLeftDecLoop(pc, opcode) ? FAST_BLOCK_SHIFT_LEFT_DEC : FAST_BLOCK_NONE;
    }
    if ((opcode & 0xfe0f) === 0x9406) {
      return this.isShiftRightDecLoop(pc, opcode) ? FAST_BLOCK_SHIFT_RIGHT_DEC : FAST_BLOCK_NONE;
    }
    if (opcode === 0xb73f) {
      return this.isArduinoMicrosBlock(pc) ? FAST_BLOCK_ARDUINO_MICROS : FAST_BLOCK_NONE;
    }
    if ((opcode & 0xfc00) === 0x1800) {
      return this.subCmpRunLength(pc) >= SUBCMP_RUN_MIN ? FAST_BLOCK_SUBCMP_RUN : FAST_BLOCK_NONE;
    }
    if (opcode === 0x1f66) {
      return this.isUdivmodsi4LoopBlock(pc) ? FAST_BLOCK_UDIVMODSI4_LOOP : FAST_BLOCK_NONE;
    }
    if (opcode === 0x9fa2) {
      return this.isUmulhisi3Block(pc) ? FAST_BLOCK_UMULHISI3 : FAST_BLOCK_NONE;
    }
    return FAST_BLOCK_NONE;
  }

  /**
   * avr-libc's 32-bit unsigned divide/modulo helper loop, entered at
   * `__udivmodsi4_ep` after setup jumps over the body. This exact register-only
   * shape dominates the realistic sensor-format fixture through Arduino's
   * decimal `Print::printNumber` path.
   */
  private isUdivmodsi4LoopBlock(pc: number): boolean {
    if (pc < 13) return false;
    const flash = this.flash;
    const body = pc - 13;
    const exact: Array<[number, number]> = [
      [body + 0, 0x1faa], // ADC r26,r26
      [body + 1, 0x1fbb], // ADC r27,r27
      [body + 2, 0x1fee], // ADC r30,r30
      [body + 3, 0x1fff], // ADC r31,r31
      [body + 4, 0x17a2], // CP r26,r18
      [body + 5, 0x07b3], // CPC r27,r19
      [body + 6, 0x07e4], // CPC r30,r20
      [body + 7, 0x07f5], // CPC r31,r21
      [body + 8, 0xf020], // BRCS +4, to ep
      [body + 9, 0x1ba2], // SUB r26,r18
      [body + 10, 0x0bb3], // SBC r27,r19
      [body + 11, 0x0be4], // SBC r30,r20
      [body + 12, 0x0bf5], // SBC r31,r21
      [pc + 0, 0x1f66], // ADC r22,r22
      [pc + 1, 0x1f77], // ADC r23,r23
      [pc + 2, 0x1f88], // ADC r24,r24
      [pc + 3, 0x1f99], // ADC r25,r25
      [pc + 4, 0x941a], // DEC r1
      [pc + 5, 0xf769], // BRNE -19, to body
    ];
    for (const [addr, opcode] of exact) {
      if (flash[addr] !== opcode) return false;
    }
    return true;
  }

  private runUdivmodsi4LoopBlock(pc: number, target: number): boolean {
    const loops = this.data[1] === 0 ? 256 : this.data[1]!;
    // Conservative upper bound: final ep is 6 cycles; each prior iteration can
    // take ep(7) + body(13). If an event lands in that window, decline.
    const maxCycles = 6 + (loops - 1) * 20;
    if (!this.canRunFastBlock(target, maxCycles)) return false;

    const data = this.data;
    let elapsed = 0;
    const adcSelf = (register: number): void => {
      const dv = data[register]!;
      const carry = (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
      const sum = dv + dv + carry;
      const result = sum & 0xff;
      const n = (result & 0x80) !== 0;
      const v = ((dv ^ result) & 0x80) !== 0;
      const flags =
        ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
        (v ? SREG_V : 0) |
        (n ? SREG_N : 0) |
        (result === 0 ? SREG_Z : 0) |
        (sum > 0xff ? SREG_C : 0) |
        (n !== v ? SREG_S : 0);
      data[SREG_ADDR] = (data[SREG_ADDR]! & ~SREG_ARITH_MASK) | flags;
      data[register] = result;
      elapsed += 1;
    };
    const subOp = (d: number, r: number, carryUsed: boolean, writeback: boolean): void => {
      const dv = data[d]!;
      const rv = data[r]!;
      const carry = carryUsed && (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
      const prev = data[SREG_ADDR]!;
      const result = (dv - rv - carry) & 0xff;
      const n = (result & 0x80) !== 0;
      const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
      const flags =
        ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
        (v ? SREG_V : 0) |
        (n ? SREG_N : 0) |
        ((carryUsed ? result === 0 && (prev & SREG_Z) !== 0 : result === 0) ? SREG_Z : 0) |
        (dv - rv - carry < 0 ? SREG_C : 0) |
        (n !== v ? SREG_S : 0);
      data[SREG_ADDR] = (prev & ~SREG_ARITH_MASK) | flags;
      if (writeback) data[d] = result;
      elapsed += 1;
    };

    while (true) {
      adcSelf(22);
      adcSelf(23);
      adcSelf(24);
      adcSelf(25);

      const dec = (data[1]! - 1) & 0xff;
      data[1] = dec;
      const n = (dec & 0x80) !== 0;
      const v = dec === 0x7f;
      data[SREG_ADDR] =
        (data[SREG_ADDR]! & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) |
        (v ? SREG_V : 0) |
        (n ? SREG_N : 0) |
        (dec === 0 ? SREG_Z : 0) |
        (n !== v ? SREG_S : 0);
      elapsed += 1;
      if (dec === 0) {
        elapsed += 1; // BRNE not taken
        break;
      }
      elapsed += 2; // BRNE taken

      adcSelf(26);
      adcSelf(27);
      adcSelf(30);
      adcSelf(31);
      subOp(26, 18, false, false);
      subOp(27, 19, true, false);
      subOp(30, 20, true, false);
      subOp(31, 21, true, false);

      if ((data[SREG_ADDR]! & SREG_C) !== 0) {
        elapsed += 2; // BRCS taken to ep
        continue;
      }
      elapsed += 1; // BRCS not taken
      subOp(26, 18, false, true);
      subOp(27, 19, true, true);
      subOp(30, 20, true, true);
      subOp(31, 21, true, true);
    }

    this._cycles += elapsed;
    this.pc = pc + 6;
    return true;
  }

  private runGeneratedUdivmodsi4CfgBlock(pc: number, target: number): boolean {
    const data = this.data;
    const loops = data[1] === 0 ? 256 : data[1]!;
    // Same guard contract as the handwritten block. This is the worst-case CFG
    // path: final ep is 6 cycles; each prior iteration can take ep(7)+body(13).
    const maxCycles = 6 + (loops - 1) * 20;
    if (!this.canRunFastBlock(target, maxCycles)) return false;

    let elapsed = 0;
    let sreg = data[SREG_ADDR]!;

    while (true) {
      // ep block: ADC r22,r22; ADC r23,r23; ADC r24,r24; ADC r25,r25
      {
        const dv = data[22]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const sum = dv + dv + carry;
        const result = sum & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 ? SREG_Z : 0) |
          (sum > 0xff ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[22] = result;
        elapsed += 1;
      }
      {
        const dv = data[23]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const sum = dv + dv + carry;
        const result = sum & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 ? SREG_Z : 0) |
          (sum > 0xff ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[23] = result;
        elapsed += 1;
      }
      {
        const dv = data[24]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const sum = dv + dv + carry;
        const result = sum & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 ? SREG_Z : 0) |
          (sum > 0xff ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[24] = result;
        elapsed += 1;
      }
      {
        const dv = data[25]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const sum = dv + dv + carry;
        const result = sum & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 ? SREG_Z : 0) |
          (sum > 0xff ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[25] = result;
        elapsed += 1;
      }

      const dec = (data[1]! - 1) & 0xff;
      data[1] = dec;
      const decN = (dec & 0x80) !== 0;
      const decV = dec === 0x7f;
      sreg =
        (sreg & ~(SREG_V | SREG_N | SREG_Z | SREG_S)) |
        (decV ? SREG_V : 0) |
        (decN ? SREG_N : 0) |
        (dec === 0 ? SREG_Z : 0) |
        (decN !== decV ? SREG_S : 0);
      elapsed += 1;
      if (dec === 0) {
        elapsed += 1; // BRNE not taken
        break;
      }
      elapsed += 2; // BRNE taken to body

      // body block: ADC x4; CP/CPC x4; BRCS; optional SUB/SBC x4
      {
        const dv = data[26]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const sum = dv + dv + carry;
        const result = sum & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 ? SREG_Z : 0) |
          (sum > 0xff ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[26] = result;
        elapsed += 1;
      }
      {
        const dv = data[27]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const sum = dv + dv + carry;
        const result = sum & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 ? SREG_Z : 0) |
          (sum > 0xff ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[27] = result;
        elapsed += 1;
      }
      {
        const dv = data[30]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const sum = dv + dv + carry;
        const result = sum & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 ? SREG_Z : 0) |
          (sum > 0xff ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[30] = result;
        elapsed += 1;
      }
      {
        const dv = data[31]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const sum = dv + dv + carry;
        const result = sum & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) + (dv & 0x0f) + carry > 0x0f ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 ? SREG_Z : 0) |
          (sum > 0xff ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[31] = result;
        elapsed += 1;
      }

      {
        const dv = data[26]!;
        const rv = data[18]!;
        const result = (dv - rv) & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 ? SREG_Z : 0) |
          (dv < rv ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        elapsed += 1;
      }
      {
        const dv = data[27]!;
        const rv = data[19]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const prevZ = (sreg & SREG_Z) !== 0;
        const result = (dv - rv - carry) & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 && prevZ ? SREG_Z : 0) |
          (dv - rv - carry < 0 ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        elapsed += 1;
      }
      {
        const dv = data[30]!;
        const rv = data[20]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const prevZ = (sreg & SREG_Z) !== 0;
        const result = (dv - rv - carry) & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 && prevZ ? SREG_Z : 0) |
          (dv - rv - carry < 0 ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        elapsed += 1;
      }
      {
        const dv = data[31]!;
        const rv = data[21]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const prevZ = (sreg & SREG_Z) !== 0;
        const result = (dv - rv - carry) & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 && prevZ ? SREG_Z : 0) |
          (dv - rv - carry < 0 ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        elapsed += 1;
      }

      if ((sreg & SREG_C) !== 0) {
        elapsed += 2; // BRCS taken to ep
        continue;
      }
      elapsed += 1; // BRCS not taken

      {
        const dv = data[26]!;
        const rv = data[18]!;
        const result = (dv - rv) & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) - (rv & 0x0f) < 0 ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 ? SREG_Z : 0) |
          (dv < rv ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[26] = result;
        elapsed += 1;
      }
      {
        const dv = data[27]!;
        const rv = data[19]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const prevZ = (sreg & SREG_Z) !== 0;
        const result = (dv - rv - carry) & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 && prevZ ? SREG_Z : 0) |
          (dv - rv - carry < 0 ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[27] = result;
        elapsed += 1;
      }
      {
        const dv = data[30]!;
        const rv = data[20]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const prevZ = (sreg & SREG_Z) !== 0;
        const result = (dv - rv - carry) & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 && prevZ ? SREG_Z : 0) |
          (dv - rv - carry < 0 ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[30] = result;
        elapsed += 1;
      }
      {
        const dv = data[31]!;
        const rv = data[21]!;
        const carry = (sreg & SREG_C) !== 0 ? 1 : 0;
        const prevZ = (sreg & SREG_Z) !== 0;
        const result = (dv - rv - carry) & 0xff;
        const n = (result & 0x80) !== 0;
        const v = ((dv ^ rv) & (dv ^ result) & 0x80) !== 0;
        const flags =
          ((dv & 0x0f) - (rv & 0x0f) - carry < 0 ? SREG_H : 0) |
          (v ? SREG_V : 0) |
          (n ? SREG_N : 0) |
          (result === 0 && prevZ ? SREG_Z : 0) |
          (dv - rv - carry < 0 ? SREG_C : 0) |
          (n !== v ? SREG_S : 0);
        sreg = (sreg & ~SREG_ARITH_MASK) | flags;
        data[31] = result;
        elapsed += 1;
      }
    }

    data[SREG_ADDR] = sreg;
    this._cycles += elapsed;
    this.pc = pc + 6;
    return true;
  }

  private isUmulhisi3Block(pc: number): boolean {
    const flash = this.flash;
    const exact: Array<[number, number]> = [
      [pc + 0, 0x9fa2], // MUL r26,r18
      [pc + 1, 0x01b0], // MOVW r22,r0
      [pc + 2, 0x9fb3], // MUL r27,r19
      [pc + 3, 0x01c0], // MOVW r24,r0
      [pc + 4, 0x9fa3], // MUL r26,r19
      [pc + 5, 0x0d70], // ADD r23,r0
      [pc + 6, 0x1d81], // ADC r24,r1
      [pc + 7, 0x2411], // EOR r1,r1
      [pc + 8, 0x1d91], // ADC r25,r1
      [pc + 9, 0x9fb2], // MUL r27,r18
      [pc + 10, 0x0d70], // ADD r23,r0
      [pc + 11, 0x1d81], // ADC r24,r1
      [pc + 12, 0x2411], // EOR r1,r1
      [pc + 13, 0x1d91], // ADC r25,r1
      [pc + 14, 0x9508], // RET
    ];
    for (const [addr, opcode] of exact) {
      if (flash[addr] !== opcode) return false;
    }
    return true;
  }

  private runUmulhisi3Block(pc: number, target: number): boolean {
    const blockCycles = 22;
    if (!this.canRunFastBlock(target, blockCycles)) return false;

    const data = this.data;
    const al = data[26]!;
    const ah = data[27]!;
    const bl = data[18]!;
    const bh = data[19]!;

    const p0 = al * bl;
    const p1 = ah * bh;
    const p2 = al * bh;
    const p3 = ah * bl;

    let r23 = (p0 >> 8) + (p2 & 0xff);
    let carry = r23 > 0xff ? 1 : 0;
    r23 &= 0xff;
    let r24 = (p1 & 0xff) + (p2 >> 8) + carry;
    carry = r24 > 0xff ? 1 : 0;
    r24 &= 0xff;
    let r25 = (p1 >> 8) + carry;

    r23 += p3 & 0xff;
    carry = r23 > 0xff ? 1 : 0;
    r23 &= 0xff;
    r24 += (p3 >> 8) + carry;
    carry = r24 > 0xff ? 1 : 0;
    r24 &= 0xff;

    const beforeFinal = r25 & 0xff;
    const finalSum = beforeFinal + carry;
    r25 = finalSum & 0xff;
    const n = (r25 & 0x80) !== 0;
    const v = (~beforeFinal & r25 & 0x80) !== 0;

    data[0] = p3 & 0xff;
    data[1] = 0;
    data[22] = p0 & 0xff;
    data[23] = r23;
    data[24] = r24;
    data[25] = r25;
    data[SREG_ADDR] =
      (data[SREG_ADDR]! & ~SREG_ARITH_MASK) |
      ((beforeFinal & 0x0f) + carry > 0x0f ? SREG_H : 0) |
      (v ? SREG_V : 0) |
      (n ? SREG_N : 0) |
      (r25 === 0 ? SREG_Z : 0) |
      (finalSum > 0xff ? SREG_C : 0) |
      (n !== v ? SREG_S : 0);

    this._cycles += blockCycles;
    this.pc = this.popWord();
    return true;
  }

  /** Decode the subtract/compare class for the straight-line block. */
  private subCmpKind(opcode: number): number {
    // Returns 0 if not in the class; otherwise a small descriptor encoding
    // immediate/carry/writeback. Mirrors the SUB/SBC/CP/CPC/SUBI/SBCI/CPI arms.
    const top = opcode & 0xfc00;
    if (top === 0x1800) return SUBCMP_SUB;
    if (top === 0x0800) return SUBCMP_SBC;
    if (top === 0x1400) return SUBCMP_CP;
    if (top === 0x0400) return SUBCMP_CPC;
    const topN = opcode & 0xf000;
    if (topN === 0x5000) return SUBCMP_SUBI;
    if (topN === 0x4000) return SUBCMP_SBCI;
    if (topN === 0x3000) return SUBCMP_CPI;
    return 0;
  }

  /** Count consecutive subtract/compare-class instructions starting at `pc`. */
  private subCmpRunLength(pc: number): number {
    let n = 0;
    const flash = this.flash;
    while (pc + n < flash.length && this.subCmpKind(flash[pc + n]!) !== 0) n += 1;
    return n;
  }

  /**
   * Step 4 straight-line block: a run of register/immediate subtract & compare
   * instructions (no memory, IO, or control flow) executed in one host dispatch
   * instead of one ladder traversal each. The Arduino `delay()` 64-bit elapsed
   * compare is the motivating shape (`SUB; SBC; SBC; SBC; CPI; SBCI; CPC; CPC`).
   * Flag math is the same `sub8` the handlers use, so it is provably identical.
   */
  private runSubCmpRunBlock(pc: number, target: number): boolean {
    const length = this.subCmpRunLength(pc);
    if (length < SUBCMP_RUN_MIN) return false;
    // Each instruction is one cycle; refuse to cross the target, a clock event,
    // a cycle listener, or an enabled pending interrupt (canRunFastBlock).
    if (!this.canRunFastBlock(target, length)) return false;

    const data = this.data;
    for (let i = 0; i < length; i += 1) {
      const opcode = this.flash[pc + i]!;
      const kind = this.subCmpKind(opcode);
      const immediate = kind === SUBCMP_SUBI || kind === SUBCMP_SBCI || kind === SUBCMP_CPI;
      const carryUsed = kind === SUBCMP_SBC || kind === SUBCMP_SBCI || kind === SUBCMP_CPC;
      const writeback = kind !== SUBCMP_CP && kind !== SUBCMP_CPC && kind !== SUBCMP_CPI;
      const d = immediate ? regD4(opcode) : regD5(opcode);
      const r = immediate ? imm8(opcode) : data[regR5(opcode)]!;
      const carryIn = carryUsed && (data[SREG_ADDR]! & SREG_C) !== 0 ? 1 : 0;
      const result = sub8(this, data[d]!, r, carryIn, carryUsed);
      if (writeback) data[d] = result;
    }
    this.pc = pc + length;
    this.cycles += length;
    return true;
  }

  /**
   * Bulk-skip the Arduino busy-wait shape that dominates serial-print and
   * analog-write: `SBIW pair,0; BREQ -2` while the pair is zero. This is a tiny
   * guarded block specialization, not a general instruction shortcut. It only
   * advances whole 4-cycle loop iterations and refuses to cross cycle listeners,
   * enabled pending interrupts, or the next scheduled clock event.
   */
  private runZeroSbiwBreqLoopBlock(pc: number, opcode: number, target: number): boolean {
    const d = 24 + (((opcode >> 4) & 0x03) * 2);
    if (this.data[d] !== 0 || this.data[d + 1] !== 0) return false;

    const iterations = this.bulkIdleLoopIterations(target, 4);
    if (iterations <= 1) return false;

    this.data[SREG_ADDR] = (this.data[SREG_ADDR]! & ~SREG_WORD_MASK) | SREG_Z;
    this._cycles += iterations * 4;
    this.pc = pc;
    return true;
  }

  /** Bulk-skip `RJMP -1` when nothing observable can happen before the target/event. */
  private runRjmpSelfLoopBlock(pc: number, target: number): boolean {
    const iterations = this.bulkIdleLoopIterations(target, 2);
    if (iterations <= 1) return false;

    this._cycles += iterations * 2;
    this.pc = pc;
    return true;
  }

  private bulkIdleLoopIterations(target: number, cyclesPerIteration: number): number {
    if (
      this.timing !== "fast" ||
      this.cycleListeners.length !== 0 ||
      (this.pendingInterrupts.length !== 0 && (this.data[SREG_ADDR]! & SREG_I) !== 0)
    ) {
      return 0;
    }

    let limit = target;
    const nextEvent = this.nextClockEvent;
    if (nextEvent !== undefined && nextEvent.cycles <= limit) limit = nextEvent.cycles - 1;
    return Math.floor((limit - this._cycles) / cyclesPerIteration);
  }

  /**
   * Fast block for the Arduino `delay()` helper's 32-bit left-shift loop:
   *   ADD rN,rN; ADC rN+1,rN+1; ADC rN+2,rN+2; ADC rN+3,rN+3; DEC rC; BRNE loop
   *
   * It is intentionally shape-checked at runtime and only runs the whole counted
   * loop when no event/interrupt/listener can observe the skipped instructions.
   */
  private isShiftLeftDecLoop(pc: number, opcode: number): boolean {
    const firstReg = regD5(opcode);
    if (regR5(opcode) !== firstReg || firstReg > 28) return false;

    const flash = this.flash;
    const op1 = flash[pc + 1]!;
    const op2 = flash[pc + 2]!;
    const op3 = flash[pc + 3]!;
    const dec = flash[pc + 4]!;
    const branch = flash[pc + 5]!;
    if (
      !this.isAdcSelf(op1, firstReg + 1) ||
      !this.isAdcSelf(op2, firstReg + 2) ||
      !this.isAdcSelf(op3, firstReg + 3) ||
      (dec & 0xfe0f) !== 0x940a ||
      (branch & 0xfc07) !== 0xf401 ||
      ((branch >> 3) & 0x7f) !== 0x7a
    ) {
      return false;
    }

    const counterReg = regD5(dec);
    if (counterReg >= firstReg && counterReg <= firstReg + 3) return false;
    return true;
  }

  private runShiftLeftDecLoopBlock(pc: number, opcode: number, target: number): boolean {
    const firstReg = regD5(opcode);
    const counterReg = regD5(this.flash[pc + 4]!);
    const loops = this.data[counterReg] === 0 ? 256 : this.data[counterReg]!;
    const blockCycles = loops * 7 - 1;
    if (!this.canRunFastBlock(target, blockCycles)) return false;

    const data = this.data;
    let carry = 0;
    let halfCarry = 0;
    for (let iteration = 0; iteration < loops; iteration += 1) {
      for (let offset = 0; offset < 4; offset += 1) {
        const addr = firstReg + offset;
        const before = data[addr]!;
        const carryIn = offset === 0 ? 0 : carry;
        const sum = before + before + carryIn;
        data[addr] = sum & 0xff;
        carry = sum > 0xff ? 1 : 0;
        if (offset === 3) {
          halfCarry = (before & 0x0f) + (before & 0x0f) + carryIn > 0x0f ? 1 : 0;
        }
      }
    }

    data[counterReg] = 0;
    data[SREG_ADDR] =
      (data[SREG_ADDR]! & (SREG_T | SREG_I)) |
      SREG_Z |
      (carry !== 0 ? SREG_C : 0) |
      (halfCarry !== 0 ? SREG_H : 0);
    this._cycles += blockCycles;
    this.pc = pc + 6;
    return true;
  }

  /**
   * Fast block for compiler-emitted 32-bit right-shift counted loops:
   *   LSR rN+3; ROR rN+2; ROR rN+1; ROR rN; DEC rC; BRNE loop
   */
  private isShiftRightDecLoop(pc: number, opcode: number): boolean {
    const highReg = regD5(opcode);
    if (highReg < 3) return false;

    const flash = this.flash;
    const op1 = flash[pc + 1]!;
    const op2 = flash[pc + 2]!;
    const op3 = flash[pc + 3]!;
    const dec = flash[pc + 4]!;
    const branch = flash[pc + 5]!;
    if (
      !this.isRor(op1, highReg - 1) ||
      !this.isRor(op2, highReg - 2) ||
      !this.isRor(op3, highReg - 3) ||
      (dec & 0xfe0f) !== 0x940a ||
      (branch & 0xfc07) !== 0xf401 ||
      ((branch >> 3) & 0x7f) !== 0x7a
    ) {
      return false;
    }

    const counterReg = regD5(dec);
    return counterReg < highReg - 3 || counterReg > highReg;
  }

  private isRor(opcode: number, register: number): boolean {
    return (opcode & 0xfe0f) === 0x9407 && regD5(opcode) === register;
  }

  private runShiftRightDecLoopBlock(pc: number, opcode: number, target: number): boolean {
    const highReg = regD5(opcode);
    const lowReg = highReg - 3;
    const counterReg = regD5(this.flash[pc + 4]!);
    const loops = this.data[counterReg] === 0 ? 256 : this.data[counterReg]!;
    const blockCycles = loops * 7 - 1;
    if (!this.canRunFastBlock(target, blockCycles)) return false;

    const data = this.data;
    const value =
      (data[lowReg]! |
        (data[lowReg + 1]! << 8) |
        (data[lowReg + 2]! << 16) |
        (data[highReg]! << 24)) >>> 0;
    const shifted = loops < 32 ? value >>> loops : 0;
    const carry = loops <= 32 ? (value >>> (loops - 1)) & 1 : 0;
    data[lowReg] = shifted & 0xff;
    data[lowReg + 1] = (shifted >>> 8) & 0xff;
    data[lowReg + 2] = (shifted >>> 16) & 0xff;
    data[highReg] = (shifted >>> 24) & 0xff;
    data[counterReg] = 0;
    data[SREG_ADDR] = (data[SREG_ADDR]! & (SREG_H | SREG_T | SREG_I)) | SREG_Z | (carry !== 0 ? SREG_C : 0);
    this._cycles += blockCycles;
    this.pc = pc + 6;
    return true;
  }

  private isArduinoMicrosBlock(pc: number): boolean {
    const flash = this.flash;
    const exact: Array<[number, number]> = [
      [0, 0xb73f], // IN r19,SREG
      [1, 0x94f8], // CLI
      [2, 0x9180], // LDS r24, timer0_overflow_count + 0
      [4, 0x9190], // LDS r25, timer0_overflow_count + 1
      [6, 0x91a0], // LDS r26, timer0_overflow_count + 2
      [8, 0x91b0], // LDS r27, timer0_overflow_count + 3
      [10, 0xb526], // IN r18,TCNT0
      [11, 0x9ba8], // SBIS TIFR0,TOV0
      [12, 0xc005], // RJMP over overflow increment
      [13, 0x3f2f], // CPI r18,255
      [14, 0xf019], // BREQ over overflow increment
      [15, 0x9601], // ADIW r24,1
      [16, 0x1da1], // ADC r26,r1
      [17, 0x1db1], // ADC r27,r1
      [18, 0xbf3f], // OUT SREG,r19
      [19, 0x2fba],
      [20, 0x2fa9],
      [21, 0x2f98],
      [22, 0x2788],
      [23, 0x01bc],
      [24, 0x01cd],
      [25, 0x0f62],
      [26, 0x1d71],
      [27, 0x1d81],
      [28, 0x1d91],
      [29, 0xe042],
      [30, 0x0f66],
      [31, 0x1f77],
      [32, 0x1f88],
      [33, 0x1f99],
      [34, 0x954a],
      [35, 0xf7d1],
      [36, 0x9508], // RET
    ];
    for (const [offset, opcode] of exact) {
      if (flash[pc + offset] !== opcode) return false;
    }

    const addr = flash[pc + 3]!;
    return (
      addr + 3 < this.data.length &&
      flash[pc + 5] === addr + 1 &&
      flash[pc + 7] === addr + 2 &&
      flash[pc + 9] === addr + 3
    );
  }

  private runArduinoMicrosBlock(pc: number, target: number): boolean {
    if (this.data[1] !== 0 || !this.canRunFastBlock(target, 48)) return false;

    const startCycles = this._cycles;
    const data = this.data;
    const flash = this.flash;
    const overflowAddr = flash[pc + 3]!;

    const savedSreg = this.readIo(0x3f);
    data[19] = savedSreg;
    data[SREG_ADDR] = savedSreg & ~SREG_I;

    this._cycles = startCycles + 2;
    let micros = this.readData(overflowAddr);
    data[24] = micros & 0xff;
    this._cycles = startCycles + 4;
    micros |= this.readData(overflowAddr + 1) << 8;
    data[25] = (micros >> 8) & 0xff;
    this._cycles = startCycles + 6;
    micros |= this.readData(overflowAddr + 2) << 16;
    data[26] = (micros >> 16) & 0xff;
    this._cycles = startCycles + 8;
    micros = (micros | (this.readData(overflowAddr + 3) << 24)) >>> 0;
    data[27] = (micros >>> 24) & 0xff;

    this._cycles = startCycles + 10;
    const tcnt0 = this.readIo(0x26);
    data[18] = tcnt0;
    this._cycles = startCycles + 11;
    const overflowPending = (this.readIo(0x15) & 1) !== 0;

    let blockCycles = 43;
    if (overflowPending) {
      if (tcnt0 === 0xff) {
        blockCycles = 45;
      } else {
        micros = (micros + 1) >>> 0;
        blockCycles = 48;
      }
    }

    data[24] = micros & 0xff;
    data[25] = (micros >>> 8) & 0xff;
    data[26] = (micros >>> 16) & 0xff;
    data[27] = (micros >>> 24) & 0xff;

    this._cycles = startCycles + blockCycles - 29;
    this.writeIo(0x3f, savedSreg);

    data[27] = (micros >>> 16) & 0xff;
    data[26] = (micros >>> 8) & 0xff;
    data[25] = micros & 0xff;
    data[24] = 0;

    const combined = (((micros << 8) >>> 0) + tcnt0) >>> 0;
    data[22] = combined & 0xff;
    data[23] = (combined >>> 8) & 0xff;
    data[24] = (combined >>> 16) & 0xff;
    data[25] = (combined >>> 24) & 0xff;
    data[20] = 2;

    let carry = 0;
    let halfCarry = 0;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      for (let offset = 0; offset < 4; offset += 1) {
        const addr = 22 + offset;
        const before = data[addr]!;
        const carryIn = offset === 0 ? 0 : carry;
        const sum = before + before + carryIn;
        data[addr] = sum & 0xff;
        carry = sum > 0xff ? 1 : 0;
        if (offset === 3) {
          halfCarry = (before & 0x0f) + (before & 0x0f) + carryIn > 0x0f ? 1 : 0;
        }
      }
      data[20] = (data[20]! - 1) & 0xff;
    }

    data[SREG_ADDR] =
      (data[SREG_ADDR]! & (SREG_T | SREG_I)) |
      SREG_Z |
      (carry !== 0 ? SREG_C : 0) |
      (halfCarry !== 0 ? SREG_H : 0);
    this._cycles = startCycles + blockCycles;
    this.pc = this.popWord();
    return true;
  }

  private isAdcSelf(opcode: number, register: number): boolean {
    return (
      (opcode & 0xfc00) === 0x1c00 &&
      regD5(opcode) === register &&
      regR5(opcode) === register
    );
  }

  private canRunFastBlock(target: number, blockCycles: number): boolean {
    if (
      this.timing !== "fast" ||
      this.cycleListeners.length !== 0 ||
      (this.pendingInterrupts.length !== 0 && (this.data[SREG_ADDR]! & SREG_I) !== 0)
    ) {
      return false;
    }
    const finalCycles = this._cycles + blockCycles;
    if (finalCycles > target) return false;
    const nextEvent = this.nextClockEvent;
    return nextEvent === undefined || nextEvent.cycles > finalCycles;
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
    if (this.cycleListenerDispatchDepth > 0) {
      const depth = this.cycleListenerDispatchDepth;
      const existingDepth = this.pendingCycleListenerRemovalDepths.get(listener);
      if (existingDepth === undefined) {
        this.pendingCycleListenerRemovals.push(listener);
        this.pendingCycleListenerRemovalDepths.set(listener, depth);
      } else if (depth < existingDepth) {
        this.pendingCycleListenerRemovalDepths.set(listener, depth);
      }
      return;
    }
    this.spliceCycleListener(listener);
  }

  private spliceCycleListener(listener: CycleListener): void {
    const index = this.cycleListeners.indexOf(listener);
    if (index >= 0) this.cycleListeners.splice(index, 1);
  }

  /** Fire cycle listeners for `elapsed` consumed cycles (peripherals advance time). */
  private notifyCycles(elapsed: number): void {
    if (elapsed <= 0) return;
    const listeners = this.cycleListeners;
    const count = listeners.length;
    if (count === 0) return;

    // Hot path: a top-level notification with no removals pending — the case on
    // essentially every instruction, since cycle listeners are wired once and
    // almost never unsubscribe mid-run. This skips the deferred-removal
    // bookkeeping (a per-call Map.clear() + array drain + the removalDepths
    // lookups) that otherwise dominated the per-instruction cost. A listener that
    // unsubscribes *during* this loop is still called this round; its removal is
    // drained afterward — matching the slow path's "removed at this depth still
    // fires this round" semantics.
    if (
      this.cycleListenerDispatchDepth === 0 &&
      this.pendingCycleListenerRemovalDepths.size === 0
    ) {
      this.cycleListenerDispatchDepth = 1;
      try {
        for (let i = 0; i < count; i += 1) listeners[i]!(elapsed, this);
      } finally {
        this.cycleListenerDispatchDepth = 0;
        if (this.pendingCycleListenerRemovals.length > 0) this.drainCycleListenerRemovals();
      }
      return;
    }

    // Slow path: reentrant (nested notification) or removals already pending. Use
    // the full depth-aware bookkeeping so an unsubscribe during a nested
    // notification applies to deeper dispatches without perturbing the active one.
    this.cycleListenerDispatchDepth += 1;
    const dispatchDepth = this.cycleListenerDispatchDepth;
    const removalDepths =
      this.pendingCycleListenerRemovalDepths.size > 0
        ? this.pendingCycleListenerRemovalDepths
        : undefined;
    try {
      if (removalDepths === undefined) {
        for (let i = 0; i < count; i += 1) listeners[i]!(elapsed, this);
      } else {
        for (let i = 0; i < count; i += 1) {
          const listener = listeners[i]!;
          const removalDepth = removalDepths.get(listener);
          if (removalDepth !== undefined && removalDepth < dispatchDepth) continue;
          listener(elapsed, this);
        }
      }
    } finally {
      this.cycleListenerDispatchDepth -= 1;
      if (this.cycleListenerDispatchDepth === 0 && this.pendingCycleListenerRemovals.length > 0) {
        this.drainCycleListenerRemovals();
      }
    }
  }

  private drainCycleListenerRemovals(): void {
    for (const listener of this.pendingCycleListenerRemovals) this.spliceCycleListener(listener);
    this.pendingCycleListenerRemovals.length = 0;
    this.pendingCycleListenerRemovalDepths.clear();
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
    // Check the cheap array length before the SREG accessor: most ticks have no
    // pending interrupt, so this avoids the flag bit-math on the common path.
    if (this.pendingInterrupts.length === 0 || !this.sreg.I) return;
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
    this.invalidateDecodeCache(); // restored flash may differ from the cached program
    this.nextClockEvent = undefined; // peripherals re-arm their events in restore()
    this.pendingInterrupts.length = 0;
    for (const vector of snap.pendingInterrupts) {
      this.pendingInterrupts.push({ vector, acknowledge: acknowledgeForVector?.(vector) });
    }
    this.pendingInterrupts.sort((a, b) => a.vector - b.vector);
  }
}
