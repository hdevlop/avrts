import type { AVRSpeed } from "../../../../src";
import type { SimulatorRuntime, SimulatorSnapshot } from "../runtime";

/**
 * Start / pause / resume / reset buttons plus speed selection (1x, 10x, max).
 * Also surfaces a live status line (running/paused, cycle count, simulated time).
 */
export interface ControlsHandle {
  element: HTMLElement;
  destroy(): void;
}

export function createControls(runtime: SimulatorRuntime): ControlsHandle {
  const root = document.createElement("div");
  root.className = "controls-widget";

  const runGroup = document.createElement("div");
  runGroup.className = "control-group run-group";

  const startBtn = button("Start", () => {
    runtime.start();
    refresh();
  });
  const pauseBtn = button("Pause", () => {
    runtime.pause();
    refresh();
  });
  const resumeBtn = button("Resume", () => {
    runtime.resume();
    refresh();
  });
  const resetBtn = button("Reset", () => {
    runtime.reset();
    refresh();
  });
  runGroup.append(startBtn, pauseBtn, resumeBtn, resetBtn);

  const debugGroup = document.createElement("div");
  debugGroup.className = "control-group debug-group";
  let snapshot: SimulatorSnapshot | null = null;
  const stepBtn = button("Step", () => {
    runtime.step();
    refresh();
  });
  const snapshotBtn = button("Snapshot", async () => {
    snapshotBtn.disabled = true;
    snapshot = await runtime.snapshot();
    restoreBtn.disabled = false;
    refresh();
  });
  const restoreBtn = button("Restore", async () => {
    if (snapshot) await runtime.restore(snapshot);
    refresh();
  });
  restoreBtn.disabled = true;
  debugGroup.append(stepBtn, snapshotBtn, restoreBtn);

  const speedGroup = document.createElement("div");
  speedGroup.className = "control-group speed-group";
  const speedLabel = document.createElement("span");
  speedLabel.className = "control-label";
  speedLabel.textContent = "Speed";
  speedGroup.append(speedLabel);

  const speedButtons = new Map<AVRSpeed, HTMLButtonElement>();
  for (const speed of [0.25, 1, 10, "max"] as AVRSpeed[]) {
    const speedBtn = button(String(speed), () => {
      runtime.setSpeed(speed);
      refresh();
    });
    speedButtons.set(speed, speedBtn);
    speedGroup.append(speedBtn);
  }

  const status = document.createElement("div");
  status.className = "status";
  status.setAttribute("aria-live", "polite");

  root.append(runGroup, debugGroup, speedGroup, status);

  function refresh(): void {
    const s = runtime.status();
    const runtimeState = s.running ? (s.paused ? "paused" : "running") : "stopped";
    root.dataset.runtime = runtimeState;
    status.textContent =
      `${runtimeState} | speed ${s.speed} | ${s.cycles.toLocaleString()} cycles | ` +
      `${s.timeMs.toFixed(2)} ms`;

    startBtn.disabled = s.running && !s.paused;
    pauseBtn.disabled = !s.running || s.paused;
    resumeBtn.disabled = !s.running || !s.paused;
    snapshotBtn.disabled = false;
    restoreBtn.disabled = snapshot === null;

    for (const [speed, speedBtn] of speedButtons) {
      speedBtn.classList.toggle("active", s.speed === speed);
    }
  }

  refresh();
  const offs = [
    runtime.onStatusChange(refresh),
    runtime.onRefresh(refresh),
  ];

  const raf = (globalThis as {
    requestAnimationFrame?: (cb: () => void) => number;
  }).requestAnimationFrame;
  let rafHandle: number | null = null;
  let lastRafRefresh = 0;
  const loop = (): void => {
    const now = performance.now();
    if (now - lastRafRefresh >= 250) {
      refresh();
      lastRafRefresh = now;
    }
    if (raf) rafHandle = raf(loop);
  };
  if (raf) rafHandle = raf(loop);

  return {
    element: root,
    destroy() {
      for (const off of offs) off();
      if (rafHandle !== null) {
        (globalThis as { cancelAnimationFrame?: (h: number) => void }).cancelAnimationFrame?.(rafHandle);
      }
      root.remove();
    },
  };
}

function button(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", () => {
    void onClick();
  });
  return btn;
}
