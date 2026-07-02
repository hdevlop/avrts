/**
 * Toolchain resolution and process spawning for the compile path. Kept separate
 * from the compile orchestration so the executable lookup (which mirrors the
 * dev-only `scripts/fixtures-*.ts`) lives in one small place.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CompileError } from "./errors";

/**
 * Resolve an avr-gcc-family executable, honoring an explicit `avrGccBin`, then
 * `$AVR_GCC_BIN`, then the vendored `./avr-gcc/bin`, then PATH. Returns the bare
 * name as a PATH fallback (the spawn surfaces a clear error if it is missing).
 */
export function resolveAvrTool(name: string, avrGccBin?: string): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const dirs = [avrGccBin, process.env.AVR_GCC_BIN, join(process.cwd(), "avr-gcc", "bin")];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  return name;
}

/**
 * Resolve the arduino-cli executable: explicit override, `$ARDUINO_CLI`, common
 * Arduino IDE bundled locations, then PATH.
 */
export function resolveArduinoCli(override?: string): string {
  if (override) return override;
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

/**
 * Run a toolchain command, capturing stdout/stderr. Throws a `CompileError` that
 * distinguishes "executable not found" (ENOENT) from a non-zero build exit, and
 * includes the captured stderr so the caller sees the real compiler diagnostics.
 */
export function runTool(cmd: string, args: readonly string[], label: string): { stdout: string; stderr: string } {
  const result = spawnSync(cmd, args as string[], { encoding: "utf8" });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CompileError(`${label}: executable not found ("${cmd}"). Install the toolchain or set the override option/env var.`);
    }
    throw new CompileError(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new CompileError(`${label} failed (exit ${result.status})${detail ? `:\n${detail}` : ""}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
