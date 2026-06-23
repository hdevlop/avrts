import { describe, expect, test } from "bun:test";
import {
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

class FakeWorkerScope implements WorkerScopeLike {
  readonly events: AVRWorkerEvent[] = [];
  onmessage: ((event: MessageEvent<AVRWorkerCommand>) => void) | null = null;

  postMessage(message: AVRWorkerEvent): void {
    this.events.push(message);
  }

  send(command: AVRWorkerCommand): void {
    this.onmessage?.({ data: command } as MessageEvent<AVRWorkerCommand>);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent<T extends AVRWorkerEvent["type"]>(
  scope: FakeWorkerScope,
  type: T,
  predicate: (event: Extract<AVRWorkerEvent, { type: T }>) => boolean = () => true,
): Promise<Extract<AVRWorkerEvent, { type: T }>> {
  for (let i = 0; i < 80; i += 1) {
    const found = scope.events.find(
      (event): event is Extract<AVRWorkerEvent, { type: T }> =>
        event.type === type && predicate(event as Extract<AVRWorkerEvent, { type: T }>),
    );
    if (found) return found;
    await delay(5);
  }
  throw new Error(`timed out waiting for worker event ${type}`);
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
    scope.send({ type: "start" });

    const serial = await waitForEvent(scope, "serial", (event) => event.text.includes("hello avrts"));

    expect(serial.text.length).toBeGreaterThan(1);
    expect(serial.text).toContain("hello avrts");
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
