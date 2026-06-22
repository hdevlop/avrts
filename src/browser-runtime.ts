import { AVR } from "./avr";
import type { AVRSpeed, AVRStatus, DataWatchEvent } from "./avr";
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
  | { type: "pauseOnUnknownOpcode"; enabled: boolean };

export type AVRWorkerEvent =
  | { type: "ready"; status: AVRStatus }
  | { type: "status"; status: AVRStatus }
  | { type: "frame"; pins: PinFrame[]; pwm: PwmFrame[]; status: AVRStatus }
  | { type: "serial"; text: string }
  | { type: "snapshot"; snapshotId: string; snapshot?: AVRSnapshot }
  | { type: "breakpoint"; pc: number; status: AVRStatus }
  | { type: "watchFrame"; events: DataWatchFrame[] }
  | { type: "logicChunk"; chunk: LogicAnalyzerChunk }
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
}

const DIGITAL_PINS = Array.from({ length: 14 }, (_, pin) => pin);
const PWM_PINS = [3, 5, 6, 9, 10, 11] as const;
const MAX_SNAPSHOT_COUNT = 10;
const FRAME_MS = 33;
const CHUNK_MS = 2;
const MAX_CHUNK_CYCLES = 50_000;

export function createAVRWorkerRuntime(options: AVRWorkerRuntimeOptions = {}): AVRWorkerRuntime {
  const worker = options.worker ?? new Worker(new URL("./browser-worker.ts", import.meta.url), { type: "module" });
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
  let pumpHandle: ReturnType<typeof setTimeout> | null = null;
  let frameHandle: ReturnType<typeof setInterval> | null = null;
  let snapshotCounter = 0;

  const pendingPins = new Map<number, PinFrame>();
  const snapshots = new Map<string, AVRSnapshot>();
  const watchFrames = new Map<number, DataWatchFrame>();
  const watchUnsubscribers = new Map<number, () => void>();

  const setTimer = scope.setTimeout?.bind(scope) ?? setTimeout;
  const clearTimer = scope.clearTimeout?.bind(scope) ?? clearTimeout;
  const setEvery = scope.setInterval?.bind(scope) ?? setInterval;
  const clearEvery = scope.clearInterval?.bind(scope) ?? clearInterval;

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
    const pins = [...pendingPins.values()];
    pendingPins.clear();
    const pwm = readPwmFrames();
    post({ type: "frame", pins, pwm, status: status() });
    flushWatchFrames();
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

  const ensureFrameTimer = (): void => {
    if (frameHandle !== null) return;
    frameHandle = setEvery(emitFrame, FRAME_MS);
  };

  const stopFrameTimer = (): void => {
    if (frameHandle === null) return;
    clearEvery(frameHandle);
    frameHandle = null;
  };

  const schedulePump = (): void => {
    if (!running || paused || pumpHandle !== null) return;
    pumpHandle = setTimer(() => {
      pumpHandle = null;
      pump();
    }, 0);
  };

  const cancelPump = (): void => {
    if (pumpHandle === null) return;
    clearTimer(pumpHandle);
    pumpHandle = null;
  };

  const chunkCycles = (): number => {
    if (speed === "max") return MAX_CHUNK_CYCLES;
    const clockHz = avr.status().clockHz;
    const cycles = Math.ceil((clockHz * speed * CHUNK_MS) / 1000);
    return Math.max(1, Math.min(cycles, MAX_CHUNK_CYCLES));
  };

  const pump = (): void => {
    if (!running || paused) return;
    try {
      avr.runCycles(chunkCycles());
    } catch (error) {
      running = false;
      paused = false;
      cancelPump();
      stopFrameTimer();
      post({ type: "error", message: String(error), status: status() });
      return;
    }
    schedulePump();
  };

  const start = (): void => {
    running = true;
    paused = false;
    ensureFrameTimer();
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

  const bindAvrEvents = (): void => {
    avr.pins.onChange((event) => pendingPins.set(event.pin, pinFrame(event)));
    avr.serial.onText((text) => post({ type: "serial", text }));
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
          speed = command.speed;
          avr.setSpeed(command.speed);
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
            avr.restore(command.snapshot);
            emitFrame();
            postStatus();
            return;
          }
          if (command.snapshotId) {
            const snapshot = snapshots.get(command.snapshotId);
            if (snapshot) {
              avr.restore(snapshot);
              emitFrame();
              postStatus();
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
