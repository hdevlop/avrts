/**
 * Phase 20 - free-form workspace + simple wiring model.
 *
 * The workspace is a positioned canvas holding draggable "nodes" (component
 * cards and the board) over an SVG overlay that draws "wires" between "ports".
 *
 * A port is any small connector element registered with `addPort`. Ports come in
 * two kinds:
 *   - "pin"       : a board pin header (the wire target).
 *   - "component" : an I/O widget's single connector (the wire source).
 *
 * Dragging from one port to a compatible port of the other kind creates a wire.
 * Each component port holds at most one wire; rewiring it replaces the old one.
 * When a connection is made or removed the workspace invokes the `onBind`
 * callback so the demo can rebind the widget through the public facade.
 *
 * This file is pure DOM/SVG glue — it never touches the AVR facade directly.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export type PortKind = "pin" | "component";

export interface PortMeta {
  /** Stable id, unique within the workspace. */
  id: string;
  kind: PortKind;
  /** For "pin" ports: the Arduino pin number this header represents. */
  pin?: number;
  /** For "component" ports: the component id (passed back to onBind). */
  component?: string;
}

export interface Connection {
  componentId: string;
  pin: number;
}

export interface WorkspaceOptions {
  /**
   * Called whenever a component's wire changes. `pin` is the newly connected
   * Arduino pin, or `null` when the wire was removed.
   */
  onBind?: (componentId: string, pin: number | null) => boolean | void;
}

interface RegisteredPort {
  meta: PortMeta;
  el: HTMLElement;
}

interface Wire {
  componentId: string;
  pinPortId: string;
  line: SVGLineElement;
}

export interface NodeOptions {
  x: number;
  y: number;
  /** Optional accessible title shown on the drag handle. */
  title?: string;
}

export interface WorkspaceHandle {
  element: HTMLElement;
  /** Wrap `content` in a draggable node and place it at (x, y). */
  addNode(content: HTMLElement, options: NodeOptions): HTMLElement;
  /** Register a connector element so it can take part in wiring. */
  addPort(el: HTMLElement, meta: PortMeta): void;
  /** Programmatically connect a component port to a pin (used for defaults). */
  connect(componentId: string, pin: number): void;
  /** Current connections, useful for tests/inspection. */
  connections(): Connection[];
  destroy(): void;
}

