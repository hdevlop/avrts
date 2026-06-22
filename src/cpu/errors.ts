/** Thrown when the decoder meets a 16-bit value no @Op handler claims. */
export class UnknownOpcodeError extends Error {
  constructor(
    readonly pc: number,
    readonly opcode: number,
    readonly nextWord?: number,
    /** Optional nearest disassembly hint (mnemonic + pc) for the surrounding flash. */
    readonly context?: string,
  ) {
    const hex = (n: number, width = 4): string => `0x${n.toString(16).padStart(width, "0")}`;
    const next = nextWord === undefined ? "" : `, next=${hex(nextWord)}`;
    const ctx = context ? `, ${context}` : "";
    super(`Unknown opcode ${hex(opcode)} at pc=${hex(pc)} (byte ${hex(pc * 2)})${next}${ctx}`);
    this.name = "UnknownOpcodeError";
  }
}

/**
 * Search `flash` (using `mnemonicOf`) for the nearest decoded instruction
 * around `pc` (within ±LOOKAHEAD words). Returns a short hint string suitable
 * for inclusion in `UnknownOpcodeError`, or `undefined` if nothing is found.
 */
export function nearestDisassemblyHint(
  flash: Uint16Array,
  pc: number,
  mnemonicOf: (opcode: number) => string | undefined,
): string | undefined {
  const LOOKAHEAD = 16;
  const hex = (n: number): string => `0x${n.toString(16).padStart(4, "0")}`;
  // Prefer the closest decoded instruction in either direction; ties break toward
  // the lower pc so the hint points "back" at the caller.
  let best: { distance: number; mnemonic: string; pc: number } | undefined;
  for (let distance = 0; distance <= LOOKAHEAD; distance += 1) {
    for (const dir of [-1, 1]) {
      const target = pc + distance * dir;
      if (target < 0 || target >= flash.length) continue;
      if (target === pc) continue;
      const opcode = flash[target]!;
      const mnemonic = mnemonicOf(opcode);
      if (!mnemonic || mnemonic === "???") continue;
      if (!best || distance < best.distance) {
        best = { distance, mnemonic, pc: target };
      }
    }
    if (best) return `nearest ${best.mnemonic} at pc=${hex(best.pc)}`;
  }
  return undefined;
}
