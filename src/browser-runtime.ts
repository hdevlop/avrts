import { AVR } from "./avr";
import type { AVRSpeed, AVRStatus, DataWatchEvent } from "./avr";
import { SPH_ADDR, SPL_ADDR, SREG_ADDR } from "./cpu";
import type { AVRSnapshot } from "./snapshot";
import type { PinChangeEvent, PwmSignal } from "./peripherals";
import { pinInfo } from "./peripherals";

export type AnalogInputOptions =
  | { channel: number; value: number }
  | { channel: number; volts: number; referenceVolts?: number };

export type AnalogInputCommand = { type: "setAnalog" } & AnalogInputOptions;

export interface PinFrame {
  pin: number;
  high: boolean;
  port: "B" | "C" | "D";
  bit: number;
  cycles: number;
  timeMs: number;
}

export interface PwmFrame extends PwmSignal {
  pin: number;
}

export interface DataWatchFrame {
  address: number;
  writes: Array<{
    oldValue: number;
    value: number;
    cycles: number;
  }>;
}

export interface LogicAnalyzerChunk {
  analyzerId: string;
  format: "u32-cycles-u8-pin-u8-high";
  buffer: ArrayBuffer;
}

/** One captured exact edge (no coalescing). */
export interface LogicSampleRecord {
  pin: number;
  high: boolean;
  cycles: number;
}

const LOGIC_SAMPLE_BYTES = 6; // u32 cycles + u8 pin + u8 high

/** Pack exact edges into a transferable `ArrayBuffer` (see `LogicAnalyzerChunk.format`). */
export function encodeLogicSamples(samples: ReadonlyArray<LogicSampleRecord>): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * LOGIC_SAMPLE_BYTES);
  const view = new DataView(buffer);
  let offset = 0;
  for (const sample of samples) {
    view.setUint32(offset, sample.cycles >>> 0, true);
    view.setUint8(offset + 4, sample.pin & 0xff);
    view.setUint8(offset + 5, sample.high ? 1 : 0);
    offset += LOGIC_SAMPLE_BYTES;
  }
  return buffer;
}

/** Decode a `LogicAnalyzerChunk` back into exact edges. */
export function decodeLogicChunk(chunk: LogicAnalyzerChunk): LogicSampleRecord[] {
  const view = new DataView(chunk.buffer);
  const samples: LogicSampleRecord[] = [];
  for (let offset = 0; offset + LOGIC_SAMPLE_BYTES <= chunk.buffer.byteLength; offset += LOGIC_SAMPLE_BYTES) {
    samples.push({
      cycles: view.getUint32(offset, true),
      pin: view.getUint8(offset + 4),
      high: view.getUint8(offset + 5) === 1,
    });
  }
  return samples;
}

export type AVRWorkerCommand =
  | { type: "loadHex"; hex: string }
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "setSpeed"; speed: AVRSpeed }
  | { type: "setInput"; pin: number; high: boolean }
  | AnalogInputCommand
  | { type: "serialWrite"; text: string }
  | { type: "snapshot"; includeData?: boolean }
  | { type: "restore"; snapshotId?: string; snapshot?: AVRSnapshot }
  | { type: "deleteSnapshot"; snapshotId: string }
  | { type: "step" }
  | { type: "setBreakpoint"; pc: number }
  | { type: "clearBreakpoint"; pc: number }
  | { type: "clearBreakpoints" }
  | { type: "watchData"; address: number }
  | { type: "unwatchData"; address: number }
  | { type: "pauseOnUnknownOpcode"; enabled: boolean }
  | { type: "captureEdges"; pins: number[]; id?: string }
  | { type: "stopCapture" }
  | { type: "readRegisters" };

export type AVRWorkerEvent =
  | { type: "ready"; status: AVRStatus }
  | { type: "status"; status: AVRStatus }
  | { type: "frame"; pins: PinFrame[]; pwm: PwmFrame[]; status: AVRStatus }
  | { type: "serial"; text: string }
  | { type: "snapshot"; snapshotId: string; snapshot?: AVRSnapshot }
  | { type: "breakpoint"; pc: number; status: AVRStatus }
  | { type: "watchFrame"; events: DataWatchFrame[] }
  | { type: "logicChunk"; chunk: LogicAnalyzerChunk }
  | { type: "registers"; pc: number; sp: number; sreg: number; cycles: number; registers: number[] }
  | { type: "error"; message: string; status?: AVRStatus };

