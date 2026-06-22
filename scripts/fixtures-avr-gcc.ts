/**
 * Phase 19 - regenerate avr-libc golden fixtures.
 *
 * Compiles every `examples/<name>/<name>.c` avr-libc fixture with a local
 * `avr-gcc` toolchain and refreshes the committed `.hex` + `.lst` artifacts.
 * Tests consume the committed `.hex`; this script is dev-only and never runs at
 * test time.
 *
 * Toolchain location (first match wins):
 *   1. $AVR_GCC_BIN  - directory holding avr-gcc / avr-objcopy / avr-objdump
 *   2. ./avr-gcc/bin - the toolchain vendored in this repo
 *   3. PATH          - whatever `avr-gcc` resolves to
 *
 * Build flags match the committed fixtures exactly:
 *   avr-gcc -mmcu=atmega328p -Os -DF_CPU=16000000UL
 *
 * The intermediate `.elf` is written next to the source (it is git-ignored) so
 * the `.lst` header path matches the committed disassembly.
 *
 * Usage:  bun run fixtures:avr-gcc
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { Glob } from "bun";

const MCU = "atmega328p";
const F_CPU = "16000000UL";

/** Resolve a toolchain executable, honoring $AVR_GCC_BIN, then the vendored dir. */
function tool(name: string): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const dirs = [process.env.AVR_GCC_BIN, join(process.cwd(), "avr-gcc", "bin")];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  return name; // fall back to PATH
}

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) {
    throw new Error(`${basename(cmd)} ${args.join(" ")} failed (exit ${result.status})`);
  }
}

const gcc = tool("avr-gcc");
const objcopy = tool("avr-objcopy");
const objdump = tool("avr-objdump");

const sources = [...new Glob("examples/*/*.c").scanSync()].sort();
if (sources.length === 0) {
  console.error("No examples/*/*.c fixtures found.");
  process.exit(1);
}

let built = 0;
for (const source of sources) {
  const dir = dirname(source);
  const name = basename(source, ".c");
  const elf = join(dir, `${name}.elf`);
  const hex = join(dir, `${name}.hex`);
  const lst = join(dir, `${name}.lst`);

  run(gcc, [`-mmcu=${MCU}`, "-Os", `-DF_CPU=${F_CPU}`, source, "-o", elf]);
  run(objcopy, ["-O", "ihex", "-R", ".eeprom", elf, hex]);

  // Capture disassembly; objdump prints the .elf path it was given in the header,
  // so pass the same relative path the committed .lst already records.
  const dump = spawnSync(objdump, ["-d", elf], { encoding: "utf8" });
  if (dump.status !== 0) throw new Error(`avr-objdump -d ${elf} failed`);
  await Bun.write(lst, dump.stdout);

  console.log(`  ${name}: ${hex}, ${lst}`);
  built += 1;
}

console.log(`Rebuilt ${built} avr-libc fixture(s).`);
