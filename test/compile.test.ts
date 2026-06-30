import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AVR } from "../src";
import { compile, compileSource, compileSourceAndRun, CompileError } from "../src/compile";

// The local avr-gcc toolchain is dev-only (vendored ./avr-gcc/bin, or PATH). Tests
// that actually invoke it are skipped when it is absent, so CI without the
// toolchain still passes; the error-path tests run everywhere.
function hasAvrGcc(): boolean {
  const exe = process.platform === "win32" ? "avr-gcc.exe" : "avr-gcc";
  return existsSync(join(process.cwd(), "avr-gcc", "bin", exe)) || Boolean(process.env.AVR_GCC_BIN);
}

const TINY_C = "int main(void) { return 0; }\n";

describe("compile (source -> hex -> run)", () => {
  test("infers language from extension and rejects unknown ones", () => {
    expect(() => compile("sketch.txt")).toThrow(CompileError);
    expect(() => compile("sketch.txt")).toThrow(/infer source language/);
  });

  test(".ino path surfaces a clear error when arduino-cli is missing", () => {
    // Deterministic regardless of whether arduino-cli is installed: a bogus
    // override always ENOENTs, exercising the .ino tool resolution + error path.
    expect(() =>
      compileSource("void setup(){} void loop(){}", {
        lang: "ino",
        arduinoCli: "avrts-no-such-arduino-cli",
      }),
    ).toThrow(/not found/);
  });

  test.skipIf(!hasAvrGcc())("compiles a C source string to loadable Intel HEX", () => {
    const result = compileSource(TINY_C);
    expect(result.lang).toBe("c");
    expect(result.hex.startsWith(":")).toBe(true);
    expect(result.hex).toContain(":00000001FF"); // Intel HEX EOF record
    // The produced image loads and runs without throwing.
    const avr = AVR(result.hex);
    expect(() => avr.runCycles(10_000)).not.toThrow();
  });

  test.skipIf(!hasAvrGcc())("compileSourceAndRun returns a runnable AVR", () => {
    const avr = compileSourceAndRun(TINY_C);
    avr.runCycles(10_000);
    expect(avr.status().cycles).toBeGreaterThanOrEqual(10_000);
  });

  test.skipIf(!hasAvrGcc())("compiles an example .c file by path", () => {
    const result = compile("examples/timer0-overflow-blink/timer0-overflow-blink.c");
    expect(result.lang).toBe("c");
    expect(result.hex).toContain(":00000001FF");
  });

  test.skipIf(!hasAvrGcc())("reports a CompileError for a source that fails to build", () => {
    expect(() => compileSource("this is not valid C;")).toThrow(CompileError);
  });
});
