import { createAVRWorkerRuntime } from "../../../src";
import digitalReadHex from "../../arduino-digital-read/arduino-digital-read.ino.hex" with { type: "text" };
import serialPrintHex from "../../arduino-serial-print/arduino-serial-print.ino.hex" with { type: "text" };
import analogWriteHex from "../../arduino-analog-write/arduino-analog-write.ino.hex" with { type: "text" };
import attachInterruptHex from "../../attachInterrupt-blink/attachInterrupt-blink.hex" with { type: "text" };

import { createLed } from "./components/led";
import { createButton } from "./components/button";
import { createPwmDisplay } from "./components/pwm-display";
import { createSerialMonitor } from "./components/serial-monitor";
import { createControls } from "./components/controls";
import { createBoard } from "./components/board";
import { createInspector } from "./components/inspector";
import { createLogicAnalyzer } from "./components/logic-analyzer";
import { wrapWorkerSimulatorRuntime } from "./runtime";
import { createWorkspace } from "./workspace";

/**
 * Built-in programs. The drop-down lets users switch between them at runtime;
 * `avr.useHex(...)` resets the simulator without rebuilding listeners, so all
 * widgets stay bound.
 */
const PROGRAMS: Record<string, { label: string; hex: string }> = {
  "arduino-digital-read": {
    label: "Arduino digital-read (LED + button on pin 2)",
    hex: digitalReadHex,
  },
  "arduino-serial-print": {
    label: "Arduino serial print (hello avrts)",
    hex: serialPrintHex,
  },
  "arduino-analog-write": {
    label: "Arduino analog write (PWM on pins 3, 5, 9, 10, 11)",
    hex: analogWriteHex,
  },
  "attachInterrupt-blink": {
    label: "attachInterrupt (rising-edge ISR toggles LED on pin 13)",
    hex: attachInterruptHex,
  },
};

const initial = "arduino-digital-read";

// Phase 21E: run the AVR core in a Web Worker so the main thread stays
// responsive at normal speed. The worker bundle is emitted by `bun run
// build:worker` to ./dist/browser-worker.js (served alongside this bundle).
const worker = createAVRWorkerRuntime({
  worker: new Worker("./dist/browser-worker.js", { type: "module" }),
  hex: PROGRAMS[initial]!.hex,
  speed: 1,
});
const runtime = wrapWorkerSimulatorRuntime(worker);

// Build the draggable widgets. They subscribe to the worker-backed runtime and
// stay attached across program switches, so we build them once.
const led = createLed(runtime, { pin: 13, label: "LED" });
const button = createButton(runtime, { pin: 2, label: "Button" });
const pwm = createPwmDisplay(runtime, { pin: 9, label: "PWM" });
const serial = createSerialMonitor(runtime, { label: "Serial (9600 baud)" });
const controls = createControls(runtime);
const inspector = createInspector(worker);
const board = createBoard(runtime);
const analyzer = createLogicAnalyzer(runtime, { pins: [9, 13] });

// Map each draggable component id back to its setPin, so the wiring model can
// rebind it through the facade.
const rebind: Record<string, (pin: number) => boolean> = {
  led: led.setPin,
  button: button.setPin,
  pwm: pwm.setPin,
};

// Assigned by the mode shell below; called whenever wiring changes.
let refreshConnections: () => void = () => {};

const workspace = createWorkspace({
  onBind: (componentId, pin) => {
    if (pin === null) {
      refreshConnections();
      return true;
    }
    const bound = rebind[componentId]?.(pin) ?? false;
    if (bound) refreshConnections();
    return bound;
  },
});

// Mount the board and the three wireable I/O components as draggable nodes.
workspace.addNode(board.element, { x: 24, y: 24, title: "Board" });
for (const port of board.ports) {
  workspace.addPort(port.el, { id: `pin:${port.pin}`, kind: "pin", pin: port.pin });
}

