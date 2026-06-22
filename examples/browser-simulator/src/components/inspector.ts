import type { AVRWorkerRuntime } from "../../../../src";

/**
 * Debugger / register inspector panel (worker-backed).
 *
 * The CPU lives in the worker, so the inspector renders from `registers` events
 * (requested via `worker.readRegisters()`) and drives debugging through the
 * worker protocol: `step()`, `setBreakpoint()`, `clearBreakpoints()`,
 * `watchData()`. Register state refreshes on a throttled poll plus immediately
 * after step / breakpoint events.
 */
export interface InspectorHandle {
  element: HTMLElement;
  destroy(): void;
}

const FLAG_NAMES = ["I", "T", "H", "S", "V", "N", "Z", "C"] as const; // SREG bit 7..0

function hex(value: number, width: number): string {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

/** Parse a "0x1234" / "1234" hex string, or NaN. */
function parseHex(text: string): number {
  const trimmed = text.trim().replace(/^0x/i, "");
  if (trimmed === "" || /[^0-9a-f]/i.test(trimmed)) return NaN;
  return parseInt(trimmed, 16);
}

export function createInspector(worker: AVRWorkerRuntime): InspectorHandle {
  const root = document.createElement("div");
  root.className = "inspector-widget";

  const title = document.createElement("div");
  title.className = "inspector-title";
  title.textContent = "CPU inspector";

  const statusLine = document.createElement("div");
  statusLine.className = "inspector-status";
  statusLine.textContent = "PC ---- · SP ---- · 0 cycles";

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
    value.textContent = "--";
    cell.append(name, value);
    regGrid.append(cell);
    regEls.push(value);
  }

  const debugRow = document.createElement("div");
  debugRow.className = "inspector-debug";

  const stepBtn = document.createElement("button");
  stepBtn.type = "button";
  stepBtn.className = "step-btn";
  stepBtn.textContent = "Step";
  stepBtn.addEventListener("click", () => {
    worker.step();
    worker.readRegisters();
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
    worker.setBreakpoint(pc);
    log(`breakpoint @ 0x${hex(pc, 4)}`);
  });

  const bpClear = document.createElement("button");
  bpClear.type = "button";
  bpClear.textContent = "Clear BPs";
  bpClear.addEventListener("click", () => {
    worker.clearBreakpoints();
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
    worker.watchData(addr);
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

  const renderRegisters = (event: {
    pc: number;
    sp: number;
    sreg: number;
    cycles: number;
    registers: number[];
  }): void => {
    statusLine.textContent =
      `PC 0x${hex(event.pc, 4)} · SP 0x${hex(event.sp, 4)} · ${event.cycles} cycles`;
    FLAG_NAMES.forEach((name, index) => {
      flagEls.get(name)!.classList.toggle("set", ((event.sreg >> (7 - index)) & 1) === 1);
    });
    for (let r = 0; r < 32; r += 1) {
      regEls[r]!.textContent = hex(event.registers[r] ?? 0, 2);
    }
  };

  const offs = [
    worker.on("registers", renderRegisters),
    worker.on("breakpoint", (event) => {
      log(`hit breakpoint @ 0x${hex(event.pc, 4)}`);
      worker.readRegisters();
    }),
    worker.on("watchFrame", (event) => {
      for (const frame of event.events) {
        for (const write of frame.writes) {
          log(`watch 0x${hex(frame.address, 4)}: 0x${hex(write.oldValue, 2)} → 0x${hex(write.value, 2)}`);
        }
      }
    }),
    worker.on("error", (event) => log(`error: ${event.message}`)),
    // Refresh immediately on any status change (pause / step / restore / reset),
    // so the inspector is correct even when rAF would be throttled.
    worker.on("status", () => worker.readRegisters()),
  ];

  // Poll on a timer (not rAF, which Chrome suspends in backgrounded tabs) so the
  // registers track a running sketch without flooding the worker.
  worker.readRegisters();
  const pollHandle = setInterval(() => worker.readRegisters(), 250);

  return {
    element: root,
    destroy() {
      for (const off of offs) off();
      clearInterval(pollHandle);
      root.remove();
    },
  };
}
