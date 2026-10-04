import { describe, expect, spyOn, test } from "bun:test";
import {
  AVR,
  createAVRWorkerRuntime,
  decodeLogicChunk,
  installAVRWorker,
  PORTB,
  type AVRWorkerCommand,
  type AVRWorkerEvent,
  type WorkerLike,
  type WorkerScopeLike,
} from "../src";
import serialPrintHex from "../examples/arduino-serial-print/arduino-serial-print.ino.hex" with { type: "text" };

const BLINK_HEX = ":0E00000000E204B900E205B900E005B9FFCF47\n:00000001FF\n";

// sbi DDRB,5 ; loop: sbi PINB,5 (toggle PB5/D13) ; rjmp loop  -> an edge every 4 cycles.
const TOGGLE_HEX = ":06000000259A1D9AFECFB7\n:00000001FF\n";

class FakeClientWorker implements WorkerLike {
  readonly commands: AVRWorkerCommand[] = [];
  private listener: ((event: MessageEvent<AVRWorkerEvent>) => void) | null = null;
  terminated = false;

  postMessage(message: AVRWorkerCommand): void {
    this.commands.push(message);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<AVRWorkerEvent>) => void): void {
    this.listener = listener;
  }

  removeEventListener(): void {
    this.listener = null;
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(event: AVRWorkerEvent): void {
    this.listener?.({ data: event } as MessageEvent<AVRWorkerEvent>);
  }
}

interface FakeTimer {
  id: number;
  handler: () => void;
  interval: boolean;
  active: boolean;
  delay: number;
}

class FakeWorkerScope implements WorkerScopeLike {
  readonly events: AVRWorkerEvent[] = [];
  onmessage: ((event: MessageEvent<AVRWorkerCommand>) => void) | null = null;
  private nextTimerId = 1;
  private virtualNowMs = 0;
  private readonly timerQueue: Array<FakeTimer> = [];
  private readonly timers = new Map<number, FakeTimer>();

  postMessage(message: AVRWorkerEvent): void {
    this.events.push(message);
  }

  send(command: AVRWorkerCommand): void {
    this.onmessage?.({ data: command } as MessageEvent<AVRWorkerCommand>);
  }

  now(): number {
    return this.virtualNowMs;
  }

  setTimeout(handler: () => void, timeout = 0): ReturnType<typeof setTimeout> {
    return this.addTimer(handler, false, timeout);
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.clearTimer(handle);
  }

  setInterval(handler: () => void, timeout = 0): ReturnType<typeof setInterval> {
    return this.addTimer(handler, true, timeout);
  }

  clearInterval(handle: ReturnType<typeof setInterval>): void {
    this.clearTimer(handle);
  }

  scheduleImmediate(handler: () => void): () => void {
    const id = this.addTimer(handler, false, 0);
    return () => this.clearTimer(id);
  }

  activeTimerCount(): number {
    return this.timers.size;
  }

  runTimers(limit = 20): void {
    for (let i = 0; i < limit; i += 1) {
      const timer = this.timerQueue.shift();
      if (!timer) return;
      if (!timer.active) continue;
      // Advance the virtual clock by the timer's delay so wall-clock pacing sees
      // deterministic time pass across synchronous `runTimers` bursts.
      this.virtualNowMs += timer.delay;
      if (!timer.interval) this.timers.delete(timer.id);
      timer.handler();
      if (timer.interval && timer.active) this.timerQueue.push(timer);
    }
  }

  private addTimer(handler: () => void, interval: boolean, delay: number): ReturnType<typeof setTimeout> {
    const timer = { id: this.nextTimerId++, handler, interval, active: true, delay };
    this.timers.set(timer.id, timer);
    this.timerQueue.push(timer);
    return timer.id as unknown as ReturnType<typeof setTimeout>;
  }

