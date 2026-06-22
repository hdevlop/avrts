import type { CPU } from "./cpu";

/** Handler for one decoded AVR instruction (Phase 2 wires these via @Op). */
export type InstructionHandler = (cpu: CPU, opcode: number) => void;

/** The eight status-register flags, in bit order C(0)..I(7). */
export type FlagName = "C" | "Z" | "N" | "V" | "S" | "H" | "T" | "I";

/** Per-instruction trace record emitted to `cpu.onTrace` listeners. */
export interface TraceState {
  /** Program-counter word index of the executed instruction. */
  pc: number;
  /** Raw 16-bit opcode. */
  opcode: number;
  /** Decoded mnemonic, e.g. "ADD". */
  mnemonic: string;
  /** Cumulative cycle count after execution. */
  cycles: number;
}

export type TraceListener = (state: TraceState) => void;

/**
 * Peripheral write hook: runs right after a hooked data-space address is written.
 * Receives the new and previous values (oldValue matters for write-1-to-clear).
 */
export type IoWriteHook = (cpu: CPU, addr: number, value: number, oldValue: number) => void;

/**
 * Peripheral read hook: runs when a hooked data-space address is read. Returns
 * the byte to deliver to the reader (e.g. the next RX byte, or a port's effective
 * pin levels). Returning `undefined` keeps the currently stored value.
 */
export type IoReadHook = (cpu: CPU, addr: number) => number | undefined;

/** Runs after each instruction with the number of cycles that instruction consumed. */
export type CycleListener = (cycles: number, cpu: CPU) => void;

export interface PendingInterrupt {
  vector: number;
  acknowledge?: () => void;
}

/** Rebuilds non-serializable interrupt acknowledge callbacks during restore. */
export type InterruptAcknowledgeResolver = (vector: number) => (() => void) | undefined;

/**
 * Something that can decode + execute one opcode against a CPU. The CPU depends
 * on this interface (not the concrete Decoder) so the modules stay acyclic — the
 * Decoder is injected via `cpu.setExecutor(...)`.
 */
export interface Executor {
  execute(cpu: CPU, opcode: number): void;
  mnemonicOf(opcode: number): string | undefined;
}