export type AVRWorkerEventType = AVRWorkerEvent["type"];
export type AVRWorkerEventHandler<T extends AVRWorkerEventType = AVRWorkerEventType> = (
  event: Extract<AVRWorkerEvent, { type: T }>,
) => void;

export interface AVRWorkerRuntimeOptions {
  hex?: string;
  speed?: AVRSpeed;
  worker?: WorkerLike;
}

export interface AVRWorkerRuntime {
  readonly worker: WorkerLike;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  reset(): void;
  setSpeed(speed: AVRSpeed): void;
  loadHex(hex: string): void;
  setInput(pin: number, high: boolean): void;
  setAnalog(command: AnalogInputOptions): void;
  serialWrite(text: string): void;
  snapshot(options?: { includeData?: boolean }): void;
  restore(input: { snapshotId?: string; snapshot?: AVRSnapshot }): void;
  deleteSnapshot(snapshotId: string): void;
  step(): void;
  setBreakpoint(pc: number): void;
  clearBreakpoint(pc: number): void;
  clearBreakpoints(): void;
  watchData(address: number): void;
  unwatchData(address: number): void;
  pauseOnUnknownOpcode(enabled: boolean): void;
  /** Start exact (non-coalesced) edge capture on the given pins for analyzer/scope. */
  captureEdges(pins: number[], id?: string): void;
  stopCapture(): void;
  /** Request a one-shot `registers` event (PC/SP/SREG/cycles/R0-R31) for the debugger. */
  readRegisters(): void;
  status(): AVRStatus | null;
  on<T extends AVRWorkerEventType>(type: T, handler: AVRWorkerEventHandler<T>): () => void;
  destroy(): void;
}

export interface WorkerLike {
  postMessage(message: AVRWorkerCommand, transfer?: Transferable[]): void;
  terminate?(): void;
  addEventListener?(
    type: "message",
    listener: (event: MessageEvent<AVRWorkerEvent>) => void,
  ): void;
  removeEventListener?(
    type: "message",
    listener: (event: MessageEvent<AVRWorkerEvent>) => void,
  ): void;
  onmessage?: ((event: MessageEvent<AVRWorkerEvent>) => void) | null;
}

export interface WorkerScopeLike {
  postMessage(message: AVRWorkerEvent, transfer?: Transferable[]): void;
  setTimeout?(handler: () => void, timeout?: number): ReturnType<typeof setTimeout>;
  clearTimeout?(handle: ReturnType<typeof setTimeout>): void;
  setInterval?(handler: () => void, timeout?: number): ReturnType<typeof setInterval>;
  clearInterval?(handle: ReturnType<typeof setInterval>): void;
  onmessage?: ((event: MessageEvent<AVRWorkerCommand>) => void) | null;
  /** Monotonic wall clock in ms for real-time pacing; defaults to performance.now(). */
  now?(): number;
  /**
   * Schedule a task with no minimum-delay clamp (browser: `MessageChannel`), used
   * to drive the execution pump at "max" speed without the ~4 ms nested-timeout
   * throttle. Returns a cancel function. Defaults to a `MessageChannel` scheduler.
   */
  scheduleImmediate?(handler: () => void): () => void;
}

const DIGITAL_PINS = Array.from({ length: 14 }, (_, pin) => pin);
const PWM_PINS = [3, 5, 6, 9, 10, 11] as const;
const MAX_SNAPSHOT_COUNT = 10;
const FRAME_MS = 33;
// Real-time pacing: how often the finite-speed pump ticks (the browser clamps
// nested timers to ~4 ms anyway; the accumulator keeps throughput correct
// regardless of the actual spacing).
const PACING_TICK_MS = 4;
// Cap catch-up after a stall/tab-throttle so the worker never replays minutes of
// missed time in a single blocking batch.
const MAX_CATCHUP_MS = 100;
// Cycles per "max"-speed pump before yielding, bounding command latency while
// letting the immediate scheduler keep the engine near its ceiling.
const MAX_PUMP_CYCLES = 200_000;

type ImmediateScheduler = (handler: () => void) => () => void;

function createDefaultNow(): () => number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === "function") {
    const perfNow = perf.now.bind(perf);
    return () => perfNow();
  }
  return () => Date.now();
}

