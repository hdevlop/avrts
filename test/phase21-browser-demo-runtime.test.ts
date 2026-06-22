import { describe, expect, test } from "bun:test";
import {
  createLocalSimulatorRuntime,
  wrapWorkerSimulatorRuntime,
  type SimulatorSnapshot,
} from "../examples/browser-simulator/src/runtime";
import {
  AVR,
  type AVRWorkerCommand,
  type AVRWorkerEvent,
  type AVRWorkerRuntime,
  type AVRWorkerEventHandler,
  type AVRWorkerEventType,
  type AVRSpeed,
  type AVRSnapshot,
} from "../src";

const BLINK_HEX = ":0E00000000E204B900E205B900E005B9FFCF47\n:00000001FF\n";

class FakeWorkerRuntime implements AVRWorkerRuntime {
  readonly worker = { postMessage: () => {} };
  readonly commands: AVRWorkerCommand[] = [];
  private readonly listeners = new Map<AVRWorkerEventType, Set<AVRWorkerEventHandler>>();

  start(): void {
    this.commands.push({ type: "start" });
  }
  pause(): void {
    this.commands.push({ type: "pause" });
  }
  resume(): void {
    this.commands.push({ type: "resume" });
  }
  stop(): void {
    this.commands.push({ type: "stop" });
  }
  reset(): void {
    this.commands.push({ type: "reset" });
  }
  setSpeed(speed: AVRSpeed): void {
    this.commands.push({ type: "setSpeed", speed });
  }
  loadHex(hex: string): void {
    this.commands.push({ type: "loadHex", hex });
  }
  setInput(pin: number, high: boolean): void {
    this.commands.push({ type: "setInput", pin, high });
  }
  setAnalog(): void {
    throw new Error("not used");
  }
  serialWrite(text: string): void {
    this.commands.push({ type: "serialWrite", text });
  }
  snapshot(options: { includeData?: boolean } = {}): void {
    this.commands.push({ type: "snapshot", includeData: options.includeData });
  }
  restore(input: { snapshotId?: string; snapshot?: AVRSnapshot }): void {
    this.commands.push({ type: "restore", ...input });
  }
  deleteSnapshot(snapshotId: string): void {
    this.commands.push({ type: "deleteSnapshot", snapshotId });
  }
  step(): void {
    this.commands.push({ type: "step" });
  }
  setBreakpoint(pc: number): void {
    this.commands.push({ type: "setBreakpoint", pc });
  }
  clearBreakpoint(pc: number): void {
    this.commands.push({ type: "clearBreakpoint", pc });
  }
  clearBreakpoints(): void {
    this.commands.push({ type: "clearBreakpoints" });
  }
  watchData(address: number): void {
    this.commands.push({ type: "watchData", address });
  }
  unwatchData(address: number): void {
    this.commands.push({ type: "unwatchData", address });
  }
  pauseOnUnknownOpcode(enabled: boolean): void {
    this.commands.push({ type: "pauseOnUnknownOpcode", enabled });
  }
  captureEdges(pins: number[], id?: string): void {
    this.commands.push({ type: "captureEdges", pins, id });
  }
  stopCapture(): void {
    this.commands.push({ type: "stopCapture" });
  }
  readRegisters(): void {
    this.commands.push({ type: "readRegisters" });
  }
  status(): null {
    return null;
  }
  on<T extends AVRWorkerEventType>(type: T, handler: AVRWorkerEventHandler<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler as unknown as AVRWorkerEventHandler);
    return () => set?.delete(handler as unknown as AVRWorkerEventHandler);
  }
  destroy(): void {
    this.listeners.clear();
  }
  emit(event: AVRWorkerEvent): void {
    const listeners = this.listeners.get(event.type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      (listener as AVRWorkerEventHandler<typeof event.type>)(event as never);
    }
  }
}

describe("Phase 21 - browser demo runtime adapter", () => {
  test("local runtime mirrors the existing AVR facade for components", async () => {
    const avr = AVR(BLINK_HEX);
    const runtime = createLocalSimulatorRuntime(avr);
    const seen: boolean[] = [];

    runtime.onPinChange(2, (high) => seen.push(high));
    runtime.setInput(2, true);
    runtime.setInput(2, false);

    expect(seen).toEqual([true, false]);
    expect(runtime.readPin(2)).toBe(false);

    const snapshot = await runtime.snapshot();
    const cycles = runtime.status().cycles;
    runtime.step();
    await runtime.restore(snapshot);
    expect(runtime.status().cycles).toBe(cycles);

    runtime.destroy();
  });

  test("worker runtime consumes frame events and sends UI commands", async () => {
    const worker = new FakeWorkerRuntime();
    const runtime = wrapWorkerSimulatorRuntime(worker);
    const pins: boolean[] = [];
    const pwm: number[] = [];
    const serial: string[] = [];

    runtime.onPinChange(13, (high) => pins.push(high));
    runtime.onPwmChange(9, (signal) => pwm.push(signal.duty));
    runtime.onSerialText((text) => serial.push(text));

    runtime.start();
    runtime.setInput(2, true);
    runtime.serialWrite("A");

    worker.emit({
      type: "frame",
      pins: [{ pin: 13, high: true, port: "B", bit: 5, cycles: 10, timeMs: 0.001 }],
      pwm: [{
        pin: 9,
        channel: "A",
        enabled: true,
        inverted: false,
        duty: 0.5,
        value: 128,
        mode: "fast-pwm",
      }],
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
    worker.emit({ type: "serial", text: "hello" });

    expect(runtime.readPin(13)).toBe(true);
    expect(runtime.readPwm(9).duty).toBe(0.5);
    expect(runtime.serialText()).toBe("hello");
    expect(pins).toEqual([true]);
    expect(pwm).toEqual([0.5]);
    expect(serial).toEqual(["hello"]);
    expect(worker.commands.slice(0, 3)).toEqual([
      { type: "start" },
      { type: "setInput", pin: 2, high: true },
      { type: "serialWrite", text: "A" },
    ]);

    const snapshotPromise = runtime.snapshot();
    worker.emit({ type: "snapshot", snapshotId: "snapshot-1" });
    await runtime.restore(await snapshotPromise);
    expect(worker.commands.at(-1)).toEqual({ type: "restore", snapshotId: "snapshot-1" });

    runtime.destroy();
  });
});
