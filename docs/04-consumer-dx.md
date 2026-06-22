# Consumer DX — AVR-First API

This is the public API the simulator should grow toward. The main path is one
factory function: pass a HEX string or options object, attach listeners, and run
simulated time. Consumers should not need to manually parse HEX or wire CPU,
GPIO, timers, and USART together.

---

## Quick start

```ts
import { AVR } from "avrts";

const avr = AVR({ hex: blinkHex });

avr.pin(13).onChange((high) => {
  console.log(high ? "LED ON" : "LED OFF");
});

avr.serial.onText((text) => {
  process.stdout.write(text);
});

avr.runFor(1000); // simulated milliseconds
```

`AVR(...)` is a factory/builder function. Internally it may create an
`AVRRuntime` class, but consumers should not need `new`.

For browser simulators, the same facade should also expose UI-friendly controls:

```ts
avr.start();
avr.pause();
avr.resume();
avr.reset();
```

---

## Construction styles

Use the shortest form when defaults are fine:

```ts
const avr = AVR(blinkHex);
```

Use options when the call site should be explicit:

```ts
const avr = AVR({
  hex: blinkHex,
  chip: "atmega328p",
  clockHz: 16_000_000,
});
```

Use fluent setup for composition:

```ts
const avr = AVR()
  .useChip("atmega328p")
  .useClock(16_000_000)
  .useHex(blinkHex);
```

Loading happens inside `AVR(...)` / `.useHex(...)`. `loadHex()` remains available
for advanced tests and tools, but it is not the normal consumer path.

Browser file uploads should also be one call:

```ts
await avr.loadFile(fileInput.files![0]);
```

Type this helper around `{ text(): Promise<string> }` rather than the DOM `File`
type directly, so it also works with `Blob`, Bun files, and tests without forcing
DOM types into the core package.

---

## GPIO

Prefer pin numbers for app/demo code:

```ts
avr.pin(13).onChange((high) => {
  ledElement.toggleAttribute("data-on", high);
});
```

Pins also need input simulation for buttons and sensors:

```ts
buttonElement.onpointerdown = () => avr.pin(2).setInput(true);
buttonElement.onpointerup = () => avr.pin(2).setInput(false);

avr.pin(2).pulse(50); // HIGH for 50 simulated milliseconds
```

Bulk pin events are useful for render loops and inspectors:

```ts
avr.pins.onChange((event) => {
  console.log(event.pin, event.high, event.timeMs);
});
```

Use raw AVR port access when debugging chip behavior:

```ts
avr.gpio.port("B").onChange((value) => {
  console.log(value.toString(2).padStart(8, "0"));
});
```

Pin mappings are part of the selected chip/preset. v1 defaults to
`chip: "atmega328p"`.

---

## Serial

```ts
avr.serial.onByte((byte) => {
  process.stdout.write(String.fromCharCode(byte));
});

avr.serial.onText((text) => {
  console.log(text);
});
```

`onText` is a convenience layer over transmitted bytes. The facade should also
support serial-monitor UI state:

```ts
avr.serial.clear();
avr.serial.getText();
avr.serial.write("host input"); // later: simulate RX from host to AVR
```

---

## Runtime control

Use human time for demos:

```ts
avr.runFor(1000); // 1000 simulated milliseconds
```

Use cycles for deterministic tests:

```ts
avr.runCycles(16_000_000);
```

Use single-instruction stepping for debugging:

```ts
avr.step();
```

For browser render loops, expose a `frame()` helper so UIs do not need to do time
math everywhere:

```ts
function frame() {
  avr.frame(16.67);
  render();
  requestAnimationFrame(frame);
}

frame();
```

For simulator controls, expose a small runtime API:

```ts
avr.start();       // internal requestAnimationFrame/setInterval loop
avr.pause();
avr.resume();
avr.stop();

avr.setSpeed(1);     // realtime
avr.setSpeed(10);    // 10x simulated time
avr.setSpeed("max"); // as fast as practical
```

`start()` should use `requestAnimationFrame` when available and fall back to a
timer in non-browser runtimes. `runFor`, `runCycles`, and `step` remain immediate,
deterministic calls.

High-frequency visual widgets can opt into frame-level event coalescing:

```ts
const avr = AVR({
  hex,
  eventCoalescing: { pins: true },
});

avr.pin(13).onChange(renderLed);
avr.frame(16.67); // pin listeners receive the latest pin 13 state once
```

Coalescing applies to `frame(...)` only. `runCycles(...)`, `runFor(...)`, and
`step()` keep exact event delivery for tests and debugging.