function createImmediateScheduler(
  setTimer: (handler: () => void, timeout?: number) => ReturnType<typeof setTimeout>,
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void,
): ImmediateScheduler {
  const channelCtor = (globalThis as { MessageChannel?: typeof MessageChannel }).MessageChannel;
  if (channelCtor) {
    const channel = new channelCtor();
    let pending: (() => void) | null = null;
    channel.port1.onmessage = () => {
      const handler = pending;
      pending = null;
      handler?.();
    };
    return (handler) => {
      pending = handler;
      channel.port2.postMessage(0);
      return () => {
        pending = null;
      };
    };
  }
  return (handler) => {
    const id = setTimer(handler, 0);
    return () => clearTimer(id);
  };
}

export function createAVRWorkerRuntime(options: AVRWorkerRuntimeOptions = {}): AVRWorkerRuntime {
  // Resolved relative to whichever bundle module holds this line: build:lib:js
  // emits shared chunks beside public/browser-worker.js so it always resolves.
  const worker: WorkerLike = options.worker ?? new Worker(new URL("./browser-worker.js", import.meta.url), { type: "module" });
  const listeners = new Map<AVRWorkerEventType, Set<AVRWorkerEventHandler>>();
  let latestStatus: AVRStatus | null = null;

  const dispatch = (event: AVRWorkerEvent): void => {
    if ("status" in event && event.status) latestStatus = event.status;
    const handlers = listeners.get(event.type);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      (handler as AVRWorkerEventHandler<typeof event.type>)(event as never);
    }
  };

  const onMessage = (event: MessageEvent<AVRWorkerEvent>): void => dispatch(event.data);
  if (worker.addEventListener) {
    worker.addEventListener("message", onMessage);
  } else {
    worker.onmessage = onMessage;
  }

  const post = (command: AVRWorkerCommand): void => worker.postMessage(command);

  if (options.speed !== undefined) post({ type: "setSpeed", speed: options.speed });
  if (options.hex !== undefined) post({ type: "loadHex", hex: options.hex });

  return {
    worker,
    start: () => post({ type: "start" }),
    pause: () => post({ type: "pause" }),
    resume: () => post({ type: "resume" }),
    stop: () => post({ type: "stop" }),
    reset: () => post({ type: "reset" }),
    setSpeed: (speed) => post({ type: "setSpeed", speed }),
    loadHex: (hex) => post({ type: "loadHex", hex }),
    setInput: (pin, high) => post({ type: "setInput", pin, high }),
    setAnalog: (command) => post({ type: "setAnalog", ...command } as AnalogInputCommand),
    serialWrite: (text) => post({ type: "serialWrite", text }),
    snapshot: (options = {}) => post({ type: "snapshot", includeData: options.includeData }),
    restore: (input) => post({ type: "restore", ...input }),
    deleteSnapshot: (snapshotId) => post({ type: "deleteSnapshot", snapshotId }),
    step: () => post({ type: "step" }),
    setBreakpoint: (pc) => post({ type: "setBreakpoint", pc }),
    clearBreakpoint: (pc) => post({ type: "clearBreakpoint", pc }),
    clearBreakpoints: () => post({ type: "clearBreakpoints" }),
    watchData: (address) => post({ type: "watchData", address }),
    unwatchData: (address) => post({ type: "unwatchData", address }),
    pauseOnUnknownOpcode: (enabled) => post({ type: "pauseOnUnknownOpcode", enabled }),
    captureEdges: (pins, id) => post({ type: "captureEdges", pins, id }),
    stopCapture: () => post({ type: "stopCapture" }),
    readRegisters: () => post({ type: "readRegisters" }),
    status: () => latestStatus,
    on(type, handler) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler as unknown as AVRWorkerEventHandler);
      return () => set?.delete(handler as unknown as AVRWorkerEventHandler);
    },
    destroy() {
      if (worker.removeEventListener) worker.removeEventListener("message", onMessage);
      if (!worker.removeEventListener) worker.onmessage = null;
      worker.terminate?.();
      listeners.clear();
    },
  };
}

