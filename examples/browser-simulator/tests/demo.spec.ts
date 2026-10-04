import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 20 browser-demo smoke tests. These drive the real UI through the public
 * facade only (there is no test-only hook into the page).
 */

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // The app starts in Run mode; wait for the visible stage rather than hidden
  // Debug-panel content.
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.locator(".board-pin")).toHaveCount(14);
});

async function openDebug(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Debug" }).click();
  await expect(page.locator(".inspector-registers .reg-cell").first()).toBeVisible();
}

/**
 * Pause only once the worker reports it is running, then wait for the worker to
 * confirm the pause. Clicking Pause before the program starts is a no-op, and a
 * snapshot taken then would restore into a running simulator.
 */
async function pauseRunningSimulator(page: Page): Promise<void> {
  const controls = page.locator(".controls-widget");
  await expect(controls).toHaveAttribute("data-runtime", "running");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(controls).toHaveAttribute("data-runtime", "paused");
}

test("loads with workspace, board pins and CPU inspector", async ({ page }) => {
  await expect(page).toHaveTitle("avrts browser simulator");
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(page.locator(".board-pin")).toHaveCount(14);
  await openDebug(page);
  await expect(page.locator(".inspector-registers .reg-cell")).toHaveCount(32);
  await expect(page.locator(".inspector-status")).toContainText("PC 0x");
});

test("default wiring binds the LED to pin 13", async ({ page }) => {
  await expect(page.locator(".led-widget .led-caption")).toContainText("D13");
  // Both ends of the wire are marked connected.
  await expect(page.locator(".io-port.connected").first()).toBeVisible();
});

test("button press drives D2 and the LED state visibly", async ({ page }) => {
  const button = page.locator(".button-widget .button-press");
  await button.hover();
  await page.mouse.down();
  await expect(page.locator('.board-pin[data-pin="2"] .pin-state')).toHaveText("HIGH");
  await expect(page.locator(".button-widget .button-state")).toHaveText("HIGH");
  await page.mouse.up();
  await expect(page.locator(".button-widget .button-state")).toHaveText("LOW");
});

test("program changes keep the simulator running", async ({ page }) => {
  await page.locator("#program-select").selectOption("arduino-serial-print");
  await expect(page.locator(".status")).toContainText("running");
  await expect(page.locator(".serial-log")).toContainText("hello");
});

test("single-step advances the program counter", async ({ page }) => {
  await openDebug(page);
  await pauseRunningSimulator(page);
  const status = page.locator(".inspector-status");
  const before = await status.textContent();
  await page.locator(".inspector-widget .step-btn").click();
  await expect(status).not.toHaveText(before ?? "");
});

test("snapshot then restore rewinds CPU state", async ({ page }) => {
  await openDebug(page);
  await pauseRunningSimulator(page);
  const status = page.locator(".inspector-status");
  await page.getByRole("button", { name: "Snapshot" }).click();
  const snapped = await status.textContent();

  // Advance several instructions, then restore.
  for (let i = 0; i < 5; i += 1) await page.locator(".inspector-widget .step-btn").click();
  await expect(status).not.toHaveText(snapped ?? "");

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(status).toHaveText(snapped ?? "");
});

test("wiring model rebinds the LED to a new pin by dragging a wire", async ({ page }) => {
  const ledPort = page.locator(".led-widget .io-port");
  const pinD12 = page.locator(".board-pin").nth(12).locator(".pin-port");

  await ledPort.hover();
  await page.mouse.down();
  await pinD12.hover();
  await page.mouse.up();

  await expect(page.locator(".led-widget .led-caption")).toContainText("D12");
});

test("visual snapshot of the simulator surface", async ({ page }) => {
  // Pause so the screenshot is deterministic (no running counters).
  await page.getByRole("button", { name: "Pause" }).click();
  const shot = await page.locator(".layout").screenshot();
  expect(shot.length).toBeGreaterThan(20_000);
});
