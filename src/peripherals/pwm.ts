import type { CPU } from "../cpu";
import type { PwmChannel, PwmSignal } from "./types";

/**
 * What a timer needs to expose so the shared PWM reader can describe its output.
 * COM bits live at the same positions on every ATmega328P timer (A = 7:6,
 * B = 5:4 of TCCRnA), so only the registers, the WGMn2 bit, and the resolution
 * differ between Timer0/1/2.
 */
export interface PwmConfig {
  /** TCCRnA — holds COM bits and the low two WGM bits. */
  tccrA: number;
  /** TCCRnB — holds WGMn2 (and WGMn3 on Timer1, ignored here). */
  tccrB: number;
  /** Bit position of WGMn2 within TCCRnB. */
  wgm2Bit: number;
  /** Duty denominator: 255 for the 8-bit PWM modes analogWrite uses. */
  max: number;
  /** Optional dynamic TOP for variable-resolution PWM modes. */
  topValue?: () => number;
  /** Optional timer-specific WGM decoder. */
  mode?: () => PwmSignal["mode"];
  /** Resolve the compare value (OCRnx) for a channel — 16-bit on Timer1. */
  ocrValue(channel: PwmChannel): number;
}

/** Describe a timer channel's PWM output from its current register state. */
export function pwmSignal(cpu: CPU, config: PwmConfig, channel: PwmChannel): PwmSignal {
  const mode = config.mode?.() ?? pwmMode(cpu, config);
  const value = config.ocrValue(channel);
  const compareMode = compareOutputMode(cpu, config.tccrA, channel);
  const active = (mode === "fast-pwm" || mode === "phase-correct-pwm") && compareMode >= 2;
  const inverted = compareMode === 3;
  const top = config.topValue?.() ?? config.max;
  const rawDuty = active && top > 0 ? Math.min(1, value / top) : 0;

  return {
    channel,
    enabled: active,
    inverted,
    duty: active ? (inverted ? 1 - rawDuty : rawDuty) : 0,
    value,
    mode: active ? mode : mode === "off" ? "off" : "other",
  };
}

/** Broadcasts per-channel PWM-change notifications to subscribers. */
export class PwmBroadcaster {
  private readonly listeners = new Set<(channel: PwmChannel, signal: PwmSignal) => void>();

  on(channel: PwmChannel, listener: (signal: PwmSignal) => void): () => void {
    const wrapped = (changed: PwmChannel, signal: PwmSignal) => {
      if (changed === channel) listener(signal);
    };
    this.listeners.add(wrapped);
    return () => {
      this.listeners.delete(wrapped);
    };
  }

  emit(channel: PwmChannel, signal: PwmSignal): void {
    for (const listener of [...this.listeners]) listener(channel, signal);
  }
}

/** COM bits: channel A at TCCRnA[7:6], channel B at TCCRnA[5:4]. */
function compareOutputMode(cpu: CPU, tccrA: number, channel: PwmChannel): number {
  const value = cpu.readData(tccrA);
  return channel === "A" ? (value >> 6) & 0b11 : (value >> 4) & 0b11;
}

function pwmMode(cpu: CPU, config: PwmConfig): PwmSignal["mode"] {
  const low = cpu.readData(config.tccrA) & 0b11; // WGMn1:0
  const wgm2 = (cpu.readData(config.tccrB) >> config.wgm2Bit) & 1; // WGMn2
  const bits = (wgm2 << 2) | low;
  if (bits === 0b000) return "off";
  if (bits === 0b001) return "phase-correct-pwm";
  if (bits === 0b011) return "fast-pwm";
  return "other";
}