export function installAVRWorker(scope: WorkerScopeLike): void {
  let avr = AVR({ eventCoalescing: { pins: true } });
  let running = false;
  let paused = false;
  let speed: AVRSpeed = 1;
  let pumpCancel: (() => void) | null = null;
  let lastPumpHostMs = 0;
  let pumpResidualCycles = 0;
  let frameHandle: ReturnType<typeof setInterval> | null = null;
  let snapshotCounter = 0;

  const pendingPins = new Map<number, PinFrame>();
  const snapshots = new Map<string, AVRSnapshot>();
  const watchFrames = new Map<number, DataWatchFrame>();
  const watchUnsubscribers = new Map<number, () => void>();
  let pendingSerialText = "";
  // Exact-edge capture (logic analyzer / scope): every edge on captured pins,
  // independent of the coalesced `frame` stream.
  const capturePins = new Set<number>();
  const edgeBuffer: LogicSampleRecord[] = [];
  let captureId = "capture";
  const MAX_EDGE_BUFFER = 8192;

  // Typed to the scope signatures so host (Node/Bun/DOM) timer handle types never mix.
  const setTimer: NonNullable<WorkerScopeLike["setTimeout"]> = scope.setTimeout?.bind(scope) ?? setTimeout;
  const clearTimer: NonNullable<WorkerScopeLike["clearTimeout"]> = scope.clearTimeout?.bind(scope) ?? clearTimeout;
  const setEvery: NonNullable<WorkerScopeLike["setInterval"]> = scope.setInterval?.bind(scope) ?? setInterval;
  const clearEvery: NonNullable<WorkerScopeLike["clearInterval"]> = scope.clearInterval?.bind(scope) ?? clearInterval;
  const now = scope.now?.bind(scope) ?? createDefaultNow();
  const scheduleImmediate: ImmediateScheduler =
    scope.scheduleImmediate?.bind(scope) ?? createImmediateScheduler(setTimer, clearTimer);

  const status = (): AVRStatus => ({
    ...avr.status(),
    running,
    paused,
    speed,
  });

  const post = (event: AVRWorkerEvent, transfer?: Transferable[]): void => {
    scope.postMessage(event, transfer);
  };

  const postStatus = (): void => post({ type: "status", status: status() });
  const postError = (message: string): void => post({ type: "error", message, status: status() });

  const pinFrame = (event: PinChangeEvent): PinFrame => ({
    pin: event.pin,
    high: event.high,
    port: event.port,
    bit: event.bit,
    cycles: event.cycles,
    timeMs: event.timeMs,
  });

  const emitFrame = (): void => {
    flushSerialText();
    const pins = [...pendingPins.values()];
    pendingPins.clear();
    const pwm = readPwmFrames();
    post({ type: "frame", pins, pwm, status: status() });
    flushWatchFrames();
    flushLogicChunk();
  };

  const readPwmFrames = (): PwmFrame[] => {
    const frames: PwmFrame[] = [];
    for (const pin of PWM_PINS) {
      try {
        frames.push({ pin, ...avr.pwm(pin).read() });
      } catch {
        // Ignore unsupported pins if future chip presets change PWM mapping.
      }
    }
    return frames;
  };

  const flushWatchFrames = (): void => {
    if (watchFrames.size === 0) return;
    const events = [...watchFrames.values()];
    watchFrames.clear();
    post({ type: "watchFrame", events });
  };

  const flushSerialText = (): void => {
    if (pendingSerialText.length === 0) return;
    const text = pendingSerialText;
    pendingSerialText = "";
    post({ type: "serial", text });
  };

  const flushLogicChunk = (): void => {
    if (edgeBuffer.length === 0) return;
    const samples = edgeBuffer.splice(0, edgeBuffer.length);
    const buffer = encodeLogicSamples(samples);
    post(
      { type: "logicChunk", chunk: { analyzerId: captureId, format: "u32-cycles-u8-pin-u8-high", buffer } },
      [buffer],
    );
  };

  const ensureFrameTimer = (): void => {
    if (frameHandle !== null) return;
    frameHandle = setEvery(emitFrame, FRAME_MS);
  };

  const stopFrameTimer = (): void => {
    if (frameHandle === null) return;
    clearEvery(frameHandle);
    frameHandle = null;
  };

  const resetPacing = (): void => {
    lastPumpHostMs = now();
    pumpResidualCycles = 0;
  };

  const schedulePump = (): void => {
    if (!running || paused || pumpCancel !== null) return;
    if (speed === "max") {
      pumpCancel = scheduleImmediate(runPump);
    } else {
      const id = setTimer(runPump, PACING_TICK_MS);
      pumpCancel = () => clearTimer(id);
    }
  };

  const cancelPump = (): void => {
    if (pumpCancel === null) return;
    pumpCancel();
    pumpCancel = null;
  };

  // Cycles to advance this tick. Finite speed is wall-clock paced: run exactly the
  // cycles owed for the real time elapsed since the last tick (fractional cycles
  // carry in `pumpResidualCycles`), so simulated time tracks real time and does
  // not drift with timer jitter; catch-up is capped at MAX_CATCHUP_MS. "max" speed
  // ignores the clock and runs a fixed chunk, rescheduling via the immediate
  // scheduler to approach the engine ceiling.
  const pumpCycles = (): number => {
    if (speed === "max") return MAX_PUMP_CYCLES;
    const nowMs = now();
    let elapsed = nowMs - lastPumpHostMs;
    lastPumpHostMs = nowMs;
    if (!(elapsed > 0)) elapsed = 0;
    else if (elapsed > MAX_CATCHUP_MS) elapsed = MAX_CATCHUP_MS;
    const clockHz = avr.status().clockHz;
    const owed = pumpResidualCycles + (elapsed / 1000) * clockHz * speed;
    const toRun = Math.floor(owed);
    pumpResidualCycles = owed - toRun;
    return toRun;
  };

  const runPump = (): void => {
    pumpCancel = null;
    if (!running || paused) return;
    const cycles = pumpCycles();
    if (cycles >= 1) {
      try {
        avr.runCycles(cycles);
      } catch (error) {
        running = false;
        paused = false;
        cancelPump();
        stopFrameTimer();
        post({ type: "error", message: String(error), status: status() });
        return;
      }
    }
    schedulePump();
  };

  const start = (): void => {
    running = true;
    paused = false;
    ensureFrameTimer();
    resetPacing();
    schedulePump();
    postStatus();
  };

  const pause = (): void => {
    if (!running) return;
    paused = true;
    cancelPump();
    emitFrame();
    postStatus();
  };

  const resume = (): void => {
    if (!running) {
      start();
      return;
    }
    paused = false;
    ensureFrameTimer();
    resetPacing();
    schedulePump();
    postStatus();
  };

  const stop = (): void => {
    running = false;
    paused = false;
    cancelPump();
    stopFrameTimer();
    emitFrame();
    postStatus();
  };

  const recordSnapshot = (snapshot: AVRSnapshot): string => {
    const id = `snapshot-${++snapshotCounter}`;
    snapshots.set(id, snapshot);
    while (snapshots.size > MAX_SNAPSHOT_COUNT) {
      const first = snapshots.keys().next().value;
      if (first === undefined) break;
      snapshots.delete(first);
    }
    return id;
  };

  const restoreSnapshot = (snapshot: AVRSnapshot): void => {
    // The worker owns pacing. Restoring a facade host loop here would create
    // a second execution loop outside the worker's pause/stop controls.
    avr.restore({
      ...snapshot,
      runtime: { ...snapshot.runtime, running: false, paused: false },
    });
    cancelPump();
    stopFrameTimer();
    running = snapshot.runtime.running;
    paused = running && snapshot.runtime.paused;
    speed = snapshot.runtime.speed;
    resetPacing();
    if (running) ensureFrameTimer();
    schedulePump();
    emitFrame();
    postStatus();
  };

  const bindAvrEvents = (): void => {
    avr.pins.onChange((event) => {
      pendingPins.set(event.pin, pinFrame(event));
      if (capturePins.has(event.pin)) {
        edgeBuffer.push({ pin: event.pin, high: event.high, cycles: event.cycles });
        if (edgeBuffer.length >= MAX_EDGE_BUFFER) flushLogicChunk();
      }
    });
    avr.serial.onText((text) => {
      pendingSerialText += text;
    });
    avr.on("breakpoint", (event) => {
      paused = true;
      cancelPump();
      post({ type: "breakpoint", pc: event.pc ?? avr.cpu.pc, status: status() });
      postStatus();
    });
    avr.on("error", (event) => {
      paused = true;
      cancelPump();
      post({ type: "error", message: String(event.error), status: status() });
      postStatus();
    });
  };

  const watchData = (address: number): void => {
    const addr = address & 0xffff;
    if (watchUnsubscribers.has(addr)) return;
    const unsubscribe = avr.watchData(addr, (event: DataWatchEvent) => {
      let frame = watchFrames.get(event.address);
      if (!frame) {
        frame = { address: event.address, writes: [] };
        watchFrames.set(event.address, frame);
      }
      frame.writes.push({
        oldValue: event.oldValue,
        value: event.value,
        cycles: avr.cpu.cycles,
      });
    });
    watchUnsubscribers.set(addr, unsubscribe);
  };

  const unwatchData = (address: number): void => {
    const addr = address & 0xffff;
    watchUnsubscribers.get(addr)?.();
    watchUnsubscribers.delete(addr);
    watchFrames.delete(addr);
  };

  const handle = (command: AVRWorkerCommand): void => {
    try {
      switch (command.type) {
        case "loadHex":
          avr.loadHex(command.hex);
          emitFrame();
          postStatus();
          return;
        case "start":
          start();
          return;
        case "pause":
          pause();
          return;
        case "resume":
          resume();
          return;
        case "stop":
          stop();
          return;
        case "reset":
          avr.reset();
          emitFrame();
          postStatus();
          return;
        case "setSpeed":
          avr.setSpeed(command.speed);
          speed = command.speed;
          if (running && !paused) {
            cancelPump();
            resetPacing();
            schedulePump();
          }
          postStatus();
          return;
        case "setInput":
          avr.pin(command.pin).setInput(command.high);
          emitFrame();
          return;
        case "setAnalog":
          if ("volts" in command) {
            avr.analog(command.channel).setVoltage(command.volts, command.referenceVolts);
          } else {
            avr.analog(command.channel).setValue(command.value);
          }
          postStatus();
          return;
        case "serialWrite":
          avr.serial.write(command.text);
          return;
        case "snapshot": {
          const snapshot = avr.snapshot();
          snapshot.runtime.running = running;
          snapshot.runtime.paused = paused;
          snapshot.runtime.speed = speed;
          const snapshotId = recordSnapshot(snapshot);
          post({
            type: "snapshot",
            snapshotId,
            snapshot: command.includeData ? snapshot : undefined,
          });
          return;
        }
        case "restore":
          if (command.snapshot) {
            restoreSnapshot(command.snapshot);
            return;
          }
          if (command.snapshotId) {
            const snapshot = snapshots.get(command.snapshotId);
            if (snapshot) {
              restoreSnapshot(snapshot);
            } else {
              postError(`unknown snapshot id: ${command.snapshotId}`);
            }
            return;
          }
          postError("restore requires snapshot or snapshotId");
          return;
        case "deleteSnapshot":
          snapshots.delete(command.snapshotId);
          return;
        case "step":
          avr.step();
          emitFrame();
          postStatus();
          return;
        case "setBreakpoint":
          avr.breakpoint({ pc: command.pc });
          postStatus();
          return;
        case "clearBreakpoint":
          avr.clearBreakpoint(command.pc);
          postStatus();
          return;
        case "clearBreakpoints":
          avr.clearBreakpoints();
          postStatus();
          return;
        case "watchData":
          watchData(command.address);
          return;
        case "unwatchData":
          unwatchData(command.address);
          return;
        case "pauseOnUnknownOpcode":
          avr.pauseOnUnknownOpcode(command.enabled);
          postStatus();
          return;
        case "captureEdges":
          capturePins.clear();
          for (const pin of command.pins) capturePins.add(pin);
          captureId = command.id ?? "capture";
          edgeBuffer.length = 0;
          return;
        case "stopCapture":
          capturePins.clear();
          edgeBuffer.length = 0;
          return;
        case "readRegisters": {
          const data = avr.cpu.data;
          post({
            type: "registers",
            pc: avr.cpu.pc,
            sp: data[SPL_ADDR]! | (data[SPH_ADDR]! << 8),
            sreg: data[SREG_ADDR]!,
            cycles: avr.cpu.cycles,
            registers: Array.from(data.subarray(0, 32)),
          });
          return;
        }
      }
    } catch (error) {
      post({ type: "error", message: String(error), status: status() });
    }
  };

  bindAvrEvents();
  for (const pin of DIGITAL_PINS) {
    const info = pinInfo(pin);
    pendingPins.set(pin, {
      pin,
      high: avr.pin(pin).read(),
      port: info.port,
      bit: info.bit,
      cycles: avr.status().cycles,
      timeMs: avr.status().timeMs,
    });
  }
  scope.onmessage = (event) => handle(event.data);
  post({ type: "ready", status: status() });
}
