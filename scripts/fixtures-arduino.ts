/**
 * Phase 19 - regenerate Arduino golden fixtures.
 *
 * Compiles every `examples/<name>/<name>.ino` sketch with Arduino CLI and
 * refreshes the committed `.ino.hex` + `.lst` artifacts. Tests consume the
 * committed `.ino.hex`; this script is dev-only and never runs at test time.
 *
 * Required tools (override via env var):
 *   $ARDUINO_CLI  - path to arduino-cli (default: "arduino-cli" on PATH)
 *   $AVR_GCC_BIN  - directory holding avr-objdump (default: ./avr-gcc/bin, then PATH)
 *
 * The build output (including the git-ignored `build/` dir and `.elf`) stays in
 * each sketch folder; only `<name>.ino.hex` and `<name>.lst` are committed.
 *
 * Usage:  bun run fixtures:arduino
 */

import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { Glob } from "bun";

const FQBN = "arduino:avr:uno";

function objdumpTool(): string {
  const exe = process.platform === "win32" ? "avr-objdump.exe" : "avr-objdump";
  const dirs = [process.env.AVR_GCC_BIN, join(process.cwd(), "avr-gcc", "bin")];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  return "avr-objdump";
}

function arduinoCliTool(): string {
  if (process.env.ARDUINO_CLI) return process.env.ARDUINO_CLI;

  const bundledPath = join("resources", "app", "lib", "backend", "resources", "arduino-cli.exe");
  const candidates =
    process.platform === "win32"
      ? [
          join(homedir(), "Downloads", "arduino-ide", bundledPath),
          process.env.LOCALAPPDATA
            ? join(process.env.LOCALAPPDATA, "Programs", "Arduino IDE", bundledPath)
            : undefined,
          process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Arduino IDE", bundledPath) : undefined,
          process.env["PROGRAMFILES(X86)"]
            ? join(process.env["PROGRAMFILES(X86)"], "Arduino IDE", bundledPath)
            : undefined,
        ]
      : [];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  return "arduino-cli";
}

function assertSpawnOk(result: ReturnType<typeof spawnSync>, label: string): void {
  if (result.error) {
    throw new Error(`${label} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status})`);
  }
}

const arduinoCli = arduinoCliTool();
const objdump = objdumpTool();

const sketches = [...new Glob("examples/*/*.ino").scanSync()].sort();
if (sketches.length === 0) {
  console.error("No examples/*/*.ino sketches found.");
  process.exit(1);
}

let built = 0;
for (const sketch of sketches) {
  const dir = dirname(sketch);
  const name = basename(sketch, ".ino");
  const buildDir = join(dir, "build");

  const compile = spawnSync(
    arduinoCli,
    ["compile", "--fqbn", FQBN, dir, "--output-dir", buildDir],
    { stdio: "inherit" },
  );
  assertSpawnOk(compile, `arduino-cli compile ${dir}`);

  const builtHex = join(buildDir, `${name}.ino.hex`);
  const builtElf = join(buildDir, `${name}.ino.elf`);
  copyFileSync(builtHex, join(dir, `${name}.ino.hex`));

  // objdump prints the path it was given in the .lst header; pass the same
  // relative build path the committed .lst already records.
  const dump = spawnSync(objdump, ["-d", builtElf], { encoding: "utf8" });
  assertSpawnOk(dump, `avr-objdump -d ${builtElf}`);
  await Bun.write(join(dir, `${name}.lst`), dump.stdout);

  console.log(`  ${name}: ${name}.ino.hex, ${name}.lst`);
  built += 1;
}

console.log(`Rebuilt ${built} Arduino fixture(s).`);
