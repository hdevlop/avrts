import {
  createAVRWorkerRuntime,
  type AVR,
  type AVRSnapshot,
  type AVRSpeed,
  type AVRStatus,
  type AVRWorkerRuntime,
  type AVRWorkerRuntimeOptions,
  type PinFrame,
  type PwmFrame,
  type PwmSignal,
} from "../../../src";

export type SimulatorLifecycleEvent =
  | "start"
  | "pause"
  | "resume"
  | "stop"
  | "reset"
  | "restore"
  | "load"
  | "clear"
  | "breakpoint"
  | "error";

export interface SimulatorRuntime {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  reset(): void;
  step(): void;
  setSpeed(speed: AVRSpeed): void;
  loadHex(hex: string): void;
  loadFile(fileLike: { text(): Promise<string> }): Promise<void>;
  setInput(pin: number, high: boolean): void;
  readPin(pin: number): boolean;
  onPinChange(pin: number, handler: (high: boolean, event: PinFrame) => void): () => void;
  readPwm(pin: number): PwmSignal;
  onPwmChange(pin: number, handler: (signal: PwmSignal) => void): () => void;
  serialWrite(text: string): void;
  serialText(): string;
  onSerialText(handler: (text: string) => void): () => void;
  snapshot(): Promise<SimulatorSnapshot>;
  restore(snapshot: SimulatorSnapshot): Promise<void>;
  status(): AVRStatus;
  onStatusChange(handler: (status: AVRStatus) => void): () => void;
  onRefresh(handler: () => void): () => void;
  destroy(): void;
}

export type SimulatorSnapshot = AVRSnapshot | { snapshotId: string };

export function createLocalSimulatorRuntime(avr: AVR): SimulatorRuntime {
  const statusListeners = new Set<(status: AVRStatus) => void>();
  const refreshListeners = new Set<() => void>();

  const notifyStatus = (): void => {
    const status = avr.status();
    for (const listener of [...statusListeners]) listener(status);
  };
  const notifyRefresh = (): void => {
    for (const listener of [...refreshListeners]) listener();
    notifyStatus();
  };

  const lifecycle: SimulatorLifecycleEvent[] = [
    "start",
    "pause",
    "resume",
    "stop",
    "reset",
    "restore",
    "load",
    "clear",
    "breakpoint",
    "error",
  ];
  const offs = lifecycle.map((event) => avr.on(event, notifyRefresh));

  return {
    start: () => {
      avr.start();
      notifyStatus();
    },
    pause: () => {
      avr.pause();
      notifyStatus();
    },
    resume: () => {
      avr.resume();
      notifyStatus();
    },
    stop: () => {
      avr.stop();
      notifyStatus();
    },
    reset: () => {
      avr.reset();
      notifyRefresh();
    },
    step: () => {
      avr.step();
      notifyRefresh();
    },
    setSpeed: (speed) => {
      avr.setSpeed(speed);
      notifyStatus();
    },
    loadHex: (hex) => {
      avr.loadHex(hex);
      notifyRefresh();
    },
    async loadFile(fileLike) {
      await avr.loadFile(fileLike);
      notifyRefresh();
    },
    setInput: (pin, high) => {
      avr.pin(pin).setInput(high);
      notifyRefresh();
    },
    readPin: (pin) => avr.pin(pin).read(),
    onPinChange: (pin, handler) =>
      avr.pin(pin).onChange((high, event) => {
        handler(high, event);
      }),
    readPwm: (pin) => avr.pwm(pin).read(),
    onPwmChange: (pin, handler) => avr.pwm(pin).onChange(handler),
    serialWrite: (text) => {
      avr.serial.write(text);
    },
    serialText: () => avr.serial.getText(),
    onSerialText: (handler) => avr.serial.onText(handler),
    snapshot: async () => avr.snapshot(),
    restore: async (snapshot) => {
      if ("snapshotId" in snapshot) return;
      avr.restore(snapshot);
      notifyRefresh();
    },
    status: () => avr.status(),
    onStatusChange(handler) {
      statusListeners.add(handler);
      return () => {
        statusListeners.delete(handler);
      };
    },
    onRefresh(handler) {
      refreshListeners.add(handler);
      return () => {
        refreshListeners.delete(handler);
      };
    },
    destroy() {
      for (const off of offs) off();
      statusListeners.clear();
      refreshListeners.clear();
    },
  };
}

export function createWorkerSimulatorRuntime(
  options: AVRWorkerRuntimeOptions = {},
): SimulatorRuntime {
  return new WorkerSimulatorRuntime(createAVRWorkerRuntime(options));
}

export function wrapWorkerSimulatorRuntime(worker: AVRWorkerRuntime): SimulatorRuntime {
  return new WorkerSimulatorRuntime(worker);
}

class WorkerSimulatorRuntime implements SimulatorRuntime {
  private readonly pinStates = new Map<number, PinFrame>();
  private readonly pwmStates = new Map<number, PwmSignal>();
  private readonly pinListeners = new Map<number, Set<(high: boolean, event: PinFrame) => void>>();
  private readonly pwmListeners = new Map<number, Set<(signal: PwmSignal) => void>>();
  private readonly serialListeners = new Set<(text: string) => void>();
  private readonly statusListeners = new Set<(status: AVRStatus) => void>();
  private readonly refreshListeners = new Set<() => void>();
  private readonly offs: Array<() => void> = [];
  private text = "";
  private latestStatus: AVRStatus = {
    running: false,
    paused: false,
    timeMs: 0,
    cycles: 0,
    speed: 1,
    chip: "atmega328p",
    clockHz: 16_000_000,
    programLoaded: false,
  };

