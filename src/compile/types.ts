/**
 * Shared types for the source -> Intel HEX compile path (Phase 9 compiler
 * integration). This module spawns a local toolchain (avr-gcc / arduino-cli),
 * so it is Node/Bun-only and is intentionally NOT re-exported from the top-level
 * `src` barrel (that would pull `node:child_process` into the browser bundle).
 */

/** Source language accepted by the compiler. */
export type CompileLang = "ino" | "c";

/** Options controlling a compile. All have sensible ATmega328P / Uno defaults. */
export interface CompileOptions {
  /** Source language. Inferred from the file extension when compiling a path. */
  lang?: CompileLang;
  /** Target MCU passed to `avr-gcc -mmcu`. Default `"atmega328p"`. */
  mcu?: string;
  /** CPU clock used for `-DF_CPU` (Hz). Default `16_000_000`. */
  fCpu?: number;
  /** `avr-gcc` optimization level, e.g. `"s"`, `"2"`. Default `"s"` (`-Os`). */
  optimize?: string;
  /** Arduino FQBN passed to `arduino-cli --fqbn`. Default `"arduino:avr:uno"`. */
  fqbn?: string;
  /** Override the `arduino-cli` executable (else `$ARDUINO_CLI`, then PATH). */
  arduinoCli?: string;
  /**
   * Directory holding `avr-gcc`/`avr-objcopy`. Overrides the default lookup
   * (`$AVR_GCC_BIN`, then the vendored `./avr-gcc/bin`, then PATH).
   */
  avrGccBin?: string;
}

/** Result of a successful compile. */
export interface CompileResult {
  /** Intel HEX text, ready for `AVR().useHex(...)`. */
  hex: string;
  /** Language that was actually compiled. */
  lang: CompileLang;
  /** Toolchain stderr (warnings/notes), empty when the build was clean. */
  warnings: string;
}