---

## Program loading

Program loading should stay facade-first:

```ts
avr.loadHex(hexText);
avr.load({ hex: hexText, chip: "atmega328p" });
await avr.loadFile(fileLike);

avr.clearProgram();
avr.reload();
```

`reload()` reruns the last loaded program source. That is useful for reset buttons
and live editor flows.

---

## Component adapters

The core library should not become a full UI component framework, but it should
make component adapters easy:

```ts
avr.connect(LED({ pin: 13, onChange: updateLed }));
avr.connect(Button({ pin: 2, element: buttonElement }));
avr.connect(SerialMonitor({ element: terminalElement }));
```

Component contract:

```ts
interface AVRComponent {
  attach(avr: AVR): void;
  detach?(): void;
}
```

This lets a future browser simulator build plug-and-play parts without coupling
the CPU core to DOM code.

---

## Low-level escape hatches

The facade should stay easy, but advanced users still need inspection points:

```ts
avr.cpu.onTrace((state) => {
  console.log(state.pc, state.mnemonic, state.cycles);
});

console.log(avr.cpu.data[0x25]); // PORTB data-space address
```

Debugging helpers for UI tools:

```ts
avr.on("error", console.error);
avr.on("pause", () => renderPaused());
avr.breakpoint({ pc: 0x1234 });
avr.pauseOnUnknownOpcode(true);
```

Snapshot/restore is useful for reset, tests, and future rewind/debugging:

```ts
const snapshot = avr.snapshot();
avr.restore(snapshot);
```

For UI refresh, listen to the runtime restore event and read current state from
the public getters. Restored serial text is available through `serial.getText()`;
it is not replayed through `serial.onText(...)`.

```ts
avr.on("restore", () => {
  renderStatus(avr.status());
  renderSerial(avr.serial.getText());
});
```

Status makes toolbar rendering simple:

```ts
const status = avr.status();
// { running, paused, timeMs, cycles, speed, chip, programLoaded }
```

Advanced exports can include `CPU`, `loadHex`, and peripheral classes, but the
docs should lead with `AVR(...)`.

---

## Public shape target

```ts
export interface AVR {
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;

  runFor(ms: number): void;
  runCycles(cycles: number): void;
  frame(deltaMs: number): void;
  step(): void;
  reset(options?: { clearProgram?: boolean }): void;
  setSpeed(speed: number | "max"): void;
  setEventCoalescing(options: { pins?: boolean }): this;

  use(options: AVROptions): this;
  useHex(hex: string): this;
  useChip(chip: AVRChip): this;
  useClock(clockHz: number): this;
  load(options: AVROptions): this;
  loadHex(hex: string): this;
  loadFile(fileLike: { text(): Promise<string> }): Promise<this>;
  clearProgram(): this;
  reload(): this;

  pin(pinNumber: number): PinHandle;
  connect(component: AVRComponent): this;
  disconnect(component: AVRComponent): this;

  on(event: AVREventName, handler: AVREventHandler): () => void;
  breakpoint(options: { pc: number }): this;
  pauseOnUnknownOpcode(enabled: boolean): this;
  snapshot(): AVRSnapshot;
  restore(snapshot: AVRSnapshot): this;
  status(): AVRStatus;

  readonly pins: PinsHandle;
  readonly gpio: GpioHandle;
  readonly serial: SerialHandle;
  readonly cpu: CPU;
}

export function AVR(input?: string | AVROptions): AVR;
```

Handle targets:

```ts
export interface PinHandle {
  read(): boolean;
  setInput(high: boolean): void;
  pulse(ms: number): void;
  onChange(handler: (high: boolean, event: PinChangeEvent) => void): () => void;
}

export interface PinsHandle {
  onChange(handler: (event: PinChangeEvent) => void): () => void;
}

export interface SerialHandle {
  onByte(handler: (byte: number) => void): () => void;
  onText(handler: (text: string) => void): () => void;
  write(text: string | Uint8Array): void;
  clear(): void;
  getText(): string;
}

export interface AVRStatus {
  running: boolean;
  paused: boolean;
  timeMs: number;
  cycles: number;
  speed: number | "max";
  chip: AVRChip;
  programLoaded: boolean;
}

export interface AVRComponent {
  attach(avr: AVR): void;
  detach?(): void;
}
```

Supported chip names start small:

```ts
export type AVRChip = "atmega328p";
```

Future chips can extend that union, for example `"atmega2560"` and
`"atmega32u4"`, without renaming the public API.
