import { defineConfig, devices } from "@playwright/test";

/**
 * Phase 20 - Playwright visual/behavioral smoke tests for the browser demo.
 *
 * Dev-only: this is NOT part of `bun test`. To run it locally / in CI:
 *
 *   bun add -d @playwright/test
 *   bunx playwright install chromium
 *   bun run test:e2e
 *
 * The web server builds the demo bundle and serves it on :5173 before the tests
 * run; Playwright tears it down afterwards.
 */
export default defineConfig({
  testDir: "examples/browser-simulator/tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "bun run demo",
    url: "http://localhost:5173",
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
