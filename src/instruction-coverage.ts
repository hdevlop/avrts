/**
 * ATmega328P instruction-set coverage tracker (Phase 16).
 *
 * Each ATmega328P instruction mnemonic is listed here with its implementation
 * status. The runtime test in `test/phase16-coverage.test.ts` cross-checks every
 * `"implemented"` mnemonic against the live decode table, and verifies that
 * each `"not-implemented"` mnemonic actually throws `UnknownOpcodeError`.
 *
 * Statuses:
 *   - `"implemented"`    : decoded + executed by `Decoder`
 *   - `"alias"`          : same encoding as another mnemonic; recorded for
 *                          coverage even though no separate handler exists
 *   - `"not-implemented"`: intentionally not modelled; `note` explains why
 *
 * If a real AVR program ever hits a `"not-implemented"` instruction, the
 * fix is to promote it to `"implemented"` here and add an `@Op` handler.
 */

export type CoverageStatus = "implemented" | "alias" | "not-implemented";

export interface CoverageEntry {
  readonly mnemonic: string;
  readonly status: CoverageStatus;
  readonly note?: string;
}

/** A canonical opcode that should decode to `mnemonic` (sanity check). */
export interface CoverageCheck {
  readonly mnemonic: string;
  /** One canonical 16-bit opcode that must decode to this mnemonic. */
  readonly opcode: number;
}

