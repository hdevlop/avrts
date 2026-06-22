import { PIN_MAP } from "../peripherals";
import type { PortName } from "../peripherals";

/**
 * Board port catalog (Phase 21B).
 *
 * A "board port" is a wire target on the ATmega328P / Arduino Uno header. Each
 * port carries enough metadata for the circuit document to validate a
 * connection: its electrical kind, the AVR port/bit it maps to, whether it can
 * drive PWM, and (for analog) its ADC channel.
 *
 * Labels are chip-first internally (raw `PB5`) but the catalog also exposes the
 * familiar Arduino labels (`D13`, `A0`) the UI shows. Either resolves.
 */

export type BoardPortKind = "digital" | "analog" | "power";

export interface BoardPort {
  /** Friendly Arduino label, e.g. "D13" / "A0". For power pins, "5V" / "GND". */
  readonly label: string;
  /** Raw AVR label, e.g. "PB5" / "PC0". Undefined for power pins. */
  readonly rawLabel?: string;
  readonly kind: BoardPortKind;
  /** AVR port letter (digital/analog pins only). */
  readonly port?: PortName;
  /** Bit within the port (digital/analog pins only). */
  readonly bit?: number;
  /** Arduino digital pin number used by `avr.pin(...)`. */
  readonly pin?: number;
  /** ADC channel used by `avr.analog(...)` (analog pins only). */
  readonly channel?: number;
  /** True when a timer compare output can drive this pin (digital only). */
  readonly pwm: boolean;
}

/** Arduino pins with a timer compare (PWM) output. */
export const PWM_PINS: readonly number[] = [3, 5, 6, 9, 10, 11];

function digitalPort(pin: number): BoardPort {
  const info = PIN_MAP[pin]!;
  return {
    label: `D${pin}`,
    rawLabel: `P${info.port}${info.bit}`,
    kind: "digital",
    port: info.port,
    bit: info.bit,
    pin,
    pwm: PWM_PINS.includes(pin),
  };
}

function analogPort(channel: number): BoardPort {
  const pin = 14 + channel; // A0..A5 are digital pins 14..19
  const info = PIN_MAP[pin]!;
  return {
    label: `A${channel}`,
    rawLabel: `P${info.port}${info.bit}`,
    kind: "analog",
    port: info.port,
    bit: info.bit,
    pin,
    channel,
    pwm: false,
  };
}

const DIGITAL = Array.from({ length: 14 }, (_, pin) => digitalPort(pin)); // D0..D13
const ANALOG = Array.from({ length: 6 }, (_, channel) => analogPort(channel)); // A0..A5
const POWER: BoardPort[] = [
  { label: "5V", kind: "power", pwm: false },
  { label: "GND", kind: "power", pwm: false },
];

/** Every wire-addressable port on the board. */
export const BOARD_PORTS: readonly BoardPort[] = [...DIGITAL, ...ANALOG, ...POWER];

const BY_LABEL = new Map<string, BoardPort>();
for (const port of BOARD_PORTS) {
  BY_LABEL.set(port.label.toUpperCase(), port);
  if (port.rawLabel) BY_LABEL.set(port.rawLabel.toUpperCase(), port);
}

/** Resolve a friendly (`D13`) or raw (`PB5`) board-port label, or undefined. */
export function resolveBoardPort(label: string): BoardPort | undefined {
  return BY_LABEL.get(label.trim().toUpperCase());
}

/** True when `label` names a real board port. */
export function isBoardPort(label: string): boolean {
  return BY_LABEL.has(label.trim().toUpperCase());
}
