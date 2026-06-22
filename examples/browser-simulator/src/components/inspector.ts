import type { AVR } from "../../../../src";
import { SPL_ADDR, SPH_ADDR } from "../../../../src";

/**
 * Debugger / register inspector panel.
 *
 * Reads live CPU state through `avr.cpu` (the documented read-only inspection
 * escape hatch — it never writes) and drives the debugger primitives through the
 * public facade: `step()`, `breakpoint()`, `clearBreakpoint()`, `watchData()`.
 *
 * It refreshes once per animation frame while values change, plus immediately on
 * lifecycle events (pause/step/reset/restore/breakpoint).
 */
export interface InspectorHandle {
  element: HTMLElement;
  destroy(): void;
}

const FLAG_NAMES = ["I", "T", "H", "S", "V", "N", "Z", "C"] as const;

function hex(value: number, width: number): string {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

/** Parse a "0x1234" / "1234" hex string, or NaN. */
function parseHex(text: string): number {
  const trimmed = text.trim().replace(/^0x/i, "");
  if (trimmed === "" || /[^0-9a-f]/i.test(trimmed)) return NaN;
  return parseInt(trimmed, 16);
}

export function createInspector(avr: AVR): InspectorHandle {
  const root = document.createElement("div");
  root.className = "inspector-widget";

  const title = document.createElement("div");
  title.className = "inspector-title";
  title.textContent = "CPU inspector";

  // --- status line ---
  const statusLine = document.createElement("div");
  statusLine.className = "inspector-status";

  // --- SREG flags ---
  const flagsRow = document.createElement("div");
  flagsRow.className = "inspector-flags";
  const flagEls = new Map<(typeof FLAG_NAMES)[number], HTMLElement>();
  for (const name of FLAG_NAMES) {
    const chip = document.createElement("span");
    chip.className = "flag-chip";
    chip.dataset.flag = name;
    chip.textContent = name;
    flagsRow.append(chip);
    flagEls.set(name, chip);
  }

  // --- registers ---
  const regGrid = document.createElement("div");
  regGrid.className = "inspector-registers";
  const regEls: HTMLElement[] = [];
  for (let r = 0; r < 32; r += 1) {
    const cell = document.createElement("div");
    cell.className = "reg-cell";
    const name = document.createElement("span");
    name.className = "reg-name";
    name.textContent = `R${r}`;
    const value = document.createElement("span");
    value.className = "reg-value";
    cell.append(name, value);
    regGrid.append(cell);
    regEls.push(value);
  }

  // --- debugger controls ---
  const debugRow = document.createElement("div");
  debugRow.className = "inspector-debug";

  const stepBtn = document.createElement("button");
  stepBtn.type = "button";
  stepBtn.className = "step-btn";
  stepBtn.textContent = "Step";
  stepBtn.addEventListener("click", () => {
    avr.step();
    render(true);
  });

  const bpInput = document.createElement("input");
  bpInput.type = "text";
  bpInput.className = "bp-input";
  bpInput.placeholder = "PC hex e.g. 0x100";
  bpInput.autocomplete = "off";

  const bpAdd = document.createElement("button");
  bpAdd.type = "button";
  bpAdd.textContent = "Breakpoint";
  bpAdd.addEventListener("click", () => {
    const pc = parseHex(bpInput.value);
    if (Number.isNaN(pc)) return;
    avr.breakpoint({ pc });
    log(`breakpoint @ 0x${hex(pc, 4)}`);
  });

  const bpClear = document.createElement("button");
  bpClear.type = "button";
  bpClear.textContent = "Clear BPs";
  bpClear.addEventListener("click", () => {
    avr.clearBreakpoints();
    log("cleared all breakpoints");
  });

  const watchInput = document.createElement("input");
  watchInput.type = "text";
  watchInput.className = "watch-input";
  watchInput.placeholder = "Watch addr e.g. 0x25";
  watchInput.autocomplete = "off";

  const watchBtn = document.createElement("button");
  watchBtn.type = "button";
  watchBtn.textContent = "Watch";
  watchBtn.addEventListener("click", () => {
    const addr = parseHex(watchInput.value);
    if (Number.isNaN(addr)) return;
    avr.watchData(addr, (event) => {
      log(`watch 0x${hex(event.address, 4)}: 0x${hex(event.oldValue, 2)} → 0x${hex(event.value, 2)}`);
    });
    log(`watching 0x${hex(addr, 4)}`);
  });

  debugRow.append(stepBtn, bpInput, bpAdd, bpClear, watchInput, watchBtn);

  const logEl = document.createElement("pre");
  logEl.className = "inspector-log";
  logEl.setAttribute("aria-live", "polite");

  root.append(title, statusLine, flagsRow, regGrid, debugRow, logEl);

  function log(message: string): void {
    logEl.textContent = `${message}\n${logEl.textContent ?? ""}`.slice(0, 4000);
  }

  // --- rendering ---
  const cpu = avr.cpu;
  let lastSignature = "";

  function readSp(): number {
    return cpu.data[SPL_ADDR]! | (cpu.data[SPH_ADDR]! << 8);
  }

  function render(force = false): void {
    // Cheap change-detection so we don't thrash the DOM every frame.
    const signature = `${cpu.pc}:${cpu.cycles}:${cpu.sreg.value}`;
    if (!force && signature === lastSignature) return;
    lastSignature = signature;

    statusLine.textContent =
      `PC 0x${hex(cpu.pc, 4)} · SP 0x${hex(readSp(), 4)} · ${cpu.cycles} cycles`;

    for (const name of FLAG_NAMES) {
      flagEls.get(name)!.classList.toggle("set", cpu.sreg[name]);
    }
    for (let r = 0; r < 32; r += 1) {
      regEls[r]!.textContent = hex(cpu.data[r]!, 2);
    }
  }

  render(true);

  const offs = [
    avr.on("reset", () => render(true)),
    avr.on("load", () => render(true)),
    avr.on("clear", () => render(true)),
    avr.on("restore", () => render(true)),
    avr.on("pause", () => render(true)),
    avr.on("breakpoint", (event) => {
      render(true);
      if (event.pc !== undefined) log(`hit breakpoint @ 0x${hex(event.pc, 4)}`);
    }),
    avr.on("error", (event) => {
      render(true);
      log(`error: ${String(event.error)}`);
    }),
  ];

  // Poll while the page is alive so registers update during a run.
  const raf = (globalThis as {
    requestAnimationFrame?: (cb: () => void) => number;
  }).requestAnimationFrame;
  let rafHandle: number | null = null;
  let lastRafRender = 0;
  const loop = (): void => {
    const now = performance.now();
    if (now - lastRafRender >= 250) {
      render();
      lastRafRender = now;
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