export const COVERAGE: ReadonlyArray<CoverageEntry> = [
  // --- Arithmetic and logic ---
  { mnemonic: "ADD", status: "implemented" },
  { mnemonic: "ADC", status: "implemented" },
  { mnemonic: "ADIW", status: "implemented" },
  { mnemonic: "SUB", status: "implemented" },
  { mnemonic: "SUBI", status: "implemented" },
  { mnemonic: "SBC", status: "implemented" },
  { mnemonic: "SBCI", status: "implemented" },
  { mnemonic: "SBIW", status: "implemented" },
  { mnemonic: "INC", status: "implemented" },
  { mnemonic: "DEC", status: "implemented" },
  { mnemonic: "COM", status: "implemented" },
  { mnemonic: "NEG", status: "implemented" },
  { mnemonic: "AND", status: "implemented" },
  { mnemonic: "ANDI", status: "implemented" },
  { mnemonic: "OR", status: "implemented" },
  { mnemonic: "ORI", status: "implemented" },
  { mnemonic: "EOR", status: "implemented" },
  { mnemonic: "SWAP", status: "implemented" },
  { mnemonic: "LSR", status: "implemented" },
  { mnemonic: "ROR", status: "implemented" },
  { mnemonic: "ASR", status: "implemented" },
  { mnemonic: "MUL", status: "implemented" },
  { mnemonic: "MULS", status: "implemented" },
  { mnemonic: "MULSU", status: "implemented" },
  { mnemonic: "FMUL", status: "implemented" },
  { mnemonic: "FMULS", status: "implemented" },
  { mnemonic: "FMULSU", status: "implemented" },
  // LSL is an alias of "ADD Rd, Rd"; we accept it through the same encoding.
  { mnemonic: "LSL", status: "alias", note: "encoded as ADD Rd, Rd" },
  // ROL is documented as an alias for ADC Rd, Rd in most AVR references.
  { mnemonic: "ROL", status: "alias", note: "encoded as ADC Rd, Rd" },

  // --- Branch instructions ---
  { mnemonic: "RJMP", status: "implemented" },
  { mnemonic: "IJMP", status: "implemented" },
  { mnemonic: "JMP", status: "implemented" },
  { mnemonic: "RCALL", status: "implemented" },
  { mnemonic: "ICALL", status: "implemented" },
  { mnemonic: "CALL", status: "implemented" },
  { mnemonic: "RET", status: "implemented" },
  { mnemonic: "RETI", status: "implemented" },
  { mnemonic: "CPSE", status: "implemented" },
  // BRBS / BRBC are the general two-operand branch forms; we expose the named
  // aliases the assembler typically emits.
  { mnemonic: "BRBS", status: "alias", note: "exposed via named aliases (BRCS, BREQ, ...)" },
  { mnemonic: "BRBC", status: "alias", note: "exposed via named aliases (BRCC, BRNE, ...)" },
  { mnemonic: "BREQ", status: "implemented" },
  { mnemonic: "BRNE", status: "implemented" },
  { mnemonic: "BRCS", status: "implemented" },
  { mnemonic: "BRCC", status: "implemented" },
  { mnemonic: "BRSH", status: "alias", note: "same encoding as BRCC" },
  { mnemonic: "BRLO", status: "alias", note: "same encoding as BRCS" },
  { mnemonic: "BRMI", status: "implemented" },
  { mnemonic: "BRPL", status: "implemented" },
  { mnemonic: "BRGE", status: "implemented" },
  { mnemonic: "BRLT", status: "implemented" },
  { mnemonic: "BRHS", status: "implemented" },
  { mnemonic: "BRHC", status: "implemented" },
  { mnemonic: "BRTS", status: "implemented" },
  { mnemonic: "BRTC", status: "implemented" },
  { mnemonic: "BRVS", status: "implemented" },
  { mnemonic: "BRVC", status: "implemented" },
  { mnemonic: "BRIE", status: "implemented" },
  { mnemonic: "BRID", status: "implemented" },

  // --- Bit and bit-test ---
  { mnemonic: "SBI", status: "implemented" },
  { mnemonic: "CBI", status: "implemented" },
  { mnemonic: "BSET", status: "implemented" },
  { mnemonic: "BCLR", status: "implemented" },
  // SEC / CLC / SEI / CLI / SEN / CLN / SEZ / CLZ / ... are aliases of BSET/BCLR
  // with specific s-bits.
  { mnemonic: "SEC", status: "alias", note: "encoded as BSET 0" },
  { mnemonic: "CLC", status: "alias", note: "encoded as BCLR 0" },
  { mnemonic: "SEZ", status: "alias", note: "encoded as BSET 1" },
  { mnemonic: "CLZ", status: "alias", note: "encoded as BCLR 1" },
  { mnemonic: "SEN", status: "alias", note: "encoded as BSET 2" },
  { mnemonic: "CLN", status: "alias", note: "encoded as BCLR 2" },
  { mnemonic: "SEV", status: "alias", note: "encoded as BSET 3" },
  { mnemonic: "CLV", status: "alias", note: "encoded as BCLR 3" },
  { mnemonic: "SES", status: "alias", note: "encoded as BSET 4" },
  { mnemonic: "CLS", status: "alias", note: "encoded as BCLR 4" },
  { mnemonic: "SEH", status: "alias", note: "encoded as BSET 5" },
  { mnemonic: "CLH", status: "alias", note: "encoded as BCLR 5" },
  { mnemonic: "SET", status: "alias", note: "encoded as BSET 6" },
  { mnemonic: "CLT", status: "alias", note: "encoded as BCLR 6" },
  { mnemonic: "SEI", status: "implemented" },
  { mnemonic: "CLI", status: "implemented" },
  { mnemonic: "BST", status: "implemented" },
  { mnemonic: "BLD", status: "implemented" },
  { mnemonic: "SBRC", status: "implemented" },
  { mnemonic: "SBRS", status: "implemented" },
  { mnemonic: "SBIC", status: "implemented" },
  { mnemonic: "SBIS", status: "implemented" },

  // --- Compare (subtract, discard result) ---
  { mnemonic: "CP", status: "implemented" },
  { mnemonic: "CPC", status: "implemented" },
  { mnemonic: "CPI", status: "implemented" },

  // --- Data transfer ---
  { mnemonic: "MOV", status: "implemented" },
  { mnemonic: "MOVW", status: "implemented" },
  { mnemonic: "LDI", status: "implemented" },
  { mnemonic: "LDS", status: "implemented" },
  { mnemonic: "STS", status: "implemented" },
  { mnemonic: "IN", status: "implemented" },
  { mnemonic: "OUT", status: "implemented" },
  { mnemonic: "PUSH", status: "implemented" },
  { mnemonic: "POP", status: "implemented" },
  // LD / ST with all addressing modes.
  { mnemonic: "LD", status: "implemented" },
  { mnemonic: "ST", status: "implemented" },
  // LDD / STD (load/store with displacement).
  { mnemonic: "LDD", status: "implemented" },
  { mnemonic: "STD", status: "implemented" },
  // LPM (three addressing modes: R0, Z, Z+).
  { mnemonic: "LPM", status: "implemented" },

  // --- MCU control ---
  { mnemonic: "NOP", status: "implemented" },
  { mnemonic: "SLEEP", status: "implemented" },
  { mnemonic: "WDR", status: "implemented" },
  { mnemonic: "SPM", status: "implemented" },
  { mnemonic: "BREAK", status: "implemented" },

  // --- Intentionally not modelled for ATmega328P ---

  // ELPM is only useful with >64K program memory; ATmega328P has 16K words and
  // never generates it from avr-gcc at -Os.
  { mnemonic: "ELPM", status: "not-implemented", note: "ATmega328P has 16K words (< 64K); ELPM is only needed for larger flash" },

  // EICALL / EJMP are extended indirect calls/jumps for >128K program memory.
  { mnemonic: "EICALL", status: "not-implemented", note: "ATmega328P has 16K words (< 128K); EICALL is for ATmega2560+" },
  { mnemonic: "EJMP", status: "not-implemented", note: "ATmega328P has 16K words (< 128K); EJMP is for ATmega2560+" },

  // DES is an XMEGA-only data-encryption instruction.
  { mnemonic: "DES", status: "not-implemented", note: "DES is an XMEGA-only instruction; ATmega328P does not implement it" },
];