  private clearTimer(handle: ReturnType<typeof setTimeout>): void {
    const timer = this.timers.get(handle as unknown as number);
    if (!timer) return;
    timer.active = false;
    this.timers.delete(timer.id);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  scope: FakeWorkerScope,
  resolve: () => T | undefined,
  timeoutMessage: string,
): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    scope.runTimers();
    const found = resolve();
    if (found !== undefined) return found;
    await delay(5);
  }
  throw new Error(timeoutMessage);
}

async function waitForEvent<T extends AVRWorkerEvent["type"]>(
  scope: FakeWorkerScope,
  type: T,
  predicate: (event: Extract<AVRWorkerEvent, { type: T }>) => boolean = () => true,
): Promise<Extract<AVRWorkerEvent, { type: T }>> {
  return waitFor(
    scope,
    () =>
      scope.events.find(
      (event): event is Extract<AVRWorkerEvent, { type: T }> =>
        event.type === type && predicate(event as Extract<AVRWorkerEvent, { type: T }>),
      ),
    `timed out waiting for worker event ${type}`,
  );
}

async function waitForSerialText(scope: FakeWorkerScope, expected: string): Promise<{ text: string; events: Extract<AVRWorkerEvent, { type: "serial" }>[] }> {
  return waitFor(
    scope,
    () => {
      const events = scope.events.filter((event): event is Extract<AVRWorkerEvent, { type: "serial" }> => event.type === "serial");
      const text = events.map((event) => event.text).join("");
      return text.includes(expected) ? { text, events } : undefined;
    },
    `timed out waiting for serial text ${expected}`,
  );
}

describe("Phase 21 - browser worker runtime client", () => {
  test("posts typed commands and tracks status events", () => {
    const worker = new FakeClientWorker();
    const runtime = createAVRWorkerRuntime({ worker, speed: 1, hex: BLINK_HEX });

    runtime.start();
    runtime.setInput(2, true);
    runtime.setAnalog({ channel: 0, volts: 2.5 });
    runtime.watchData(PORTB);
    runtime.snapshot({ includeData: true });

    expect(worker.commands).toEqual([
      { type: "setSpeed", speed: 1 },
      { type: "loadHex", hex: BLINK_HEX },
      { type: "start" },
      { type: "setInput", pin: 2, high: true },
      { type: "setAnalog", channel: 0, volts: 2.5 },
      { type: "watchData", address: PORTB },
      { type: "snapshot", includeData: true },
    ]);

    worker.emit({
      type: "status",
      status: {
        running: true,
        paused: false,
        timeMs: 1,
        cycles: 16_000,
        speed: 1,
        chip: "atmega328p",
        clockHz: 16_000_000,
        programLoaded: true,
      },
    });

    expect(runtime.status()?.running).toBe(true);
    runtime.destroy();
    expect(worker.terminated).toBe(true);
  });
});

