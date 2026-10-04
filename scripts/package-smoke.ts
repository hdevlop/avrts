import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
const tempRoot = mkdtempSync(join(tmpdir(), "avrts-package-smoke-"));
const consumer = join(tempRoot, "consumer");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Every packaged `new URL("./x.js", import.meta.url)` must point at a file that
 * exists relative to the module that contains it - wherever the bundler put
 * that module (entry or shared chunk).
 */
function assertWorkerUrlsResolve(distRoot: string): void {
  const pattern = /new URL\(\s*["'](\.\.?\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
  let found = 0;
  for (const file of new Bun.Glob("**/*.js").scanSync({ cwd: distRoot, absolute: true })) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      found += 1;
      const target = fileURLToPath(new URL(match[1]!, pathToFileURL(file)));
      if (!existsSync(target)) {
        throw new Error(`${file} references ${match[1]}, which resolves to missing ${target}`);
      }
    }
  }
  if (found === 0) throw new Error("Packaged runtime has no default worker URL to verify");
}

function run(command: string, args: string[], cwd: string): CommandResult {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.exitCode}\n${stdout}${stderr}`,
    );
  }
  return { stdout, stderr };
}

try {
  const packed = run(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", tempRoot],
    root,
  );
  const packResult = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const tarball = join(tempRoot, packResult[0]?.filename ?? "");
  if (!existsSync(tarball)) throw new Error(`npm pack did not create the expected tarball: ${tarball}`);

  const packedFiles = new Set((packResult[0]?.files ?? []).map((file) => file.path.replace(/\\/g, "/")));
  for (const required of [
    "dist/public/index.js",
    "dist/public/browser.js",
    "dist/public/advanced.js",
    "dist/public/browser-worker.js",
    "dist/types/public/index.d.ts",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "SECURITY.md",
    "package.json",
  ]) {
    if (!packedFiles.has(required)) throw new Error(`Packed artifact is missing ${required}`);
  }
  if ([...packedFiles].some((file) => file.startsWith("src/") || file.startsWith("test/"))) {
    throw new Error("Packed artifact leaked source or test files");
  }

  writeFileSync(join(tempRoot, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const installed = run(npm, ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], tempRoot);
  if (/EBADENGINE/i.test(`${installed.stdout}\n${installed.stderr}`)) {
    throw new Error(`Package install reported an engine mismatch:\n${installed.stdout}${installed.stderr}`);
  }

  const hex = ":0200000000E21C\n:00000001FF\n";
  writeFileSync(join(tempRoot, "firmware.hex"), hex);
  const smokeSource = `
import * as root from "@hdevlop/avrts";
import { AVR } from "@hdevlop/avrts";
import * as browser from "@hdevlop/avrts/browser";
import * as advanced from "@hdevlop/avrts/advanced";

const direct = AVR(${JSON.stringify(hex)});
const fromPath = AVR({ path: new URL("./firmware.hex", import.meta.url) });
process.stdout.write(JSON.stringify({
  root: Object.keys(root).sort(),
  browserRuntime: typeof browser.createAVRWorkerRuntime,
  advancedCpu: typeof advanced.CPU,
  directWord: direct.cpu.flash[0],
  pathWord: fromPath.cpu.flash[0],
}));
`;
  writeFileSync(join(tempRoot, "smoke.mjs"), smokeSource);
  const expected = JSON.stringify({
    root: ["AVR"],
    browserRuntime: "function",
    advancedCpu: "function",
    directWord: 0xe200,
    pathWord: 0xe200,
  });

  for (const runtime of ["node", "bun"]) {
    const result = run(runtime, ["smoke.mjs"], tempRoot);
    if (result.stdout !== expected) {
      throw new Error(`${runtime} package import emitted unexpected output:\n${result.stdout}`);
    }
  }

  const browserEntry = `
import { AVR } from "@hdevlop/avrts";
import { createAVRWorkerRuntime } from "@hdevlop/avrts/browser";
export { AVR, createAVRWorkerRuntime };
`;
  writeFileSync(join(tempRoot, "browser-entry.ts"), browserEntry);
  run(
    "bun",
    ["build", "browser-entry.ts", "--outdir", "browser-dist", "--target", "browser", "--format", "esm"],
    tempRoot,
  );
  const browserBundle = join(tempRoot, "browser-dist", "browser-entry.js");
  if (!existsSync(browserBundle)) throw new Error("Browser consumer bundle was not created");
  if (!readFileSync(browserBundle, "utf8").includes("browser-worker.js")) {
    throw new Error("Browser consumer bundle lost the packaged worker URL");
  }
  if (!existsSync(join(tempRoot, "node_modules", "@hdevlop/avrts", "dist", "public", "browser-worker.js"))) {
    throw new Error("Installed package is missing its browser worker asset");
  }
  assertWorkerUrlsResolve(join(tempRoot, "node_modules", "@hdevlop/avrts", "dist"));

  const typeSmoke = `
import { AVR, type AVRStatus } from "@hdevlop/avrts";
import type { AVRWorkerRuntime } from "@hdevlop/avrts/browser";
import { CPU } from "@hdevlop/avrts/advanced";

const avr = AVR(":00000001FF");
const status: AVRStatus = avr.status();
const cpu: CPU = avr.cpu;
declare const workerRuntime: AVRWorkerRuntime;
void [status, cpu, workerRuntime];
`;
  writeFileSync(join(tempRoot, "type-smoke.ts"), typeSmoke);
  writeFileSync(
    join(tempRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["ES2022", "DOM"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: "ES2022",
      },
      include: ["type-smoke.ts"],
    }),
  );
  run(
    "node",
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
    tempRoot,
  );

  console.log(`package smoke PASS: ${packResult[0]?.filename} (${packedFiles.size} files)`);
} finally {
  const tempBase = resolve(tmpdir());
  const resolvedTempRoot = resolve(tempRoot);
  if (resolvedTempRoot.startsWith(`${tempBase}\\`) || resolvedTempRoot.startsWith(`${tempBase}/`)) {
    rmSync(resolvedTempRoot, { recursive: true, force: true });
  }
}
