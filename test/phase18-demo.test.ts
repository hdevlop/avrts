import { describe, expect, test, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Smoke tests for the browser-simulator demo. We don't open a real browser —
 * instead we verify that the demo bundle builds, contains the expected HEX
 * content, and that the static server actually serves every asset.
 */

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "examples/browser-simulator/dist");
const BUNDLE = join(DIST, "main.js");

beforeAll(() => {
  mkdirSync(DIST, { recursive: true });
  const result = spawnSync("bun", [
    "build",
    "examples/browser-simulator/src/main.ts",
    "--outdir",
    "examples/browser-simulator/dist",
    "--target",
    "browser",
    "--minify",
  ], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
});

describe("Phase 18 — browser simulator demo", () => {
  test("build:demo produces a bundle with the embedded HEX files", () => {
    expect(existsSync(BUNDLE)).toBe(true);
  });

  test("bundle contains all committed HEX programs", async () => {
    const text = await Bun.file(BUNDLE).text();
    const digital = await Bun.file(
      join(ROOT, "examples/arduino-digital-read/arduino-digital-read.ino.hex"),
    ).text();
    const serial = await Bun.file(
      join(ROOT, "examples/arduino-serial-print/arduino-serial-print.ino.hex"),
    ).text();
    const analog = await Bun.file(
      join(ROOT, "examples/arduino-analog-write/arduino-analog-write.ino.hex"),
    ).text();
    const exti = await Bun.file(
      join(ROOT, "examples/attachInterrupt-blink/attachInterrupt-blink.hex"),
    ).text();

    // Match a distinctive snippet from each HEX (the first record after the
    // reset vector setup) so we know the actual content is in the bundle.
    expect(text).toContain(digital.split("\n")[0]!.slice(0, 24));
    expect(text).toContain(serial.split("\n")[0]!.slice(0, 24));
    expect(text).toContain(analog.split("\n")[0]!.slice(0, 24));
    expect(text).toContain(exti.split("\n")[0]!.slice(0, 24));
  });

  test("bundle references every demo widget (LED/button/PWM/serial/controls)", async () => {
    const text = await Bun.file(BUNDLE).text();
    expect(text).toContain("led-widget");
    expect(text).toContain("button-widget");
    expect(text).toContain("pwm-widget");
    expect(text).toContain("serial-widget");
    expect(text).toContain("controls-widget");
  });

  test("demo opts into browser-friendly pin event coalescing", async () => {
    const text = await Bun.file(join(ROOT, "examples/browser-simulator/src/main.ts")).text();
    expect(text).toContain("eventCoalescing");
    expect(text).toContain("pins: true");
  });

  test("bundle is reasonably sized (proves it actually bundled the simulator)", async () => {
    const text = await Bun.file(BUNDLE).text();
    // The simulator + fixture HEX files should land comfortably above 50 KB. If this
    // ever drops sharply, something failed to bundle.
    expect(text.length).toBeGreaterThan(50_000);
  });
});

describe("Phase 18 — demo static server", () => {
  let baseUrl: string;
  let server: ReturnType<typeof Bun.serve> | null = null;
  const PORT = 5174;

  beforeAll(async () => {
    server = Bun.serve({
      port: PORT,
      async fetch(req) {
        const url = new URL(req.url);
        let path = url.pathname === "/" ? "/index.html" : url.pathname;
        const filePath = join(ROOT, "examples/browser-simulator", path);
        const file = Bun.file(filePath);
        if (!(await file.exists())) return new Response("Not found", { status: 404 });
        return new Response(file);
      },
    });
    baseUrl = `http://localhost:${PORT}`;
  });

  test("serves index.html at /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>avrts browser simulator</title>");
    expect(html).toContain("program-select");
    expect(html).toContain("controls-slot");
    expect(html).toContain("led-slot");
    expect(html).toContain("button-slot");
    expect(html).toContain("pwm-slot");
    expect(html).toContain("serial-slot");
    expect(html).toContain("./dist/main.js");
  });

  test("serves the bundled main.js", async () => {
    const res = await fetch(`${baseUrl}/dist/main.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(50_000);
  });

  test("serves src/styles.css with the LED/PWM/serial styles", async () => {
    const res = await fetch(`${baseUrl}/src/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/css/);
    const css = await res.text();
    expect(css).toContain(".led-widget");
    expect(css).toContain(".pwm-widget");
    expect(css).toContain(".serial-widget");
  });

  test("returns 404 for missing paths", async () => {
    const res = await fetch(`${baseUrl}/no-such-file`);
    expect(res.status).toBe(404);
  });
});

describe("Phase 18 — demo uses only the public facade", () => {
  const componentsDir = join(ROOT, "examples/browser-simulator/src");
  const sources = ["main.ts", "components/led.ts", "components/button.ts",
    "components/pwm-display.ts", "components/serial-monitor.ts",
    "components/controls.ts"];

  // Patterns that would mean reaching past the facade. Kept narrow so this is
  // a real regression guard, not a vibe check.
  const forbidden = [
    { pattern: /\bavr\.cpu\.(write|setExecutor|install)/, reason: "no direct CPU writes/hooks" },
    { pattern: /\bnew\s+(Gpio|Timer0|Timer1|Timer2|Usart0|Adc|Eeprom|Spi|Twi|Watchdog)\b/, reason: "no manual peripheral wiring" },
    { pattern: /\bavr\.cpu\.flash\b\s*=/, reason: "no direct flash writes" },
    { pattern: /\bavr\.cpu\.data\b\s*=/, reason: "no direct data-space writes" },
    { pattern: /\battachPeripheral\b/, reason: "no manual attachPeripheral" },
  ];

  for (const rel of sources) {
    test(`${rel} does not bypass the facade`, async () => {
      const text = await Bun.file(join(componentsDir, rel)).text();
      for (const { pattern, reason } of forbidden) {
        if (pattern.test(text)) {
          throw new Error(`${rel} violates the public-only rule (${reason}); matched ${pattern}`);
        }
      }
    });
  }

  test("visual widgets refresh from simulator runtime events", async () => {
    const led = await Bun.file(join(componentsDir, "components/led.ts")).text();
    const pwm = await Bun.file(join(componentsDir, "components/pwm-display.ts")).text();
    const serial = await Bun.file(join(componentsDir, "components/serial-monitor.ts")).text();

    for (const text of [led, pwm, serial]) {
      expect(text).toContain("runtime.onRefresh");
    }
    expect(serial).toContain("runtime.serialText()");
  });
});
