import { describe, expect, test } from "bun:test";
import {
  BOARD_PORTS,
  createCircuit,
  resolveBoardPort,
  validateConnection,
  type AVRCircuitDocument,
} from "../src";

/**
 * Phase 21B - circuit document + board-port catalog.
 */

describe("board-port catalog", () => {
  test("resolves friendly and raw digital labels", () => {
    const d13 = resolveBoardPort("D13");
    expect(d13).toMatchObject({ label: "D13", rawLabel: "PB5", kind: "digital", pin: 13, pwm: false });
    expect(resolveBoardPort("pb5")).toBe(d13!); // case-insensitive + raw label
  });

  test("marks PWM pins and analog channels", () => {
    expect(resolveBoardPort("D9")!.pwm).toBe(true);
    expect(resolveBoardPort("D8")!.pwm).toBe(false);
    expect(resolveBoardPort("A0")).toMatchObject({ kind: "analog", channel: 0, pin: 14 });
  });

  test("has 14 digital + 6 analog + 2 power ports", () => {
    expect(BOARD_PORTS.filter((p) => p.kind === "digital")).toHaveLength(14);
    expect(BOARD_PORTS.filter((p) => p.kind === "analog")).toHaveLength(6);
    expect(BOARD_PORTS.filter((p) => p.kind === "power")).toHaveLength(2);
    expect(resolveBoardPort("D99")).toBeUndefined();
  });
});

function newCircuit() {
  const circuit = createCircuit();
  circuit.addPart({ id: "board1", type: "board", x: 0, y: 0 });
  circuit.addPart({ id: "led1", type: "led", x: 100, y: 0 });
  circuit.addPart({ id: "btn1", type: "button", x: 200, y: 0 });
  circuit.addPart({ id: "pot1", type: "potentiometer", x: 300, y: 0 });
  circuit.addInstrument({ id: "pwm1", type: "pwm-meter", x: 400, y: 0 });
  circuit.addInstrument({ id: "logic1", type: "logic-analyzer", x: 500, y: 0, attrs: { pins: [13] } });
  return circuit;
}

const led = (port = "anode") => ({ part: "led1", port });
const board = (port: string) => ({ part: "board1", port });

