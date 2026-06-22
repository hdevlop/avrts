import { DEFAULT_CLOCK_HZ } from "../cpu";
import { resolveBoardPort } from "./board-ports";
import type { BoardPort } from "./board-ports";
import type {
  AVRCircuitDocument,
  CircuitEndpoint,
  CircuitInstrumentType,
  CircuitNode,
  CircuitPartType,
  CircuitWire,
  ComponentPortRole,
  ComponentPortSpec,
  ConnectResult,
} from "./types";

/**
 * Circuit document model (Phase 21B).
 *
 * `createCircuit` builds a mutable model from an optional document; `toJSON`
 * serializes it back. `connect` runs `validateConnection` first and only records
 * a wire when the result is `{ ok: true }`, so an invalid drag never mutates the
 * document — the UI can show the reason and keep the previous wiring.
 */

type AnyNode = CircuitNode<CircuitPartType | CircuitInstrumentType>;

const ok: ConnectResult = { ok: true };
const fail = (reason: string): ConnectResult => ({ ok: false, reason });

/** Component port specs by part/instrument type (board ports come from the catalog). */
function componentPorts(node: AnyNode): ComponentPortSpec[] {
  switch (node.type) {
    case "led":
      return [
        { name: "anode", role: "digital-sink" },
        { name: "cathode", role: "power-gnd" },
      ];
    case "button":
      return [
        { name: "signal", role: "digital-source" },
        { name: "gnd", role: "power-gnd" },
      ];
    case "potentiometer":
      return [
        { name: "wiper", role: "analog-source" },
        { name: "vcc", role: "power-vcc" },
        { name: "gnd", role: "power-gnd" },
      ];
    case "pwm-meter":
      return [{ name: "input", role: "pwm-in" }];
    case "scope":
      return [{ name: "input", role: "probe" }];
    case "logic-analyzer": {
      const pins = Array.isArray(node.attrs?.["pins"]) ? (node.attrs!["pins"] as unknown[]) : [];
      return pins.map((_, index) => ({ name: `probe${index}`, role: "probe" as const }));
    }
    default:
      // board / serial / debugger expose no wireable component ports here.
      return [];
  }
}

/** A resolved wire endpoint: either a board port or a component port. */
type ResolvedEndpoint =
  | { kind: "board"; board: BoardPort }
  | { kind: "component"; role: ComponentPortRole };

function endpointEquals(a: CircuitEndpoint, b: CircuitEndpoint): boolean {
  return a.part === b.part && a.port === b.port;
}

function wireMatches(wire: CircuitWire, from: CircuitEndpoint, to: CircuitEndpoint): boolean {
  return (
    (endpointEquals(wire.from, from) && endpointEquals(wire.to, to)) ||
    (endpointEquals(wire.from, to) && endpointEquals(wire.to, from))
  );
}

function roleNeedsSource(role: ComponentPortRole): boolean {
  return role === "digital-source" || role === "analog-source";
}

/** Check a component-port role against the board port it targets. */
function roleFitsBoard(role: ComponentPortRole, board: BoardPort): ConnectResult {
  switch (role) {
    case "digital-sink":
    case "digital-source":
    case "probe":
      return board.kind === "digital" ? ok : fail(`${board.label} is not a digital pin`);
    case "analog-source":
      return board.kind === "analog" ? ok : fail(`${board.label} is not an analog pin`);
    case "pwm-in":
      return board.kind === "digital" && board.pwm ? ok : fail(`${board.label} is not a PWM pin`);
    case "power-vcc":
      return board.label === "5V" ? ok : fail(`vcc must connect to 5V, not ${board.label}`);
    case "power-gnd":
      return board.label === "GND" ? ok : fail(`gnd must connect to GND, not ${board.label}`);
  }
}

export interface CircuitModel {
  addPart(node: CircuitNode<CircuitPartType>): void;
  addInstrument(node: CircuitNode<CircuitInstrumentType>): void;
  removeNode(id: string): boolean;
  moveNode(id: string, x: number, y: number): boolean;
  findNode(id: string): AnyNode | undefined;
  /** Validate without mutating (for hover highlighting). */
  canConnect(from: CircuitEndpoint, to: CircuitEndpoint): ConnectResult;
  /** Validate and, if valid, record the wire. */
  connect(from: CircuitEndpoint, to: CircuitEndpoint): ConnectResult;
  disconnect(from: CircuitEndpoint, to: CircuitEndpoint): boolean;
  parts(): ReadonlyArray<CircuitNode<CircuitPartType>>;
  instruments(): ReadonlyArray<CircuitNode<CircuitInstrumentType>>;
  wires(): ReadonlyArray<CircuitWire>;
  toJSON(): AVRCircuitDocument;
}