export function createWorkspace(options: WorkspaceOptions = {}): WorkspaceHandle {
  const root = document.createElement("div");
  root.className = "workspace";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.classList.add("wire-layer");
  root.append(svg);

  const ports = new Map<string, RegisteredPort>();
  const wires = new Map<string, Wire>(); // keyed by componentId
  const cleanups: Array<() => void> = [];

  // --- geometry --------------------------------------------------------------

  /** Center of a port element, expressed in workspace-local coordinates. */
  function portCenter(el: HTMLElement): { x: number; y: number } {
    const portBox = el.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    return {
      x: portBox.left - rootBox.left + portBox.width / 2,
      y: portBox.top - rootBox.top + portBox.height / 2,
    };
  }

  function routeWire(wire: Wire): void {
    const compPort = ports.get(componentPortId(wire.componentId));
    const pinPort = ports.get(wire.pinPortId);
    if (!compPort || !pinPort) return;
    const a = portCenter(compPort.el);
    const b = portCenter(pinPort.el);
    wire.line.setAttribute("x1", String(a.x));
    wire.line.setAttribute("y1", String(a.y));
    wire.line.setAttribute("x2", String(b.x));
    wire.line.setAttribute("y2", String(b.y));
  }

  function rerouteAll(): void {
    for (const wire of wires.values()) routeWire(wire);
  }

  // --- node dragging ---------------------------------------------------------

  function addNode(content: HTMLElement, opts: NodeOptions): HTMLElement {
    const node = document.createElement("div");
    node.className = "node";
    node.style.left = `${opts.x}px`;
    node.style.top = `${opts.y}px`;

    const handle = document.createElement("div");
    handle.className = "node-handle";
    handle.title = opts.title ?? "Drag to move";
    handle.setAttribute("aria-label", "Drag to move");

    node.append(handle, content);
    root.append(node);

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const left = originLeft + (event.clientX - startX);
      const top = originTop + (event.clientY - startY);
      node.style.left = `${Math.max(0, left)}px`;
      node.style.top = `${Math.max(0, top)}px`;
      rerouteAll();
    };
    const onUp = (event: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      handle.releasePointerCapture?.(event.pointerId);
    };
    const onDown = (event: PointerEvent): void => {
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = node.offsetLeft;
      originTop = node.offsetTop;
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    handle.addEventListener("pointerdown", onDown);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    cleanups.push(() => {
      handle.removeEventListener("pointerdown", onDown);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    });

    return node;
  }

  // --- wiring ----------------------------------------------------------------

  function componentPortId(componentId: string): string {
    return `component:${componentId}`;
  }

  function makeWire(componentId: string, pinPortId: string): void {
    removeWire(componentId);
    const line = document.createElementNS(SVG_NS, "line");
    line.classList.add("wire");
    svg.append(line);
    const wire: Wire = { componentId, pinPortId, line };
    wires.set(componentId, wire);
    markConnected(componentId, pinPortId, true);
    routeWire(wire);
  }

  function removeWire(componentId: string): void {
    const wire = wires.get(componentId);
    if (!wire) return;
    markConnected(componentId, wire.pinPortId, false);
    wire.line.remove();
    wires.delete(componentId);
  }

  function markConnected(componentId: string, pinPortId: string, on: boolean): void {
    ports.get(componentPortId(componentId))?.el.classList.toggle("connected", on);
    // A pin port may still be wired to other components, so only clear its
    // "connected" class when no remaining wire uses it.
    const pinStillUsed = [...wires.values()].some(
      (w) => w.pinPortId === pinPortId && (on || w.componentId !== componentId),
    );
    ports.get(pinPortId)?.el.classList.toggle("connected", on || pinStillUsed);
  }

  function addPort(el: HTMLElement, meta: PortMeta): void {
    ports.set(meta.id, { meta, el });
    el.classList.add("port", `port-${meta.kind}`);
    el.dataset.portId = meta.id;
    const onDown = (event: PointerEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      beginWireDrag(meta, event);
    };
    el.addEventListener("pointerdown", onDown);
    cleanups.push(() => el.removeEventListener("pointerdown", onDown));
  }

  function beginWireDrag(from: PortMeta, downEvent: PointerEvent): void {
    const temp = document.createElementNS(SVG_NS, "line");
    temp.classList.add("wire", "wire-temp");
    svg.append(temp);
    const start = portCenter(ports.get(from.id)!.el);
    temp.setAttribute("x1", String(start.x));
    temp.setAttribute("y1", String(start.y));

    const move = (event: PointerEvent): void => {
      const box = root.getBoundingClientRect();
      temp.setAttribute("x2", String(event.clientX - box.left));
      temp.setAttribute("y2", String(event.clientY - box.top));
    };
    move(downEvent);

    const finish = (event: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      temp.remove();
      const target = portFromPoint(event.clientX, event.clientY);
      if (target) tryConnect(from, target.meta);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  }

  function portFromPoint(clientX: number, clientY: number): RegisteredPort | undefined {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const portId = el?.closest<HTMLElement>(".port")?.dataset.portId;
    return portId ? ports.get(portId) : undefined;
  }

  function tryConnect(a: PortMeta, b: PortMeta): void {
    // Need exactly one component port and one pin port.
    const comp = a.kind === "component" ? a : b.kind === "component" ? b : null;
    const pin = a.kind === "pin" ? a : b.kind === "pin" ? b : null;
    if (!comp || !pin || comp.component === undefined || pin.pin === undefined) return;
    if (options.onBind?.(comp.component, pin.pin) === false) return;
    makeWire(comp.component, pin.id);
  }

  function connect(componentId: string, pin: number): void {
    const pinPort = [...ports.values()].find((p) => p.meta.kind === "pin" && p.meta.pin === pin);
    if (!pinPort) return;
    if (options.onBind?.(componentId, pin) === false) return;
    makeWire(componentId, pinPort.meta.id);
  }

  function connections(): Connection[] {
    const out: Connection[] = [];
    for (const wire of wires.values()) {
      const pin = ports.get(wire.pinPortId)?.meta.pin;
      if (pin !== undefined) out.push({ componentId: wire.componentId, pin });
    }
    return out;
  }

  // Reroute on viewport resize so wires keep tracking their ports.
  const onResize = (): void => rerouteAll();
  window.addEventListener("resize", onResize);
  cleanups.push(() => window.removeEventListener("resize", onResize));

  return {
    element: root,
    addNode,
    addPort,
    connect,
    connections,
    destroy() {
      for (const cleanup of cleanups) cleanup();
      root.remove();
    },
  };
}