describe("Phase 21 - browser worker host", () => {
  for (const state of ["running", "paused", "stopped"] as const) {
    for (const restoreBy of ["payload", "id"] as const) {
      test(`${restoreBy} restore recovers worker speed and ${state} scheduling`, () => {
        const scope = new FakeWorkerScope();
        installAVRWorker(scope);
        scope.send({ type: "loadHex", hex: BLINK_HEX });
        scope.send({ type: "setSpeed", speed: 2 });
        if (state !== "stopped") scope.send({ type: "start" });
        if (state === "paused") scope.send({ type: "pause" });
        scope.send({ type: "snapshot", includeData: true });
        const saved = scope.events.findLast((event) => event.type === "snapshot")!;
        expect(saved.snapshot!.runtime.running).toBe(state !== "stopped");
        expect(saved.snapshot!.runtime.paused).toBe(state === "paused");
        expect(saved.snapshot!.runtime.speed).toBe(2);

        scope.send({ type: "setSpeed", speed: 0.5 });
        scope.send({ type: "start" }); // Restore over an already active pump.
        scope.send(restoreBy === "payload"
          ? { type: "restore", snapshot: saved.snapshot }
          : { type: "restore", snapshotId: saved.snapshotId });
        const restored = scope.events.findLast((event) => event.type === "status")!;
        expect(restored.status.speed).toBe(2);
        expect(restored.status.running).toBe(state !== "stopped");
        expect(restored.status.paused).toBe(state === "paused");
        expect(scope.activeTimerCount()).toBe(state === "running" ? 2 : state === "paused" ? 1 : 0);

        const before = restored.status.cycles;
        scope.runTimers(10);
        scope.send({ type: "readRegisters" });
        const registers = scope.events.findLast((event) => event.type === "registers")!;
        if (state === "running") expect(registers.cycles).toBeGreaterThan(before);
        else expect(registers.cycles).toBe(before);

        if (state === "paused") {
          scope.send({ type: "resume" });
          expect(scope.activeTimerCount()).toBe(2);
        }
        scope.send({ type: "stop" });
        expect(scope.activeTimerCount()).toBe(0);
      });
    }
  }

  test("restoring a running facade snapshot never starts a second host loop", () => {
    const scope = new FakeWorkerScope();
    installAVRWorker(scope);
    const snapshot = AVR(BLINK_HEX).snapshot();
    snapshot.runtime.running = true;
    snapshot.runtime.speed = "max";
    const interval = spyOn(globalThis, "setInterval").mockImplementation(() => {
      throw new Error("unexpected facade host loop");
    });
    try {
      scope.send({ type: "restore", snapshot });
      expect(interval).not.toHaveBeenCalled();
      expect(scope.events.some((event) => event.type === "error")).toBe(false);
      expect(scope.activeTimerCount()).toBe(2);
      scope.send({ type: "stop" });
      expect(scope.activeTimerCount()).toBe(0);
    } finally {
      interval.mockRestore();
    }
  });

  test("loads HEX, runs in chunks, emits frames, and stops", async () => {
    const scope = new FakeWorkerScope();
    installAVRWorker(scope);

    await waitForEvent(scope, "ready");
    scope.send({ type: "loadHex", hex: BLINK_HEX });
    scope.send({ type: "start" });

    const running = await waitForEvent(scope, "status", (event) => event.status.running);
    expect(running.status.paused).toBe(false);

    const frame = await waitForEvent(scope, "frame", (event) =>
      event.status.cycles > 0 && event.pins.some((pin) => pin.pin === 13),
    );
    expect(frame.status.cycles).toBeGreaterThan(0);
    expect(frame.pwm.some((pwm) => pwm.pin === 9)).toBe(true);

    scope.send({ type: "stop" });
    const stopped = await waitForEvent(scope, "status", (event) => !event.status.running);
    expect(stopped.status.paused).toBe(false);
  });

  test("digital and analog input commands update worker-owned AVR state", async () => {
    const scope = new FakeWorkerScope();
    installAVRWorker(scope);

    scope.send({ type: "setInput", pin: 2, high: true });
    const frame = await waitForEvent(scope, "frame", (event) =>
      event.pins.some((pin) => pin.pin === 2 && pin.high),
    );
    expect(frame.pins.find((pin) => pin.pin === 2)?.high).toBe(true);

    scope.send({ type: "setAnalog", channel: 0, volts: 2.5, referenceVolts: 5 });
    scope.send({ type: "snapshot", includeData: true });
    const snapshot = await waitForEvent(scope, "snapshot", (event) => event.snapshot !== undefined);

    expect(snapshot.snapshot!.adc.voltageEnabled[0]).toBe(1);
    expect(snapshot.snapshot!.adc.channelVoltages[0]).toBe(2.5);
  });

  test("serial output is batched before crossing the worker boundary", async () => {
    const scope = new FakeWorkerScope();
    installAVRWorker(scope);

    await waitForEvent(scope, "ready");
    scope.send({ type: "loadHex", hex: serialPrintHex });
    scope.send({ type: "setSpeed", speed: "max" });
    scope.send({ type: "start" });

    const serial = await waitForSerialText(scope, "hello avrts");

    expect(serial.text).toContain("hello avrts");
    expect(serial.events.some((event) => event.text.length > 1)).toBe(true);
  });

  test("watchData batches writes as watchFrame events", async () => {
    const scope = new FakeWorkerScope();
    installAVRWorker(scope);

    scope.send({ type: "watchData", address: PORTB });
    scope.send({ type: "loadHex", hex: BLINK_HEX });
    scope.send({ type: "start" });

    const watch = await waitForEvent(scope, "watchFrame", (event) =>
      event.events.some((frame) => frame.address === PORTB && frame.writes.length > 0),
    );
    expect(watch.events.find((frame) => frame.address === PORTB)!.writes.length).toBeGreaterThan(0);

    scope.send({ type: "stop" });
  });

  test("captureEdges emits exact (non-coalesced) edges as logicChunk", async () => {
    const scope = new FakeWorkerScope();
    installAVRWorker(scope);

    scope.send({ type: "loadHex", hex: TOGGLE_HEX });
    scope.send({ type: "captureEdges", pins: [13], id: "la1" });
    scope.send({ type: "start" });

    const chunkEvent = await waitForEvent(scope, "logicChunk", (event) => event.chunk.analyzerId === "la1");
    scope.send({ type: "stopCapture" });
    scope.send({ type: "stop" });

    const samples = decodeLogicChunk(chunkEvent.chunk).filter((s) => s.pin === 13);
    // Far more than one-per-frame: coalescing would collapse these to a single edge.
    expect(samples.length).toBeGreaterThan(5);
    // Strictly increasing cycles + alternating levels => exact edges preserved.
    const head = samples.slice(0, 32);
    const monotonic = head.every((s, i) => i === 0 || s.cycles > head[i - 1]!.cycles);
    const alternating = head.every((s, i) => i === 0 || s.high !== head[i - 1]!.high);
    expect(monotonic).toBe(true);
    expect(alternating).toBe(true);
  });

  test("readRegisters returns PC/SP/SREG/cycles and 32 registers for the debugger", async () => {
    const scope = new FakeWorkerScope();
    installAVRWorker(scope);

    scope.send({ type: "loadHex", hex: BLINK_HEX });
    scope.send({ type: "step" });
    scope.send({ type: "readRegisters" });

    const regs = await waitForEvent(scope, "registers");
    expect(regs.registers).toHaveLength(32);
    expect(typeof regs.pc).toBe("number");
    expect(regs.sreg).toBeGreaterThanOrEqual(0);
    expect(regs.sreg).toBeLessThanOrEqual(255);
    expect(regs.cycles).toBeGreaterThan(0);
  });

  test("restore uses payload first, snapshot id second, and errors for missing input", async () => {
    const scope = new FakeWorkerScope();
    installAVRWorker(scope);

    scope.send({ type: "loadHex", hex: BLINK_HEX });
    scope.send({ type: "snapshot", includeData: true });
    const snapEvent = await waitForEvent(scope, "snapshot", (event) => event.snapshot !== undefined);

    scope.send({ type: "step" });
    scope.send({ type: "restore", snapshot: snapEvent.snapshot });
    const restoredFromPayload = scope.events
      .filter((event): event is Extract<AVRWorkerEvent, { type: "status" }> => event.type === "status")
      .at(-1)!;
    expect(restoredFromPayload.status.cycles).toBe(snapEvent.snapshot!.cpu.cycles);

    scope.send({ type: "step" });
    scope.send({ type: "restore", snapshotId: snapEvent.snapshotId });
    const restoredFromId = scope.events
      .filter((event): event is Extract<AVRWorkerEvent, { type: "status" }> => event.type === "status")
      .at(-1)!;
    expect(restoredFromId.status.cycles).toBe(snapEvent.snapshot!.cpu.cycles);

    scope.send({ type: "restore" });
    const error = await waitForEvent(scope, "error", (event) =>
      event.message.includes("restore requires snapshot or snapshotId"),
    );
    expect(error.message).toContain("restore requires");
  });
});
