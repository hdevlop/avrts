import type { IoHookEntry, OpEntry } from "./types";

/**
 * Global registry of every @Op-decorated instruction handler.
 * Populated as a side effect of importing the decorated class; consumed once by
 * the decode-table builder (never scanned per-instruction). See "Registry rules"
 * in docs/03-coding-style.md.
 */
export const opRegistry: OpEntry[] = [];

/** Global registry of every @OnWrite-decorated peripheral I/O hook. */
export const ioRegistry: IoHookEntry[] = [];

/** Global registry of every @OnRead-decorated peripheral I/O hook. */
export const ioReadRegistry: IoHookEntry[] = [];

/**
 * Register a method as the handler for one AVR instruction.
 * Matching at decode time is `(opcode & mask) === pattern`; more-specific masks
 * win when the decode table is built.
 *
 * Registration is idempotent (dedupes by method name) so re-importing a module
 * during tests/HMR cannot double-register.
 */
export function Op(mnemonic: string, mask: number, pattern: number, words: 1 | 2 = 1) {
  return (_targetOrValue: object, keyOrContext: string | symbol | { name: string | symbol }): void => {
    const name = decoratorName(keyOrContext);
    if (opRegistry.some((entry) => entry.key === name && entry.mask === mask && entry.pattern === pattern)) return;
    opRegistry.push({ mnemonic, mask, pattern, words, key: name });
  };
}

/**
 * Register a method to run when a peripheral's data-space I/O address is written.
 * Convention: the method signature is `(cpu, addr, value, oldValue)` so timers
 * (write-1-to-clear), USART, and multi-address hooks all fit.
 */
export function OnWrite(addr: number) {
  return (targetOrValue: object, keyOrContext: string | symbol | { name: string | symbol }): void => {
    const name = decoratorName(keyOrContext);
    const proto = isStandardDecoratorContext(keyOrContext) ? undefined : targetOrValue;
    if (
      ioRegistry.some((e) => e.addr === addr && e.key === name && e.proto === proto)
    ) {
      return;
    }
    ioRegistry.push({ addr, key: name, proto });
  };
}

/**
 * Register a method to run when a peripheral's data-space I/O address is *read*.
 * The method receives `(cpu, addr)` and returns the byte the CPU should deliver
 * to firmware (or nothing to leave the stored value untouched). This is how
 * read-on-access registers work: UDR0 pops the RX queue, PINx reflects effective
 * pin levels, etc.
 */
export function OnRead(addr: number) {
  return (targetOrValue: object, keyOrContext: string | symbol | { name: string | symbol }): void => {
    const name = decoratorName(keyOrContext);
    const proto = isStandardDecoratorContext(keyOrContext) ? undefined : targetOrValue;
    if (
      ioReadRegistry.some((e) => e.addr === addr && e.key === name && e.proto === proto)
    ) {
      return;
    }
    ioReadRegistry.push({ addr, key: name, proto });
  };
}

function isStandardDecoratorContext(value: unknown): value is { name: string | symbol } {
  return typeof value === "object" && value !== null && "name" in value;
}

function decoratorName(keyOrContext: string | symbol | { name: string | symbol }): string {
  return String(isStandardDecoratorContext(keyOrContext) ? keyOrContext.name : keyOrContext);
}
