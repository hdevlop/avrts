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

const workspace = createWorkspace({
  onBind: (componentId, pin) => {
    if (pin === null) return true;
    return rebind[componentId]?.(pin) ?? false;
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
document.getElementById("serial-slot")!.replaceWith(serial.element);
document.getElementById("inspector-slot")!.replaceWith(inspector.element);
document.querySelector(".side-panels")?.append(analyzer.element);

// Draw the default wires (which also binds each component through onBind).
for (const node of ioNodes) workspace.connect(node.id, node.pin);

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
