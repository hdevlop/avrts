/**
 * Compile an AVR source file to Intel HEX, and optionally run it in the sim.
 *
 *   bun run compile <file.ino|file.c> [options]
 *
 * Options:
 *   --run            after compiling, load the hex into AVR() and run it
 *   --cycles N       cycles to run with --run (default 2,000,000)
 *   --lang c|ino     override the language (else inferred from the extension)
 *   --mcu NAME       target MCU for .c builds (default atmega328p)
 *   --fqbn FQBN      board for .ino builds (default arduino:avr:uno)
 *   -o, --out PATH   write the hex here (default: <source-basename>.hex)
 *   --stdout         print the hex to stdout instead of writing a file
 *
 * Toolchain: vendored ./avr-gcc/bin (or $AVR_GCC_BIN / PATH) for .c;
 * arduino-cli ($ARDUINO_CLI / PATH) for .ino.
 */

import { basename, extname, join, dirname } from "node:path";
import { compile } from "../src/compile";
import type { CompileLang, CompileOptions } from "../src/compile";
import { AVR } from "../src";

interface CliOptions extends CompileOptions {
  file: string;
  run: boolean;
  cycles: number;
  out?: string;
  stdout: boolean;
}

function parseArgs(args: string[]): CliOptions {
  if (args.length === 0) throw new Error("usage: bun run compile <file.ino|file.c> [--run] [--cycles N] [-o out] [--stdout]");
  const options: CliOptions = { file: "", run: false, cycles: 2_000_000, stdout: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--run") options.run = true;
    else if (arg === "--stdout") options.stdout = true;
    else if (arg === "--cycles") options.cycles = parsePositiveInt(args[++i], "--cycles");
    else if (arg === "--lang") options.lang = parseLang(args[++i]);
    else if (arg === "--mcu") options.mcu = args[++i];
    else if (arg === "--fqbn") options.fqbn = args[++i];
    else if (arg === "-o" || arg === "--out") options.out = args[++i];
    else if (arg.startsWith("-")) throw new Error(`unknown option "${arg}"`);
    else if (options.file === "") options.file = arg;
    else throw new Error(`unexpected extra argument "${arg}"`);
  }
  if (options.file === "") throw new Error("no source file given");
  return options;
}

function parseLang(value: string | undefined): CompileLang {
  if (value === "c" || value === "ino") return value;
  throw new Error(`--lang expects "c" or "ino", got ${value}`);
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} expects a positive integer, got ${value}`);
  return parsed;
}

function defaultOutPath(file: string): string {
  return join(dirname(file), `${basename(file, extname(file))}.hex`);
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const result = compile(options.file, options);
  if (result.warnings) console.error(result.warnings);

  if (options.stdout) {
    process.stdout.write(result.hex);
  } else {
    const out = options.out ?? defaultOutPath(options.file);
    await Bun.write(out, result.hex);
    console.log(`compiled ${options.file} (${result.lang}) -> ${out}`);
  }

  if (options.run) {
    const avr = AVR(result.hex);
    avr.runCycles(options.cycles);
    const text = avr.serial.getText();
    console.log(`ran ${options.cycles.toLocaleString()} cycles -> cycles=${avr.status().cycles}`);
    if (text) console.log(`--- serial output ---\n${text}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