const ioNodes: Array<{ id: string; el: HTMLElement; port: HTMLElement; pin: number; x: number; y: number }> = [
  { id: "led", el: led.element, port: led.port, pin: 13, x: 520, y: 24 },
  { id: "button", el: button.element, port: button.port, pin: 2, x: 520, y: 230 },
  { id: "pwm", el: pwm.element, port: pwm.port, pin: 9, x: 520, y: 400 },
];
for (const node of ioNodes) {
  workspace.addNode(node.el, { x: node.x, y: node.y, title: node.id });
  workspace.addPort(node.port, { id: `component:${node.id}`, kind: "component", component: node.id });
}

document.getElementById("workspace-slot")!.append(workspace.element);
document.getElementById("controls-slot")!.replaceWith(controls.element);

// --- Circuit / Run / Debug mode shell ---
// The workspace (board + draggable parts) is the shared stage, always visible.
// Tabs swap the right-hand panel and which control groups show (via body[data-mode]).
const sidePanels = document.querySelector(".side-panels")!;
document.getElementById("serial-slot")?.remove();
document.getElementById("inspector-slot")?.remove();

const modePanel = (mode: string): HTMLElement => {
  const panel = document.createElement("div");
  panel.className = "mode-panel";
  panel.dataset.mode = mode;
  return panel;
};

const circuitPanel = modePanel("circuit");
const runPanel = modePanel("run");
const debugPanel = modePanel("debug");
runPanel.append(serial.element);
debugPanel.append(inspector.element, analyzer.element);

const connTitle = document.createElement("div");
connTitle.className = "panel-title";
connTitle.textContent = "Connections";
const connList = document.createElement("ul");
connList.className = "conn-list";
const connHint = document.createElement("p");
connHint.className = "panel-hint";
connHint.textContent =
  "Drag a wire from a component's connector dot to a board pin to (re)bind it. PWM only accepts PWM pins (~).";
const circuitCard = document.createElement("div");
circuitCard.append(connTitle, connList, connHint);
circuitPanel.append(circuitCard);
sidePanels.append(circuitPanel, runPanel, debugPanel);

refreshConnections = (): void => {
  const conns = [...workspace.connections()].sort((a, b) => a.componentId.localeCompare(b.componentId));
  connList.replaceChildren(
    ...conns.map((c) => {
      const li = document.createElement("li");
      li.textContent = `${c.componentId} → D${c.pin}`;
      return li;
    }),
  );
};

const MODES: Array<[string, string]> = [
  ["circuit", "Circuit"],
  ["run", "Run"],
  ["debug", "Debug"],
];
const tabBar = document.createElement("nav");
tabBar.className = "mode-tabs";
const tabButtons = new Map<string, HTMLButtonElement>();
const panels: Record<string, HTMLElement> = { circuit: circuitPanel, run: runPanel, debug: debugPanel };

const setMode = (mode: string): void => {
  document.body.dataset.mode = mode;
  for (const [m, b] of tabButtons) b.classList.toggle("active", m === mode);
  for (const [m, p] of Object.entries(panels)) p.classList.toggle("active", m === mode);
  if (mode === "circuit") refreshConnections();
};

for (const [mode, labelText] of MODES) {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "mode-tab";
  tab.dataset.mode = mode;
  tab.textContent = labelText;
  tab.addEventListener("click", () => setMode(mode));
  tabButtons.set(mode, tab);
  tabBar.append(tab);
}
document.querySelector("main.layout")!.before(tabBar);

// Draw the default wires (which also binds each component through onBind).
for (const node of ioNodes) workspace.connect(node.id, node.pin);
refreshConnections();
setMode("run"); // start in Run: running sketch + serial, with the stage visible

// Program selector.
const programSelect = document.getElementById("program-select") as HTMLSelectElement;
programSelect.value = initial;
programSelect.addEventListener("change", () => {
  const choice = PROGRAMS[programSelect.value];
  if (!choice) return;
  runtime.stop();
  runtime.loadHex(choice.hex);
  runtime.start();
});

// File upload via the public `loadFile` API.
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const uploadBtn = document.getElementById("upload-btn") as HTMLButtonElement;
uploadBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  runtime.stop();
  await runtime.loadFile(file);
  runtime.start();
  fileInput.value = "";
});

// Auto-start so the demo "just works" on load.
runtime.start();