  constructor(private readonly worker: AVRWorkerRuntime) {
    this.offs.push(
      worker.on("ready", (event) => this.setStatus(event.status)),
      worker.on("status", (event) => this.setStatus(event.status)),
      worker.on("frame", (event) => {
        this.setStatus(event.status);
        this.consumePins(event.pins);
        this.consumePwm(event.pwm);
        this.notifyRefresh();
      }),
      worker.on("serial", (event) => {
        this.text += event.text;
        for (const listener of [...this.serialListeners]) listener(event.text);
      }),
      worker.on("breakpoint", (event) => this.setStatus(event.status)),
      worker.on("error", (event) => {
        if (event.status) this.setStatus(event.status);
      }),
    );

    const initial = worker.status();
    if (initial) this.latestStatus = initial;
  }

  start(): void {
    this.worker.start();
  }

  pause(): void {
    this.worker.pause();
  }

  resume(): void {
    this.worker.resume();
  }

  stop(): void {
    this.worker.stop();
  }

  reset(): void {
    this.text = "";
    this.worker.reset();
  }

  step(): void {
    this.worker.step();
  }

  setSpeed(speed: AVRSpeed): void {
    this.worker.setSpeed(speed);
  }

  loadHex(hex: string): void {
    this.text = "";
    this.worker.loadHex(hex);
  }

  async loadFile(fileLike: { text(): Promise<string> }): Promise<void> {
    this.loadHex(await fileLike.text());
  }

  setInput(pin: number, high: boolean): void {
    this.worker.setInput(pin, high);
  }

  readPin(pin: number): boolean {
    return this.pinStates.get(pin)?.high ?? false;
  }

  onPinChange(pin: number, handler: (high: boolean, event: PinFrame) => void): () => void {
    let listeners = this.pinListeners.get(pin);
    if (!listeners) {
      listeners = new Set();
      this.pinListeners.set(pin, listeners);
    }
    listeners.add(handler);
    return () => listeners?.delete(handler);
  }

  readPwm(pin: number): PwmSignal {
    return this.pwmStates.get(pin) ?? disabledPwm();
  }

  onPwmChange(pin: number, handler: (signal: PwmSignal) => void): () => void {
    let listeners = this.pwmListeners.get(pin);
    if (!listeners) {
      listeners = new Set();
      this.pwmListeners.set(pin, listeners);
    }
    listeners.add(handler);
    return () => listeners?.delete(handler);
  }

  serialWrite(text: string): void {
    this.worker.serialWrite(text);
  }

  serialText(): string {
    return this.text;
  }

  onSerialText(handler: (text: string) => void): () => void {
    this.serialListeners.add(handler);
    return () => {
      this.serialListeners.delete(handler);
    };
  }

  async snapshot(): Promise<SimulatorSnapshot> {
    return new Promise((resolve) => {
      const off = this.worker.on("snapshot", (event) => {
        off();
        resolve(event.snapshot ?? { snapshotId: event.snapshotId });
      });
      this.worker.snapshot({ includeData: true });
    });
  }

  async restore(snapshot: SimulatorSnapshot): Promise<void> {
    this.worker.restore("snapshotId" in snapshot ? snapshot : { snapshot });
  }

  status(): AVRStatus {
    return this.latestStatus;
  }

  onStatusChange(handler: (status: AVRStatus) => void): () => void {
    this.statusListeners.add(handler);
    return () => {
      this.statusListeners.delete(handler);
    };
  }

  onRefresh(handler: () => void): () => void {
    this.refreshListeners.add(handler);
    return () => {
      this.refreshListeners.delete(handler);
    };
  }

  destroy(): void {
    for (const off of this.offs) off();
    this.worker.destroy();
    this.pinListeners.clear();
    this.pwmListeners.clear();
    this.serialListeners.clear();
    this.statusListeners.clear();
    this.refreshListeners.clear();
  }

  private consumePins(pins: PinFrame[]): void {
    for (const frame of pins) {
      this.pinStates.set(frame.pin, frame);
      const listeners = this.pinListeners.get(frame.pin);
      if (!listeners) continue;
      for (const listener of [...listeners]) listener(frame.high, frame);
    }
  }

  private consumePwm(frames: PwmFrame[]): void {
    for (const frame of frames) {
      const signal = toPwmSignal(frame);
      const previous = this.pwmStates.get(frame.pin);
      this.pwmStates.set(frame.pin, signal);
      if (previous && pwmEqual(previous, signal)) continue;
      const listeners = this.pwmListeners.get(frame.pin);
      if (!listeners) continue;
      for (const listener of [...listeners]) listener(signal);
    }
  }

  private setStatus(status: AVRStatus): void {
    this.latestStatus = status;
    for (const listener of [...this.statusListeners]) listener(status);
  }

  private notifyRefresh(): void {
    for (const listener of [...this.refreshListeners]) listener();
  }
}

function toPwmSignal(frame: PwmFrame): PwmSignal {
  const { pin: _pin, ...signal } = frame;
  return signal;
}

function disabledPwm(): PwmSignal {
  return {
    channel: "A",
    enabled: false,
    inverted: false,
    duty: 0,
    value: 0,
    mode: "off",
  };
}

function pwmEqual(a: PwmSignal, b: PwmSignal): boolean {
  return (
    a.channel === b.channel &&
    a.enabled === b.enabled &&
    a.inverted === b.inverted &&
    a.duty === b.duty &&
    a.value === b.value &&
    a.mode === b.mode
  );
}
