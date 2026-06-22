import type { LogicSampleRecord } from "../../../../src";
import type { SimulatorRuntime } from "../runtime";

/**
 * Logic analyzer instrument. Drives the runtime's exact-edge capture
 * (`captureEdges` / `onEdges`) — in worker mode these are the non-coalesced
 * edges shipped as `logicChunk`, so the waveform is accurate even for fast
 * PWM/tone output that the coalesced frame stream would miss.
 */
const SVG_NS = "http://www.w3.org/2000/svg";

export interface LogicAnalyzerOptions {
  pins: number[];
  capacity?: number;
}

export interface LogicAnalyzerHandle {
  element: HTMLElement;
  destroy(): void;
}

export function createLogicAnalyzer(
  runtime: SimulatorRuntime,
  options: LogicAnalyzerOptions,
): LogicAnalyzerHandle {
  const pins = [...options.pins];
  const capacity = Math.max(64, options.capacity ?? 2048);
  const samples: LogicSampleRecord[] = [];

  const root = document.createElement("div");
  root.className = "analyzer-widget";

  const title = document.createElement("div");
  title.className = "analyzer-title";
  title.textContent = `Logic analyzer · D${pins.join(", D")}`;

  const controls = document.createElement("div");
  controls.className = "analyzer-controls";
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    samples.length = 0;
    render();
  });
  const vcdBtn = document.createElement("button");
  vcdBtn.type = "button";
  vcdBtn.textContent = "Download VCD";
  vcdBtn.addEventListener("click", () => downloadVCD(pins, samples));
  controls.append(clearBtn, vcdBtn);

  const rows = document.createElement("div");
  rows.className = "analyzer-rows";
  const rowEls = new Map<number, { level: HTMLElement; count: HTMLElement; path: SVGPolylineElement }>();
  for (const pin of pins) {
    const row = document.createElement("div");
    row.className = "analyzer-row";

    const label = document.createElement("span");
    label.className = "analyzer-label";
    label.textContent = `D${pin}`;

    const level = document.createElement("span");
    level.className = "analyzer-level";

    const count = document.createElement("span");
    count.className = "analyzer-count";

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("analyzer-wave");
    svg.setAttribute("viewBox", "0 0 200 24");
    svg.setAttribute("preserveAspectRatio", "none");
    const path = document.createElementNS(SVG_NS, "polyline");
    path.classList.add("analyzer-trace");
    svg.append(path);

    row.append(label, level, count, svg);
    rows.append(row);
    rowEls.set(pin, { level, count, path });
  }

  root.append(title, controls, rows);

  function render(): void {
    for (const pin of pins) {
      const pinSamples = samples.filter((s) => s.pin === pin);
      const el = rowEls.get(pin)!;
      const last = pinSamples.at(-1);
      el.level.textContent = last ? (last.high ? "HIGH" : "LOW") : "—";
      el.level.dataset.state = last?.high ? "high" : "low";
      el.count.textContent = `${pinSamples.length} edges`;
      el.path.setAttribute("points", stepPoints(pinSamples));
    }
  }

  // Re-render on a timer so a fast capture doesn't thrash the DOM per edge.
  const off = runtime.onEdges((batch) => {
    for (const sample of batch) {
      if (!pins.includes(sample.pin)) continue;
      samples.push(sample);
    }
    if (samples.length > capacity) samples.splice(0, samples.length - capacity);
  });
  const timer = setInterval(render, 200);
  runtime.captureEdges(pins, "demo-analyzer");
  render();

  return {
    element: root,
    destroy() {
      off();
      clearInterval(timer);
      runtime.stopCapture();
      root.remove();
    },
  };
}

/** Build an SVG step polyline (200x24 viewBox) from a pin's recent edges. */
function stepPoints(pinSamples: LogicSampleRecord[]): string {
  if (pinSamples.length === 0) return "";
  const recent = pinSamples.slice(-64);
  const first = recent[0]!.cycles;
  const last = recent.at(-1)!.cycles;
  const span = Math.max(1, last - first);
  const yFor = (high: boolean): number => (high ? 3 : 21);
  const points: string[] = [];
  let prevY = yFor(recent[0]!.high);
  for (const sample of recent) {
    const x = ((sample.cycles - first) / span) * 200;
    const y = yFor(sample.high);
    points.push(`${x.toFixed(1)},${prevY}`); // horizontal hold
    points.push(`${x.toFixed(1)},${y}`); // vertical transition
    prevY = y;
  }
  points.push(`200,${prevY}`);
  return points.join(" ");
}

/** Export captured edges as a VCD file and trigger a download. */
function downloadVCD(pins: number[], samples: LogicSampleRecord[]): void {
  const symbolOf = new Map<number, string>();
  pins.forEach((pin, index) => symbolOf.set(pin, String.fromCharCode(33 + index)));
  const lines: string[] = [
    "$timescale 1 ns $end",
    "$scope module avrts $end",
    ...pins.map((pin) => `$var wire 1 ${symbolOf.get(pin)} D${pin} $end`),
    "$upscope $end",
    "$enddefinitions $end",
  ];
  let lastCycle = -1;
  for (const sample of samples) {
    if (sample.cycles !== lastCycle) {
      lines.push(`#${sample.cycles}`);
      lastCycle = sample.cycles;
    }
    lines.push(`${sample.high ? 1 : 0}${symbolOf.get(sample.pin)}`);
  }
  const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "capture.vcd";
  a.click();
  URL.revokeObjectURL(url);
}
