import type { AVRSpeed } from "../avr";

/**
 * Circuit document types (Phase 21B). A circuit document is the serializable,
 * structured-clone-friendly description of a simulator layout: runtime config,
 * the loaded program, placed parts/instruments, and functional wires between
 * named ports.
 */

/** One end of a wire: a node id plus a named port on that node. */
export interface CircuitEndpoint {
  part: string;
  port: string;
}

export type CircuitPartType = "board" | "led" | "button" | "potentiometer";

export type CircuitInstrumentType =
  | "serial"
  | "logic-analyzer"
  | "pwm-meter"
  | "scope"
  | "debugger";

export interface CircuitNode<TType extends string> {
  id: string;
  type: TType;
  x: number;
  y: number;
  attrs?: Record<string, unknown>;
}

export interface CircuitWire {
  from: CircuitEndpoint;
  to: CircuitEndpoint;
}

export interface AVRCircuitDocument {
  version: 1;
  runtime: {
    chip: "atmega328p";
    clockHz: number;
    speed?: AVRSpeed;
  };
  program?: {
    hex?: string;
    name?: string;
  };
  parts: Array<CircuitNode<CircuitPartType>>;
  instruments?: Array<CircuitNode<CircuitInstrumentType>>;
  wires: CircuitWire[];
}

/** Result of attempting a connection; failures always carry an explicit reason. */
export type ConnectResult = { ok: true } | { ok: false; reason: string };

/**
 * Electrical role of a component port. Drives validation against board-port
 * kinds (digital / analog / power / pwm) and source exclusivity.
 */
export type ComponentPortRole =
  | "digital-sink" // consumes a digital pin's output (LED anode)
  | "digital-source" // drives a digital pin input (button)
  | "analog-source" // drives an ADC channel (potentiometer wiper)
  | "pwm-in" // reads a PWM-capable output (PWM meter)
  | "probe" // observes a digital pin (logic analyzer / scope)
  | "power-vcc"
  | "power-gnd";

export interface ComponentPortSpec {
  name: string;
  role: ComponentPortRole;
}
