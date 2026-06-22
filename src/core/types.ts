/**
 * Registry metadata for the decorator-driven dispatch (see docs/03-coding-style.md).
 * This module stays decoupled from CPU/peripherals — it only describes *what* was
 * registered, never *how* it runs.
 */

/** One @Op-decorated instruction: its bit-pattern + the method that implements it. */
export interface OpEntry {
  mnemonic: string;
  /** Which bits of the 16-bit opcode are fixed. */
  mask: number;
  /** The required value of the fixed bits: matches when `(opcode & mask) === pattern`. */
  pattern: number;
  /** 1- or 2-word (32-bit) instruction. */
  words: 1 | 2;
  /** Method name on the decorated class (resolved + bound when the table is built). */
  key: string;
}

/** One @OnWrite-decorated peripheral hook: a data-space address + the method name. */
export interface IoHookEntry {
  /** Data-space address whose writes trigger this hook (e.g. PORTB = 0x25). */
  addr: number;
  key: string;
  /**
   * Legacy decorators provide the class prototype. Standard decorators do not, so
   * `attachPeripheral` falls back to "method exists on this instance".
   */
  proto?: object;
}