export function createCircuit(doc?: AVRCircuitDocument): CircuitModel {
  if (doc && doc.version !== 1) {
    throw new Error(`Unsupported circuit document version: ${doc.version}`);
  }

  const runtime = doc?.runtime ?? { chip: "atmega328p" as const, clockHz: DEFAULT_CLOCK_HZ };
  const program = doc?.program ? { ...doc.program } : undefined;
  const parts: Array<CircuitNode<CircuitPartType>> = (doc?.parts ?? []).map((n) => ({ ...n }));
  const instruments: Array<CircuitNode<CircuitInstrumentType>> = (doc?.instruments ?? []).map((n) => ({ ...n }));
  // A persisted document is trusted: load its wires verbatim so import/export
  // round-trips. New connections still go through `validate`.
  const wires: CircuitWire[] = (doc?.wires ?? []).map((w) => ({ from: { ...w.from }, to: { ...w.to } }));

  const allNodes = (): AnyNode[] => [...parts, ...instruments];
  const findNode = (id: string): AnyNode | undefined => allNodes().find((n) => n.id === id);

  const assertUniqueId = (id: string): void => {
    if (findNode(id)) throw new Error(`Duplicate node id: ${id}`);
  };

  const resolveEndpoint = (endpoint: CircuitEndpoint): ResolvedEndpoint | ConnectResult => {
    const node = findNode(endpoint.part);
    if (!node) return fail(`unknown part: ${endpoint.part}`);
    if (node.type === "board") {
      const board = resolveBoardPort(endpoint.port);
      return board ? { kind: "board", board } : fail(`unknown board port: ${endpoint.port}`);
    }
    const spec = componentPorts(node).find((p) => p.name === endpoint.port);
    return spec
      ? { kind: "component", role: spec.role }
      : fail(`unknown port "${endpoint.port}" on ${endpoint.part}`);
  };

  const isFail = (value: ResolvedEndpoint | ConnectResult): value is ConnectResult =>
    "ok" in value;

  const validate = (from: CircuitEndpoint, to: CircuitEndpoint): ConnectResult => {
    if (endpointEquals(from, to)) return fail("cannot wire a port to itself");

    const a = resolveEndpoint(from);
    if (isFail(a)) return a;
    const b = resolveEndpoint(to);
    if (isFail(b)) return b;

    // Exactly one board endpoint and one component endpoint.
    const board = a.kind === "board" ? a : b.kind === "board" ? b : null;
    const comp = a.kind === "component" ? a : b.kind === "component" ? b : null;
    if (!board || !comp) {
      return fail("a wire must connect a component port to a board pin");
    }
    const boardEndpoint = a.kind === "board" ? from : to;
    const compEndpoint = a.kind === "component" ? from : to;

    const fit = roleFitsBoard(comp.role, board.board);
    if (!fit.ok) return fit;

    // A component port carries at most one wire (this also subsumes duplicates,
    // since a duplicate wire reuses the same component port).
    if (wires.some((w) => endpointEquals(w.from, compEndpoint) || endpointEquals(w.to, compEndpoint))) {
      return fail(`port "${compEndpoint.port}" on ${compEndpoint.part} is already wired`);
    }

    // One source per board pin (sinks/probes may share).
    if (roleNeedsSource(comp.role)) {
      const clash = wires.some((w) => {
        const other = endpointEquals(w.from, boardEndpoint)
          ? w.to
          : endpointEquals(w.to, boardEndpoint)
            ? w.from
            : null;
        if (!other) return false;
        const resolved = resolveEndpoint(other);
        return !isFail(resolved) && resolved.kind === "component" && roleNeedsSource(resolved.role);
      });
      if (clash) return fail(`${board.board.label} is already driven by a source`);
    }

    return ok;
  };

  return {
    addPart(node) {
      assertUniqueId(node.id);
      parts.push({ ...node });
    },
    addInstrument(node) {
      assertUniqueId(node.id);
      instruments.push({ ...node });
    },
    removeNode(id) {
      const before = parts.length + instruments.length;
      for (const list of [parts, instruments]) {
        const index = list.findIndex((n) => n.id === id);
        if (index >= 0) list.splice(index, 1);
      }
      // Drop wires touching the removed node.
      for (let i = wires.length - 1; i >= 0; i -= 1) {
        if (wires[i]!.from.part === id || wires[i]!.to.part === id) wires.splice(i, 1);
      }
      return parts.length + instruments.length < before;
    },
    moveNode(id, x, y) {
      const node = findNode(id);
      if (!node) return false;
      node.x = x;
      node.y = y;
      return true;
    },
    findNode,
    canConnect: validate,
    connect(from, to) {
      const result = validate(from, to);
      if (result.ok) wires.push({ from: { ...from }, to: { ...to } });
      return result;
    },
    disconnect(from, to) {
      const index = wires.findIndex((w) => wireMatches(w, from, to));
      if (index < 0) return false;
      wires.splice(index, 1);
      return true;
    },
    parts: () => parts,
    instruments: () => instruments,
    wires: () => wires,
    toJSON: () => ({
      version: 1,
      runtime: { ...runtime },
      ...(program ? { program: { ...program } } : {}),
      parts: parts.map((n) => ({ ...n })),
      ...(instruments.length > 0 ? { instruments: instruments.map((n) => ({ ...n })) } : {}),
      wires: wires.map((w) => ({ from: { ...w.from }, to: { ...w.to } })),
    }),
  };
}

/** Standalone validation (no mutation) against an existing model. */
export function validateConnection(
  circuit: CircuitModel,
  from: CircuitEndpoint,
  to: CircuitEndpoint,
): ConnectResult {
  return circuit.canConnect(from, to);
}
