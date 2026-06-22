import { describe, expect, test } from "bun:test";
import { CPU, Decoder, FLASH_WORDS, UnknownOpcodeError } from "../src/cpu";
import {
  COVERAGE,
  COVERAGE_SAMPLES,
  UNSUPPORTED_SAMPLES,
  type CoverageEntry,
} from "../src/instruction-coverage";

/**
 * Phase 16 - instruction coverage audit.
 *
 * Keeps the hand-maintained coverage table in `src/instruction-coverage.ts`
 * honest against the live decode table: implemented mnemonics must actually
 * decode, intentionally unsupported ones must actually throw, and every family
 * the decoder claims must be accounted for in the table.
 */

/** Normalize decode-table mnemonics like "LD_X" / "ST_Zinc" to their family ("LD","ST"). */
function family(mnemonic: string): string {
  const underscore = mnemonic.indexOf("_");
  return underscore === -1 ? mnemonic : mnemonic.slice(0, underscore);
}

const decoder = new Decoder();

/** Families the decode table actually claims, across the whole 16-bit opcode space. */
const tableFamilies = (() => {
  const present = new Set<string>();
  for (let op = 0; op < 0x10000; op += 1) {
    const mnemonic = decoder.mnemonicOf(op);
    if (mnemonic) present.add(family(mnemonic));
  }
  return present;
})();

function makeCpu(program: number[]): CPU {
  const flash = new Uint16Array(FLASH_WORDS);
  flash.set(program);
  const cpu = new CPU(flash);
  cpu.setExecutor(decoder);
  return cpu;
}

const byMnemonic = new Map<string, CoverageEntry>(COVERAGE.map((e) => [e.mnemonic, e]));

describe("Phase 16 instruction coverage", () => {
  test("coverage table has no duplicate mnemonics", () => {
    expect(byMnemonic.size).toBe(COVERAGE.length);
  });

  test("every implemented mnemonic is claimed by the decode table", () => {
    const missing = COVERAGE.filter(
      (e) => e.status === "implemented" && !tableFamilies.has(e.mnemonic),
    ).map((e) => e.mnemonic);
    expect(missing).toEqual([]);
  });

  test("every decode-table family is recorded as implemented or alias", () => {
    const undocumented: string[] = [];
    for (const fam of tableFamilies) {
      const entry = byMnemonic.get(fam);
      if (!entry || (entry.status !== "implemented" && entry.status !== "alias")) {
        undocumented.push(fam);
      }
    }
    expect(undocumented.sort()).toEqual([]);
  });

  test("each canonical sample opcode decodes to its mnemonic family", () => {
    for (const sample of COVERAGE_SAMPLES) {
      const decoded = decoder.mnemonicOf(sample.opcode);
      expect(decoded, `opcode 0x${sample.opcode.toString(16)} should decode`).toBeDefined();
      expect(family(decoded!), `opcode 0x${sample.opcode.toString(16)}`).toBe(sample.mnemonic);
    }
  });

  test("sample opcodes exist for every non-alias implemented mnemonic", () => {
    const sampled = new Set(COVERAGE_SAMPLES.map((s) => s.mnemonic));
    const missing = COVERAGE.filter(
      (e) => e.status === "implemented" && !sampled.has(e.mnemonic),
    ).map((e) => e.mnemonic);
    expect(missing).toEqual([]);
  });

  test("intentionally unsupported opcodes are unclaimed and throw UnknownOpcodeError", () => {
    for (const sample of UNSUPPORTED_SAMPLES) {
      expect(
        decoder.mnemonicOf(sample.opcode),
        `${sample.mnemonic} (0x${sample.opcode.toString(16)}) must be unclaimed`,
      ).toBeUndefined();

      const cpu = makeCpu([sample.opcode]);
      expect(() => cpu.tick(), `${sample.mnemonic} should throw`).toThrow(UnknownOpcodeError);
    }
  });

  test("UnknownOpcodeError carries pc, opcode, next word and disassembly context", () => {
    // RJMP 0 (decodes), then DES (unknown) at pc=1, then another RJMP for context.
    const cpu = makeCpu([0xc000, 0x940b, 0xc000]);
    cpu.tick(); // execute RJMP -> pc advances to 1
    try {
      cpu.tick();
      throw new Error("expected UnknownOpcodeError");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownOpcodeError);
      const e = err as UnknownOpcodeError;
      expect(e.pc).toBe(1);
      expect(e.opcode).toBe(0x940b);
      expect(e.nextWord).toBe(0xc000);
      expect(e.message).toContain("nearest");
    }
  });
});