/**
 * One canonical opcode per implemented mnemonic; the coverage test decodes
 * each one and asserts it matches. Aliases are deliberately omitted — their
 * opcodes decode to the parent mnemonic.
 */
export const COVERAGE_SAMPLES: ReadonlyArray<CoverageCheck> = [
  { mnemonic: "ADD", opcode: 0x0c12 }, // ADD r1, r2
  { mnemonic: "ADC", opcode: 0x1c12 },
  { mnemonic: "ADIW", opcode: 0x9611 }, // ADIW r24, 1
  { mnemonic: "SUB", opcode: 0x1812 },
  { mnemonic: "SUBI", opcode: 0x5011 }, // SUBI r17, 1
  { mnemonic: "SBC", opcode: 0x0812 },
  { mnemonic: "SBCI", opcode: 0x4011 },
  { mnemonic: "SBIW", opcode: 0x9711 },
  { mnemonic: "INC", opcode: 0x9413 },
  { mnemonic: "DEC", opcode: 0x941a },
  { mnemonic: "COM", opcode: 0x9400 },
  { mnemonic: "NEG", opcode: 0x9401 },
  { mnemonic: "AND", opcode: 0x2012 },
  { mnemonic: "ANDI", opcode: 0x7011 },
  { mnemonic: "OR", opcode: 0x2812 },
  { mnemonic: "ORI", opcode: 0x6011 },
  { mnemonic: "EOR", opcode: 0x2412 },
  { mnemonic: "SWAP", opcode: 0x9402 },
  { mnemonic: "LSR", opcode: 0x9406 },
  { mnemonic: "ROR", opcode: 0x9407 },
  { mnemonic: "ASR", opcode: 0x9405 },
  { mnemonic: "MUL", opcode: 0x9c12 },
  { mnemonic: "MULS", opcode: 0x0212 },
  { mnemonic: "MULSU", opcode: 0x0312 },
  { mnemonic: "FMUL", opcode: 0x031e },
  { mnemonic: "FMULS", opcode: 0x0381 }, // FMULS r16, r17 (bit3 clear = signed*signed)
  { mnemonic: "FMULSU", opcode: 0x039e },

  { mnemonic: "CP", opcode: 0x1412 }, // CP r1, r2
  { mnemonic: "CPC", opcode: 0x0412 },
  { mnemonic: "CPI", opcode: 0x3001 }, // CPI r16, 1

  { mnemonic: "RJMP", opcode: 0xc000 }, // RJMP 0
  { mnemonic: "IJMP", opcode: 0x9409 },
  { mnemonic: "JMP", opcode: 0x940c }, // first word; full form needs another word
  { mnemonic: "RCALL", opcode: 0xd000 },
  { mnemonic: "ICALL", opcode: 0x9509 },
  { mnemonic: "CALL", opcode: 0x940e }, // first word
  { mnemonic: "RET", opcode: 0x9508 },
  { mnemonic: "RETI", opcode: 0x9518 },
  { mnemonic: "CPSE", opcode: 0x1012 },
  { mnemonic: "BREQ", opcode: 0xf001 },
  { mnemonic: "BRNE", opcode: 0xf401 },
  { mnemonic: "BRCS", opcode: 0xf000 },
  { mnemonic: "BRCC", opcode: 0xf400 },
  { mnemonic: "BRMI", opcode: 0xf002 },
  { mnemonic: "BRPL", opcode: 0xf402 },
  { mnemonic: "BRGE", opcode: 0xf404 },
  { mnemonic: "BRLT", opcode: 0xf004 },
  { mnemonic: "BRHS", opcode: 0xf005 },
  { mnemonic: "BRHC", opcode: 0xf405 },
  { mnemonic: "BRTS", opcode: 0xf006 },
  { mnemonic: "BRTC", opcode: 0xf406 },
  { mnemonic: "BRVS", opcode: 0xf003 },
  { mnemonic: "BRVC", opcode: 0xf403 },
  { mnemonic: "BRIE", opcode: 0xf007 },
  { mnemonic: "BRID", opcode: 0xf407 },

  { mnemonic: "SBI", opcode: 0x9a1f }, // SBI 0x03, 7 (PINB bit 7)
  { mnemonic: "CBI", opcode: 0x981f },
  { mnemonic: "BSET", opcode: 0x9408 }, // BSET 0 (SEC)
  { mnemonic: "BCLR", opcode: 0x9488 }, // BCLR 0 (CLC)
  { mnemonic: "SEI", opcode: 0x9478 },
  { mnemonic: "CLI", opcode: 0x94f8 },
  { mnemonic: "BST", opcode: 0xfa00 },
  { mnemonic: "BLD", opcode: 0xf800 },
  { mnemonic: "SBRC", opcode: 0xfc00 },
  { mnemonic: "SBRS", opcode: 0xfe00 },
  { mnemonic: "SBIC", opcode: 0x9900 },
  { mnemonic: "SBIS", opcode: 0x9b00 },

  { mnemonic: "MOV", opcode: 0x2c12 },
  { mnemonic: "MOVW", opcode: 0x0112 },
  { mnemonic: "LDI", opcode: 0xe005 },
  { mnemonic: "LDS", opcode: 0x9000 }, // first word
  { mnemonic: "STS", opcode: 0x9200 },
  { mnemonic: "IN", opcode: 0xb000 }, // IN r0, 0x00
  { mnemonic: "OUT", opcode: 0xb800 },
  { mnemonic: "PUSH", opcode: 0x920f },
  { mnemonic: "POP", opcode: 0x900f },

  // Indirect load/store: the decode table names these LD_X/ST_Zinc/...; the
  // coverage test normalizes those back to the LD/ST/LDD/STD/LPM families.
  { mnemonic: "LD", opcode: 0x900c }, // LD r0, X
  { mnemonic: "ST", opcode: 0x920c }, // ST X, r0
  { mnemonic: "LDD", opcode: 0x8008 }, // LDD r0, Y+0
  { mnemonic: "STD", opcode: 0x8208 }, // STD Y+0, r0
  { mnemonic: "LPM", opcode: 0x9004 }, // LPM r0, Z

  { mnemonic: "NOP", opcode: 0x0000 },
  { mnemonic: "SLEEP", opcode: 0x9588 },
  { mnemonic: "WDR", opcode: 0x95a8 },
  { mnemonic: "SPM", opcode: 0x95e8 },
  { mnemonic: "BREAK", opcode: 0x9598 },
];

/**
 * Canonical opcodes for the intentionally `"not-implemented"` instructions.
 * The coverage test asserts each one is unclaimed by the decode table and that
 * executing it raises `UnknownOpcodeError` — proving the gaps are explicit, not
 * silently mis-decoded.
 */
export const UNSUPPORTED_SAMPLES: ReadonlyArray<CoverageCheck> = [
  { mnemonic: "ELPM", opcode: 0x9006 }, // ELPM Rd, Z
  { mnemonic: "EICALL", opcode: 0x9519 },
  { mnemonic: "EJMP", opcode: 0x9419 }, // EIJMP encoding
  { mnemonic: "DES", opcode: 0x940b }, // DES 0
];

/** Convenience: return just the mnemonics that the runtime must decode. */
export const IMPLEMENTED_MNEMONICS: ReadonlyArray<string> = COVERAGE
  .filter((entry) => entry.status === "implemented")
  .map((entry) => entry.mnemonic);
