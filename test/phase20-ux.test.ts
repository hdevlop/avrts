import { describe, expect, test, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 20 - browser simulator UX foundation.
 *
 * Like the Phase 18 suite, these run without a real browser: they verify the
 * bundle/markup/styles include the new UX surface and that the new sources keep
 * to the public-facade rule. Real interaction is covered by the dev-only
 * Playwright specs in examples/browser-simulator/tests/.
 */

const ROOT = join(import.meta.dir, "..");
const DEMO = join(ROOT, "examples/browser-simulator");
const DIST = join(DEMO, "dist");
const BUNDLE = join(DIST, "main.js");

beforeAll(() => {
  mkdirSync(DIST, { recursive: true });
  const result = spawnSync(
    "bun",
    ["build", "examples/browser-simulator/src/main.ts", "--outdir",
      "examples/browser-simulator/dist", "--target", "browser", "--minify"],
    { cwd: ROOT, encoding: "utf8" },
  );
  expect(result.status).toBe(0);
});

describe("Phase 20 — bundle contains the UX foundation", () => {
  test("builds a bundle", () => {
    expect(existsSync(BUNDLE)).toBe(true);
  });

  test("bundle includes workspace, wiring, board and inspector markup", async () => {
    const text = await Bun.file(BUNDLE).text();
    for (const marker of [
      "workspace",
      "wire-layer",
      "board-widget",
      "pin-port",
      "io-port",
      "inspector-widget",
      "inspector-registers",
      "flag-chip",
    ]) {
      expect(text, `bundle should contain "${marker}"`).toContain(marker);
    }
  });

  test("bundle wires snapshot/restore/step controls", async () => {
    const text = await Bun.file(BUNDLE).text();
    expect(text).toContain("Snapshot");
    expect(text).toContain("Restore");
    expect(text).toContain("Step");
  });
});

describe("Phase 20 — index.html and styles host the new surface", () => {
  test("index.html keeps legacy slots and adds workspace + inspector slots", async () => {
    const html = await Bun.file(join(DEMO, "index.html")).text();
    // Phase 18 anchors stay so the older smoke test remains valid.
    for (const id of ["controls-slot", "led-slot", "button-slot", "pwm-slot", "serial-slot"]) {
      expect(html).toContain(id);
    }
    // Phase 20 mount points.
    expect(html).toContain("workspace-slot");
    expect(html).toContain("inspector-slot");
  });

  test("styles cover workspace, wires, board and inspector", async () => {
    const css = await Bun.file(join(DEMO, "src/styles.css")).text();
    for (const selector of [
      ".workspace",
      ".wire",
      ".node",
      ".board-pin",
      ".pin-state",
      ".button-state",
      ".inspector-widget",
      ".flag-chip",
    ]) {
      expect(css).toContain(selector);
    }
  });
});

describe("Phase 20 — new sources stay on the public facade", () => {
  const sources = [
    "src/main.ts",
    "src/runtime.ts",
    "src/workspace.ts",
    "src/components/board.ts",
    "src/components/inspector.ts",
    "src/components/led.ts",
    "src/components/button.ts",
    "src/components/pwm-display.ts",
  ];

  const forbidden = [
    { pattern: /\bavr\.cpu\.(write|setExecutor|install)/, reason: "no direct CPU writes/hooks" },
    { pattern: /\bnew\s+(Gpio|Timer0|Timer1|Timer2|Usart0|Adc|Eeprom|Spi|Twi|Watchdog)\b/, reason: "no manual peripheral wiring" },
    { pattern: /\bavr\.cpu\.flash\b\s*=/, reason: "no direct flash writes" },
    { pattern: /\bavr\.cpu\.data\b\s*=/, reason: "no direct data-space writes" },
    { pattern: /\battachPeripheral\b/, reason: "no manual attachPeripheral" },
    { pattern: /\bcpu\.data\[[^\]]+\]\s*=/, reason: "inspector must read CPU state, not write it" },
  ];

  for (const rel of sources) {
    test(`${rel} does not bypass the facade`, async () => {
      const text = await Bun.file(join(DEMO, rel)).text();
      for (const { pattern, reason } of forbidden) {
        if (pattern.test(text)) {
          throw new Error(`${rel} violates the public-only rule (${reason}); matched ${pattern}`);
        }
      }
    });
  }

  test("wiring model rebinds components through the facade", async () => {
    const workspace = await Bun.file(join(DEMO, "src/workspace.ts")).text();
    const main = await Bun.file(join(DEMO, "src/main.ts")).text();
    expect(workspace).toContain("onBind");
    expect(workspace).toContain("=== false");
    // main maps component ids back to each widget's setPin.
    expect(main).toContain("setPin");
    expect(main).toContain("onBind");
  });

  test("program changes and uploads restart the simulator", async () => {
    const main = await Bun.file(join(DEMO, "src/main.ts")).text();
    expect(main).toContain("programSelect.addEventListener");
    expect(main).toContain("fileInput.addEventListener");

    const programChange = main.slice(
      main.indexOf('programSelect.addEventListener("change"'),
      main.indexOf("// File upload"),
    );
    const fileUpload = main.slice(main.indexOf('fileInput.addEventListener("change"'));
    expect(programChange).toContain("runtime.start()");
    expect(fileUpload).toContain("runtime.start()");
  });

  test("board and controls expose live visual state", async () => {
    const board = await Bun.file(join(DEMO, "src/components/board.ts")).text();
    const controls = await Bun.file(join(DEMO, "src/components/controls.ts")).text();
    const button = await Bun.file(join(DEMO, "src/components/button.ts")).text();

    expect(board).toContain("runtime.onPinChange");
    expect(board).toContain("pin-state");
    expect(controls).toContain("requestAnimationFrame");
    expect(button).toContain("root.dataset.state");
    expect(button).toContain("aria-pressed");
  });

  test("inspector drives debugging through the worker debugger protocol", async () => {
    const inspector = await Bun.file(join(DEMO, "src/components/inspector.ts")).text();
    expect(inspector).toContain("worker.step()");
    expect(inspector).toContain("worker.setBreakpoint(");
    expect(inspector).toContain("worker.watchData(");
    expect(inspector).toContain("worker.readRegisters(");
  });
});