describe("circuit document model", () => {
  test("empty circuit has a default atmega328p runtime", () => {
    const doc = createCircuit().toJSON();
    expect(doc.version).toBe(1);
    expect(doc.runtime.chip).toBe("atmega328p");
    expect(doc.runtime.clockHz).toBeGreaterThan(0);
    expect(doc.parts).toEqual([]);
  });

  test("rejects an unsupported document version", () => {
    expect(() => createCircuit({ version: 2 } as unknown as AVRCircuitDocument)).toThrow(/version/);
  });

  test("a valid digital-sink connection is recorded", () => {
    const circuit = newCircuit();
    expect(circuit.connect(led(), board("D13"))).toEqual({ ok: true });
    expect(circuit.wires()).toHaveLength(1);
  });

  test("connection order does not matter", () => {
    const circuit = newCircuit();
    expect(circuit.connect(board("D13"), led())).toEqual({ ok: true });
  });

  test("digital sink cannot bind to an analog pin", () => {
    const circuit = newCircuit();
    const result = circuit.connect(led(), board("A0"));
    expect(result).toEqual({ ok: false, reason: "A0 is not a digital pin" });
    expect(circuit.wires()).toHaveLength(0);
  });

  test("PWM meter requires a PWM pin", () => {
    const circuit = newCircuit();
    expect(circuit.connect({ part: "pwm1", port: "input" }, board("D13"))).toMatchObject({ ok: false });
    expect(circuit.connect({ part: "pwm1", port: "input" }, board("D9"))).toEqual({ ok: true });
  });

  test("potentiometer wiper requires an analog pin", () => {
    const circuit = newCircuit();
    expect(circuit.connect({ part: "pot1", port: "wiper" }, board("D2"))).toMatchObject({ ok: false });
    expect(circuit.connect({ part: "pot1", port: "wiper" }, board("A0"))).toEqual({ ok: true });
  });

  test("two sources cannot drive the same pin", () => {
    const circuit = newCircuit();
    circuit.addPart({ id: "btn2", type: "button", x: 250, y: 0 });
    expect(circuit.connect({ part: "btn1", port: "signal" }, board("D2"))).toEqual({ ok: true });
    const clash = circuit.connect({ part: "btn2", port: "signal" }, board("D2"));
    expect(clash).toEqual({ ok: false, reason: "D2 is already driven by a source" });
  });

  test("a sink and a probe may share a pin", () => {
    const circuit = newCircuit();
    expect(circuit.connect(led(), board("D13"))).toEqual({ ok: true });
    expect(circuit.connect({ part: "logic1", port: "probe0" }, board("D13"))).toEqual({ ok: true });
  });

  test("a component port holds at most one wire", () => {
    const circuit = newCircuit();
    expect(circuit.connect(led(), board("D13"))).toEqual({ ok: true });
    expect(circuit.connect(led(), board("D12"))).toMatchObject({ ok: false });
  });

  test("reconnecting the same wire is rejected (port already wired)", () => {
    const circuit = newCircuit();
    circuit.connect(led(), board("D13"));
    const again = circuit.connect(led(), board("D13"));
    expect(again.ok).toBe(false);
    expect(again).toMatchObject({ reason: expect.stringContaining("already wired") });
  });

  test("power ports validate against 5V / GND", () => {
    const circuit = newCircuit();
    expect(circuit.connect({ part: "led1", port: "cathode" }, board("GND"))).toEqual({ ok: true });
    expect(circuit.connect({ part: "btn1", port: "gnd" }, board("5V"))).toMatchObject({ ok: false });
  });

  test("rejects unknown parts, ports, self-wires and board-to-board", () => {
    const circuit = newCircuit();
    expect(circuit.connect(led(), { part: "nope", port: "D1" })).toMatchObject({ ok: false });
    expect(circuit.connect({ part: "led1", port: "leg99" }, board("D1"))).toMatchObject({ ok: false });
    expect(circuit.connect(led(), led())).toMatchObject({ ok: false });
    expect(circuit.connect(board("D1"), board("D2"))).toMatchObject({ ok: false });
  });

  test("canConnect / validateConnection do not mutate the circuit", () => {
    const circuit = newCircuit();
    expect(circuit.canConnect(led(), board("D13")).ok).toBe(true);
    expect(validateConnection(circuit, led(), board("D13")).ok).toBe(true);
    expect(circuit.wires()).toHaveLength(0);
  });

  test("disconnect removes a wire", () => {
    const circuit = newCircuit();
    circuit.connect(led(), board("D13"));
    expect(circuit.disconnect(led(), board("D13"))).toBe(true);
    expect(circuit.wires()).toHaveLength(0);
    expect(circuit.disconnect(led(), board("D13"))).toBe(false);
  });

  test("removeNode drops the node and its wires", () => {
    const circuit = newCircuit();
    circuit.connect(led(), board("D13"));
    expect(circuit.removeNode("led1")).toBe(true);
    expect(circuit.findNode("led1")).toBeUndefined();
    expect(circuit.wires()).toHaveLength(0);
  });

  test("moveNode updates position", () => {
    const circuit = newCircuit();
    expect(circuit.moveNode("led1", 42, 84)).toBe(true);
    expect(circuit.findNode("led1")).toMatchObject({ x: 42, y: 84 });
  });

  test("addPart rejects duplicate ids", () => {
    const circuit = newCircuit();
    expect(() => circuit.addPart({ id: "led1", type: "led", x: 0, y: 0 })).toThrow(/Duplicate/);
  });
});

describe("import / export round-trip", () => {
  test("import builds parts, instruments, and wires", () => {
    const doc: AVRCircuitDocument = {
      version: 1,
      runtime: { chip: "atmega328p", clockHz: 16_000_000, speed: 1 },
      program: { name: "blink" },
      parts: [
        { id: "board1", type: "board", x: 0, y: 0 },
        { id: "led1", type: "led", x: 100, y: 0 },
      ],
      instruments: [{ id: "serial1", type: "serial", x: 0, y: 200 }],
      wires: [{ from: { part: "led1", port: "anode" }, to: { part: "board1", port: "D13" } }],
    };
    const circuit = createCircuit(doc);
    expect(circuit.parts()).toHaveLength(2);
    expect(circuit.instruments()).toHaveLength(1);
    expect(circuit.wires()).toHaveLength(1);
  });

  test("export preserves positions and exact endpoint ports", () => {
    const circuit = newCircuit();
    circuit.moveNode("led1", 7, 9);
    circuit.connect(led(), board("D13"));
    const doc = circuit.toJSON();

    expect(doc.parts.find((p) => p.id === "led1")).toMatchObject({ x: 7, y: 9 });
    expect(doc.wires[0]).toEqual({
      from: { part: "led1", port: "anode" },
      to: { part: "board1", port: "D13" },
    });

    // Re-importing the exported document reproduces the same wiring.
    const reimported = createCircuit(doc);
    expect(reimported.wires()).toEqual(circuit.wires());
  });
});
