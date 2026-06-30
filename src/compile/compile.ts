/**
 * Source -> Intel HEX -> running CPU. Closes the loop the dev-only fixtures
 * scripts opened: a programmatic compile path (local avr-gcc for `.c`,
 * arduino-cli for `.ino`) plus a one-call `compileAndRun`.
 *
 * Node/Bun-only (spawns a toolchain). Not exported from the top-level `src`
 * barrel; import from `avrts/compile` (i.e. `src/compile`).
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { AVR } from "../avr";
import { CompileError } from "./errors";
import { resolveArduinoCli, resolveAvrTool, runTool } from "./toolchain";
import type { CompileLang, CompileOptions, CompileResult } from "./types";

const DEFAULT_MCU = "atmega328p";
const DEFAULT_F_CPU = 16_000_000;
const DEFAULT_OPTIMIZE = "s";
const DEFAULT_FQBN = "arduino:avr:uno";

/** Infer the source language from a file extension. */
function langFromPath(path: string): CompileLang {
  const ext = extname(path).toLowerCase();
  if (ext === ".ino") return "ino";
  if (ext === ".c") return "c";
  throw new CompileError(`Cannot infer source language from "${path}" (expected .ino or .c); pass { lang }.`);
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "avrts-compile-"));
}

/** avr-gcc `<src>` -> `.elf` -> `avr-objcopy -O ihex` -> hex text. */
function compileCFile(sourcePath: string, options: CompileOptions): CompileResult {
  const gcc = resolveAvrTool("avr-gcc", options.avrGccBin);
  const objcopy = resolveAvrTool("avr-objcopy", options.avrGccBin);
  const out = makeTempDir();
  try {
    const elf = join(out, "program.elf");
    const hexPath = join(out, "program.hex");
    const { stderr } = runTool(
      gcc,
      [
        `-mmcu=${options.mcu ?? DEFAULT_MCU}`,
        `-O${options.optimize ?? DEFAULT_OPTIMIZE}`,
        `-DF_CPU=${options.fCpu ?? DEFAULT_F_CPU}UL`,
        sourcePath,
        "-o",
        elf,
      ],
      "avr-gcc",
    );
    runTool(objcopy, ["-O", "ihex", "-R", ".eeprom", elf, hexPath], "avr-objcopy");
    return { hex: readFileSync(hexPath, "utf8"), lang: "c", warnings: stderr.trim() };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** arduino-cli compile a sketch directory, then read the produced `.ino.hex`. */
function compileInoSketch(sketchPath: string, options: CompileOptions): CompileResult {
  const cli = resolveArduinoCli(options.arduinoCli);
  const sketchDir = extname(sketchPath) === "" ? sketchPath : dirname(sketchPath);
  const name = basename(sketchDir);
  const build = makeTempDir();
  try {
    const { stderr } = runTool(
      cli,
      ["compile", "--fqbn", options.fqbn ?? DEFAULT_FQBN, sketchDir, "--output-dir", build],
      "arduino-cli compile",
    );
    return { hex: readFileSync(join(build, `${name}.ino.hex`), "utf8"), lang: "ino", warnings: stderr.trim() };
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}

/**
 * Compile a source file (`.c` or `.ino`) to an Intel HEX image. The language is
 * inferred from the extension unless `options.lang` is given.
 */
export function compile(filePath: string, options: CompileOptions = {}): CompileResult {
  const lang = options.lang ?? langFromPath(filePath);
  return lang === "ino" ? compileInoSketch(filePath, options) : compileCFile(filePath, options);
}

/**
 * Compile from an in-memory source string. `options.lang` defaults to `"c"`. For
 * `"ino"` a temporary sketch directory is created (arduino-cli requires the
 * sketch file to share its parent directory's name).
 */
export function compileSource(source: string, options: CompileOptions = {}): CompileResult {
  const lang = options.lang ?? "c";
  const dir = makeTempDir();
  try {
    if (lang === "ino") {
      const sketchName = basename(dir);
      writeFileSync(join(dir, `${sketchName}.ino`), source);
      return compileInoSketch(dir, options);
    }
    const sourcePath = join(dir, "program.c");
    writeFileSync(sourcePath, source);
    return compileCFile(sourcePath, options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compile a source file and load the result into a fresh `AVR()`, ready to run. */
export function compileAndRun(filePath: string, options: CompileOptions = {}): AVR {
  return AVR(compile(filePath, options).hex);
}

/** Compile an in-memory source string and load it into a fresh `AVR()`. */
export function compileSourceAndRun(source: string, options: CompileOptions = {}): AVR {
  return AVR(compileSource(source, options).hex);
}
