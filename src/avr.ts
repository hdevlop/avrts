import {
  ADC_VECTOR,
  ADCSRA,
  ADIF,
  CPU,
  DEFAULT_CLOCK_HZ,
  Decoder,
  EIFR,
  INTF0,
  INTF1,
  INT0_VECTOR,
  INT1_VECTOR,
  OCF0A,
  OCF0B,
  OCF1A,
  OCF1B,
  OCF2A,
  OCF2B,
  PCIF0,
  PCIF1,
  PCIF2,
  PCIFR,
  PCINT0_VECTOR,
  PCINT1_VECTOR,
  PCINT2_VECTOR,
  SPIF,
  SPI_STC_VECTOR,
  SPSR,
  TIFR0,
  TIFR1,
  TIFR2,
  TIMER0_COMPA_VECTOR,
  TIMER0_COMPB_VECTOR,
  TIMER0_OVF_VECTOR,
  TIMER1_COMPA_VECTOR,
  TIMER1_COMPB_VECTOR,
  TIMER1_OVF_VECTOR,
  TIMER2_COMPA_VECTOR,
  TIMER2_COMPB_VECTOR,
  TIMER2_OVF_VECTOR,
  TOV0,
  TOV1,
  TOV2,
  TXC0,
  UCSR0A,
  USART_TX_VECTOR,
} from "./cpu";
import { loadHex } from "./loader";
import {
  Adc,
  attachPeripheral,
  Eeprom,
  ExternalInterrupts,
  Gpio,
  PIN_MAP,
  pinInfo,
  PinChangeInterrupt,
  Spi,
  Timer0,
  Timer1,
  Timer2,
  Twi,
  Usart0,
  Watchdog,
} from "./peripherals";
import type {
  AnalogChannelHandle,
  PinChangeEvent,
  PortName,
  PwmChannel,
  PwmSignal,
  PwmSource,
  SpiTransferResponder,
  TwiSlave,
} from "./peripherals";
import type { AVRSnapshot } from "./snapshot";

/**
 * Cap on buffered serial chunks before they are folded into the joined cache.
 * Keeps `serialChunks` bounded for long headless runs that never call
 * `serial.getText()`, while still avoiding a per-byte string concatenation during
 * bursts. (The browser worker bounds its own buffer per frame; this guards the
 * core `AVRRuntime` path.)
 */
const SERIAL_CHUNK_COMPACT_THRESHOLD = 1024;

/**
 * Public consumer facade. This is the API surface described in
 * docs/04-consumer-dx.md. Phase 0/1 implements construction, CPU access, reset,
 * and status; running, GPIO, and serial handles are wired up in later phases.
 *
 * Consumers use the `AVR(...)` factory — they should never need `new`.
 */

/** Chip presets. Starts with one; future chips extend this union. */
export type AVRChip = "atmega328p";
     
/**
 * Timing granularity used by the simulator. `"fast"` (default) notifies
 * peripherals once per instruction; `"cycle-exact"` notifies them once per
 * CPU cycle so timer compare / overflow events land on the exact cycle they
 * would on real hardware.
 */
export type AVRTiming = "fast" | "cycle-exact";

export interface AVROptions {
  hex?: string;
  chip?: AVRChip;
  clockHz?: number;
  timing?: AVRTiming;
  eventCoalescing?: AVREventCoalescingOptions;
}

export interface AVREventCoalescingOptions {
  /**
   * When true, `avr.frame(...)` delivers at most the latest pin event per pin at
   * the end of the frame. `runCycles(...)`, `runFor(...)`, and `step()` stay
   * immediate for deterministic tests/debugging.
   */
  pins?: boolean;
}

export interface AVRStatus {
  running: boolean;
  paused: boolean;
  timeMs: number;
  cycles: number;
  speed: AVRSpeed;
  chip: AVRChip;
  clockHz: number;
  programLoaded: boolean;
}

export type AVRSpeed = number | "max";

export interface AVRComponent {
  attach(avr: AVR): void;
  detach?(): void;
}

export type AVREventName =
  | "start"
  | "pause"
  | "resume"
  | "stop"
  | "reset"
  | "restore"
  | "load"
  | "clear"
  | "error"
  | "breakpoint";

export interface AVREvent {
  type: AVREventName;
  status: AVRStatus;
  error?: unknown;
  /** PC at which a breakpoint was hit (only set on `"breakpoint"` events). */
  pc?: number;
}

export type AVREventHandler = (event: AVREvent) => void;

export interface PinHandle {
  read(): boolean;
  setInput(high: boolean): void;
  pulse(ms: number): void;
  onChange(handler: (high: boolean, event: PinChangeEvent) => void): () => void;
}

export interface PinsHandle {
  onChange(handler: (event: PinChangeEvent) => void): () => void;
}

export interface PortHandle {
  read(): number;
  onChange(handler: (value: number, oldValue: number) => void): () => void;
}

export interface GpioHandle {
  port(name: PortName): PortHandle;
}

export interface SerialHandle {
  onByte(handler: (byte: number) => void): () => void;
  onText(handler: (text: string) => void): () => void;
  write(text: string | Uint8Array): void;
  clear(): void;
  getText(): string;
}

export type AnalogHandle = AnalogChannelHandle;

export interface PwmHandle {
  read(): PwmSignal;
  onChange(handler: (signal: PwmSignal) => void): () => void;
}

export interface EepromHandle {
  read(address: number): number;
  write(address: number, value: number): void;
  load(data: Uint8Array | number[]): void;
  dump(): Uint8Array;
}

export interface SpiHandle {
  onByte(handler: (byte: number) => void): () => void;
  respondWith(responder: SpiTransferResponder): void;
}

export interface TwiHandle {
  connect(address: number, slave: TwiSlave): void;
}

/** Watchpoint payload — fires on every firmware write to the watched address. */
export interface DataWatchEvent {
  address: number;
  oldValue: number;
  value: number;
}

export type DataWatchHandler = (event: DataWatchEvent) => void;

export interface BreakpointOptions {
  pc: number;
}

/** The public facade type. Grows toward docs/04-consumer-dx.md. */
export interface AVR {
  /** Low-level escape hatch for inspection/debugging. */
  readonly cpu: CPU;
  readonly gpio: GpioHandle;
  readonly pins: PinsHandle;
  readonly serial: SerialHandle;
  readonly eeprom: EepromHandle;
  readonly spi: SpiHandle;
  readonly twi: TwiHandle;

  start(): this;
  pause(): this;
  resume(): this;
  stop(): this;
  frame(deltaMs: number): this;
  setSpeed(speed: AVRSpeed): this;

  use(options: AVROptions): this;
  useChip(chip: AVRChip): this;
  useClock(clockHz: number): this;
  useHex(hex: string): this;
  useTiming(timing: AVRTiming): this;
  setEventCoalescing(options: AVREventCoalescingOptions): this;
  load(options: AVROptions): this;
  loadHex(hex: string): this;
  loadFile(fileLike: { text(): Promise<string> }): Promise<this>;
  clearProgram(): this;
  reload(): this;

  /** Execute one instruction. */
  step(): this;
  /** Run a fixed number of cycles (deterministic — ideal for tests). */
  runCycles(cycles: number): this;
  /** Run simulated milliseconds using the configured clock. */
  runFor(ms: number): this;
  pin(pinNumber: number): PinHandle;
  analog(channel: number): AnalogHandle;
  pwm(pinNumber: number): PwmHandle;
  connect(component: AVRComponent): this;
  disconnect(component: AVRComponent): this;
  on(event: AVREventName, handler: AVREventHandler): () => void;

  /** Set a breakpoint at the given program-counter word address. */
  breakpoint(options: BreakpointOptions): this;
  /** Remove one breakpoint. */
  clearBreakpoint(pc: number): this;
  /** Remove every breakpoint. */
  clearBreakpoints(): this;
  /** Pause on unknown opcodes instead of throwing. */
  pauseOnUnknownOpcode(enabled: boolean): this;
  /** Watch a data-space address; returns an unsubscribe function. */
  watchData(address: number, handler: DataWatchHandler): () => void;

  reset(options?: { clearProgram?: boolean }): this;
  status(): AVRStatus;

  /** Capture plain-data snapshot of CPU + every peripheral. */
  snapshot(): AVRSnapshot;
  /** Restore from a snapshot. Re-emits pin/serial events for visible diffs. */
  restore(snapshot: AVRSnapshot): this;
}

class AVRRuntime implements AVR {
  private static readonly maxSpeedMultiplier = 100;

  readonly cpu: CPU;
  readonly gpio: GpioHandle;
  readonly pins: PinsHandle;
  readonly serial: SerialHandle;
  readonly eeprom: EepromHandle;
  readonly spi: SpiHandle;
  readonly twi: TwiHandle;

  private chip: AVRChip = "atmega328p";
  private clockHz = DEFAULT_CLOCK_HZ;
  private speed: AVRSpeed = 1;
  private running = false;
  private paused = false;
  private programSource: string | null = null;
  private loopHandle: ReturnType<typeof setInterval> | number | null = null;
  private loopUsesRaf = false;
  private lastHostFrameMs = 0;
  private readonly gpioPeripheral: Gpio;
  private readonly timer0: Timer0;
  private readonly timer1: Timer1;
  private readonly timer2: Timer2;
  private readonly usart0: Usart0;
  private readonly adc: Adc;
  private readonly eepromDevice: Eeprom;
  private readonly spiDevice: Spi;
  private readonly twiDevice: Twi;
  private readonly watchdog: Watchdog;
  private readonly pcint: PinChangeInterrupt;
  private readonly exti: ExternalInterrupts;
  private readonly pinListeners = new Set<(event: PinChangeEvent) => void>();
  private readonly pendingPinEvents = new Map<number, PinChangeEvent>();
  private readonly textListeners = new Set<(text: string) => void>();
  private readonly components = new Set<AVRComponent>();
  private readonly eventListeners = new Map<AVREventName, Set<AVREventHandler>>();
  private readonly watchpoints = new Map<number, Set<DataWatchHandler>>();
  private readonly watchHooksInstalled = new Set<number>();
  private serialChunks: string[] = [];
  private serialTextCache = "";
  private serialTextDirty = false;
  private coalescePinEvents = false;
  private frameDepth = 0;

  constructor() {
    this.cpu = new CPU();
    this.cpu.setExecutor(new Decoder());
    this.gpioPeripheral = new Gpio(this.cpu);
    this.timer0 = new Timer0(this.cpu, this.gpioPeripheral);
    this.timer1 = new Timer1(this.cpu, this.gpioPeripheral);
    this.timer2 = new Timer2(this.cpu, this.gpioPeripheral);
    this.usart0 = new Usart0(this.cpu);
    this.adc = new Adc(this.cpu);
    this.eepromDevice = new Eeprom(this.cpu);
    this.spiDevice = new Spi(this.cpu);
    this.twiDevice = new Twi(this.cpu);
    this.watchdog = new Watchdog(this.cpu, this.clockHz);
    this.pcint = new PinChangeInterrupt(this.cpu, this.gpioPeripheral);
    this.exti = new ExternalInterrupts(this.cpu, this.gpioPeripheral);
    attachPeripheral(this.cpu, this.gpioPeripheral);
    attachPeripheral(this.cpu, this.timer0);
    attachPeripheral(this.cpu, this.timer1);
    attachPeripheral(this.cpu, this.timer2);
    attachPeripheral(this.cpu, this.usart0);
    attachPeripheral(this.cpu, this.adc);
    attachPeripheral(this.cpu, this.eepromDevice);
    attachPeripheral(this.cpu, this.spiDevice);
    attachPeripheral(this.cpu, this.twiDevice);
    attachPeripheral(this.cpu, this.watchdog);
    attachPeripheral(this.cpu, this.pcint);
    this.pcint.attach();
    attachPeripheral(this.cpu, this.exti);
    this.exti.attach({ cycleListener: false });
    this.usart0.onByteTransmit((byte) => this.emitSerialByte(byte));
    this.gpio = {
      port: (name) => ({
        read: () => this.gpioPeripheral.readPort(name),
        onChange: (handler) => this.gpioPeripheral.onPortValueChange(name, handler),
      }),
    };
    this.pins = {
      onChange: (handler) => {
        this.pinListeners.add(handler);
        return () => {
          this.pinListeners.delete(handler);
        };
      },
    };
    this.serial = {
      onByte: (handler) => this.usart0.onByteTransmit(handler),
      onText: (handler) => {
        this.textListeners.add(handler);
        return () => {
          this.textListeners.delete(handler);
        };
      },
      write: (text) => {
        this.usart0.receive(text);
      },
      clear: () => {
        this.setSerialText("");
      },
      getText: () => this.getSerialText(),
    };
    this.eeprom = {
      read: (address) => this.eepromDevice.read(address),
      write: (address, value) => {
        this.eepromDevice.write(address, value);
      },
      load: (data) => {
        this.eepromDevice.load(data);
      },
      dump: () => this.eepromDevice.dump(),
    };
    this.spi = {
      onByte: (handler) => this.spiDevice.onByteTransmit(handler),
      respondWith: (responder) => {
        this.spiDevice.respondWith(responder);
      },
    };
    this.twi = {
      connect: (address, slave) => {
        this.twiDevice.connect(address, slave);
      },
    };
    for (const [pinText, info] of Object.entries(PIN_MAP)) {
      const pin = Number(pinText);
      this.gpioPeripheral.onPinChange(info.port, info.bit, (high) => {
        this.emitPinEvent(this.pinEvent(pin, high));
      });
    }
  }

  start(): this {
    if (this.running) return this;
    this.running = true;
    this.paused = false;
    this.lastHostFrameMs = this.nowMs();
    this.scheduleLoop();
    this.emit("start");
    return this;
  }

  pause(): this {
    if (!this.running || this.paused) return this;
    this.paused = true;
    this.emit("pause");
    return this;
  }

  resume(): this {
    if (!this.running) return this.start();
    if (!this.paused) return this;
    this.paused = false;
    this.lastHostFrameMs = this.nowMs();
    this.emit("resume");
    return this;
  }

  stop(): this {
    if (!this.running) return this;
    this.cancelLoop();
    this.running = false;
    this.paused = false;
    this.emit("stop");
    return this;
  }

  frame(deltaMs: number): this {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new Error(`frame(deltaMs) expects a non-negative finite number, got ${deltaMs}.`);
    }
    const cycles = Math.ceil((deltaMs / 1000) * this.clockHz * this.speedMultiplier());
    if (cycles > 0 && this.coalescePinEvents) {
      this.frameDepth += 1;
      try {
        this.runCycles(cycles);
      } finally {
        this.frameDepth -= 1;
        if (this.frameDepth === 0) this.flushPinEvents();
      }
    } else if (cycles > 0) {
      this.runCycles(cycles);
    }
    return this;
  }

  breakpoint(options: BreakpointOptions): this {
    this.cpu.breakpoints.add(options.pc & 0xffff);
    return this;
  }

  clearBreakpoint(pc: number): this {
    this.cpu.breakpoints.delete(pc & 0xffff);
    return this;
  }

  clearBreakpoints(): this {
    this.cpu.breakpoints.clear();
    return this;
  }

  pauseOnUnknownOpcode(enabled: boolean): this {
    this.cpu.pauseOnUnknownOpcode = enabled;
    return this;
  }

  watchData(address: number, handler: DataWatchHandler): () => void {
    const addr = address & 0xffff;
    let set = this.watchpoints.get(addr);
    if (!set) {
      set = new Set();
      this.watchpoints.set(addr, set);
    }
    set.add(handler);

    if (!this.watchHooksInstalled.has(addr)) {
      this.watchHooksInstalled.add(addr);
      this.cpu.installWriteHook(addr, (_cpu, writeAddr, value, oldValue) => {
        const handlers = this.watchpoints.get(writeAddr);
        if (!handlers || handlers.size === 0) return;
        const event: DataWatchEvent = {
          address: writeAddr,
          oldValue,
          value,
        };
        for (const h of [...handlers]) h(event);
      });
    }

    return () => {
      const s = this.watchpoints.get(addr);
      if (!s) return;
      s.delete(handler);
    };
  }

  /**
   * Surface breakpoint / error state from the CPU as AVREvents. Called after
   * `runCycles`, `step`, or each frame inside the start() loop.
   */
  private reportDebugState(): void {
    if (this.cpu.wasBreakpointHit) {
      const pc = this.cpu.pc;
      this.cpu.clearBreakpointHit();
      if (this.running) {
        this.cancelLoop();
        this.paused = true;
        this.emit("pause");
      }
      this.emit("breakpoint", undefined, pc);
      return;
    }
    const err = this.cpu.error;
    if (err !== null) {
      this.cpu.clearError();
      if (this.running) {
        this.cancelLoop();
        this.paused = true;
        this.emit("pause");
      }
      this.emit("error", err);
    }
  }

  setSpeed(speed: AVRSpeed): this {
    if (speed !== "max" && (!Number.isFinite(speed) || speed <= 0)) {
      throw new Error(`setSpeed(speed) expects a positive number or "max", got ${speed}.`);
    }
    this.speed = speed;
    return this;
  }

  use(options: AVROptions): this {
    if (options.chip) this.useChip(options.chip);
    if (options.clockHz) this.useClock(options.clockHz);
    if (options.timing) this.useTiming(options.timing);
    if (options.eventCoalescing) this.setEventCoalescing(options.eventCoalescing);
    if (options.hex) this.useHex(options.hex);
    return this;
  }

  useChip(chip: AVRChip): this {
    this.chip = chip;
    return this;
  }

  useClock(clockHz: number): this {
    this.clockHz = clockHz;
    this.watchdog.setClock(clockHz);
    return this;
  }

  useTiming(timing: AVRTiming): this {
    if (timing !== "fast" && timing !== "cycle-exact") {
      throw new Error(`useTiming(timing) expects "fast" or "cycle-exact", got ${timing}.`);
    }
    this.cpu.timing = timing;
    return this;
  }

  setEventCoalescing(options: AVREventCoalescingOptions): this {
    this.coalescePinEvents = options.pins === true;
    if (!this.coalescePinEvents) this.flushPinEvents();
    return this;
  }

  useHex(hex: string): this {
    this.programSource = hex;
    this.cpu.flash.fill(0);
    loadHex(hex, this.cpu.flash);
    this.reset();
    this.emit("load");
    return this;
  }

  load(options: AVROptions): this {
    return this.use(options);
  }

  loadHex(hex: string): this {
    return this.useHex(hex);
  }

  async loadFile(fileLike: { text(): Promise<string> }): Promise<this> {
    return this.useHex(await fileLike.text());
  }

  clearProgram(): this {
    this.programSource = null;
    this.cpu.flash.fill(0);
    this.reset();
    this.emit("clear");
    return this;
  }

  reload(): this {
    if (this.programSource === null) return this;
    const hex = this.programSource;
    this.cpu.flash.fill(0);
    loadHex(hex, this.cpu.flash);
    this.reset();
    this.emit("load");
    return this;
  }

  step(): this {
    this.cpu.clearBreakpointHit();
    this.cpu.clearError();
    this.cpu.tick();
    this.reportDebugState();
    return this;
  }

  runCycles(cycles: number): this {
    this.cpu.clearBreakpointHit();
    this.cpu.clearError();
    this.cpu.run(cycles);
    this.reportDebugState();
    return this;
  }

  runFor(ms: number): this {
    return this.runCycles(Math.ceil((ms / 1000) * this.clockHz));
  }

  pin(pinNumber: number): PinHandle {
    const info = pinInfo(pinNumber);
    return {
      read: () => this.gpioPeripheral.readPin(info.port, info.bit),
      setInput: (high) => {
        this.gpioPeripheral.setInput(info.port, info.bit, high);
      },
      pulse: (ms) => {
        this.gpioPeripheral.setInput(info.port, info.bit, true);
        this.runFor(ms);
        this.gpioPeripheral.setInput(info.port, info.bit, false);
      },
      onChange: (handler) => {
        const listener = (event: PinChangeEvent) => {
          if (event.pin === pinNumber) handler(event.high, event);
        };
        this.pinListeners.add(listener);
        return () => {
          this.pinListeners.delete(listener);
        };
      },
    };
  }

  analog(channel: number): AnalogHandle {
    return {
      read: () => this.adc.readChannelValue(channel),
      setValue: (value) => {
        this.adc.setChannelValue(channel, value);
      },
      setVoltage: (volts, referenceVolts) => {
        this.adc.setChannelVoltage(channel, volts, referenceVolts);
      },
    };
  }

  pwm(pinNumber: number): PwmHandle {
    const { source, channel } = this.resolvePwm(pinNumber);
    return {
      read: () => source.readPwm(channel),
      onChange: (handler) => source.onPwmChange(channel, handler),
    };
  }

  /** Map an Arduino PWM pin to the timer + compare channel that drives it. */
  private resolvePwm(pin: number): { source: PwmSource; channel: PwmChannel } {
    switch (pin) {
      case 6:
        return { source: this.timer0, channel: "A" };
      case 5:
        return { source: this.timer0, channel: "B" };
      case 9:
        return { source: this.timer1, channel: "A" };
      case 10:
        return { source: this.timer1, channel: "B" };
      case 11:
        return { source: this.timer2, channel: "A" };
      case 3:
        return { source: this.timer2, channel: "B" };
      default:
        pinInfo(pin); // validate it's a real pin (throws for unknown pins)
        throw new Error(`PWM is not available on pin ${pin} (PWM pins: 3, 5, 6, 9, 10, 11).`);
    }
  }

  connect(component: AVRComponent): this {
    if (this.components.has(component)) return this;
    this.components.add(component);
    component.attach(this);
    return this;
  }

  disconnect(component: AVRComponent): this {
    if (!this.components.delete(component)) return this;
    component.detach?.();
    return this;
  }

  on(event: AVREventName, handler: AVREventHandler): () => void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }

  reset(options: { clearProgram?: boolean } = {}): this {
    if (options.clearProgram) {
      this.programSource = null;
      this.cpu.flash.fill(0);
    }
    this.cpu.reset();
    this.timer0.reset();
    this.timer1.reset();
    this.timer2.reset();
    this.usart0.reset();
    this.adc.reset();
    this.eepromDevice.reset();
    this.spiDevice.reset();
    this.twiDevice.reset();
    this.watchdog.reset();
    this.pcint.reset();
    this.exti.reset();
    this.setSerialText("");
    this.emit("reset");
    return this;
  }

  status(): AVRStatus {
    return {
      running: this.running,
      paused: this.paused,
      timeMs: (this.cpu.cycles / this.clockHz) * 1000,
      cycles: this.cpu.cycles,
      speed: this.speed,
      chip: this.chip,
      clockHz: this.clockHz,
      programLoaded: this.programSource !== null,
    };
  }

  snapshot(): AVRSnapshot {
    return {
      cpu: this.cpu.snapshot(),
      runtime: {
        clockHz: this.clockHz,
        chip: this.chip,
        speed: this.speed,
        programSource: this.programSource,
        running: this.running,
        paused: this.paused,
        serialText: this.getSerialText(),
        timing: this.cpu.timing,
      },
      gpio: this.gpioPeripheral.snapshot(),
      timer0: this.timer0.snapshot(),
      timer1: this.timer1.snapshot(),
      timer2: this.timer2.snapshot(),
      usart0: this.usart0.snapshot(),
      adc: this.adc.snapshot(),
      eeprom: this.eepromDevice.snapshot(),
      spi: this.spiDevice.snapshot(),
      twi: this.twiDevice.snapshot(),
      watchdog: this.watchdog.snapshot(),
      pcint: this.pcint.snapshot(),
      exti: this.exti.snapshot(),
    };
  }

  restore(snap: AVRSnapshot): this {
    const wasRunning = this.running;

    this.cpu.restore(snap.cpu, (vector) => this.acknowledgeForVector(vector));
    this.chip = snap.runtime.chip;
    this.clockHz = snap.runtime.clockHz;
    this.speed = snap.runtime.speed;
    this.programSource = snap.runtime.programSource;
    this.cpu.timing = snap.runtime.timing;
    this.watchdog.setClock(this.clockHz);
    this.gpioPeripheral.restore(snap.gpio);
    this.timer0.restore(snap.timer0);
    this.timer1.restore(snap.timer1);
    this.timer2.restore(snap.timer2);
    this.usart0.restore(snap.usart0);
    this.adc.restore(snap.adc);
    this.eepromDevice.restore(snap.eeprom);
    this.spiDevice.restore(snap.spi);
    this.twiDevice.restore(snap.twi);
    this.watchdog.restore(snap.watchdog);
    this.pcint.restore(snap.pcint);
    this.exti.restore(snap.exti);
    this.setSerialText(snap.runtime.serialText);

    // Running/paused: cancel any active loop, then restart if the snapshot says so.
    this.running = false;
    this.paused = false;
    this.cancelLoop();
    if (snap.runtime.running) {
      this.running = true;
      this.paused = snap.runtime.paused;
      this.lastHostFrameMs = this.nowMs();
      this.scheduleLoop();
    } else if (wasRunning) {
      // We cancelled a loop that was running before restore; signal stop so the UI
      // updates its controls.
      this.emit("stop");
    }

    this.emit("restore");
    return this;
  }

  private acknowledgeForVector(vector: number): (() => void) | undefined {
    switch (vector) {
      case TIMER0_COMPA_VECTOR:
        return () => {
          this.cpu.data[TIFR0] = this.cpu.readData(TIFR0) & ~(1 << OCF0A);
        };
      case TIMER0_COMPB_VECTOR:
        return () => {
          this.cpu.data[TIFR0] = this.cpu.readData(TIFR0) & ~(1 << OCF0B);
        };
      case TIMER0_OVF_VECTOR:
        return () => {
          this.cpu.data[TIFR0] = this.cpu.readData(TIFR0) & ~(1 << TOV0);
        };
      case TIMER1_COMPA_VECTOR:
        return () => {
          this.cpu.data[TIFR1] = this.cpu.readData(TIFR1) & ~(1 << OCF1A);
        };
      case TIMER1_COMPB_VECTOR:
        return () => {
          this.cpu.data[TIFR1] = this.cpu.readData(TIFR1) & ~(1 << OCF1B);
        };
      case TIMER1_OVF_VECTOR:
        return () => {
          this.cpu.data[TIFR1] = this.cpu.readData(TIFR1) & ~(1 << TOV1);
        };
      case TIMER2_COMPA_VECTOR:
        return () => {
          this.cpu.data[TIFR2] = this.cpu.readData(TIFR2) & ~(1 << OCF2A);
        };
      case TIMER2_COMPB_VECTOR:
        return () => {
          this.cpu.data[TIFR2] = this.cpu.readData(TIFR2) & ~(1 << OCF2B);
        };
      case TIMER2_OVF_VECTOR:
        return () => {
          this.cpu.data[TIFR2] = this.cpu.readData(TIFR2) & ~(1 << TOV2);
        };
      case ADC_VECTOR:
        return () => {
          this.cpu.data[ADCSRA] = this.cpu.readData(ADCSRA) & ~(1 << ADIF);
        };
      case SPI_STC_VECTOR:
        return () => {
          this.cpu.data[SPSR] = this.cpu.readData(SPSR) & ~(1 << SPIF);
        };
      case USART_TX_VECTOR:
        return () => {
          this.cpu.data[UCSR0A] = this.cpu.readData(UCSR0A) & ~(1 << TXC0);
        };
      case PCINT0_VECTOR:
        return () => {
          this.cpu.data[PCIFR] = this.cpu.readData(PCIFR) & ~(1 << PCIF0);
        };
      case PCINT1_VECTOR:
        return () => {
          this.cpu.data[PCIFR] = this.cpu.readData(PCIFR) & ~(1 << PCIF1);
        };
      case PCINT2_VECTOR:
        return () => {
          this.cpu.data[PCIFR] = this.cpu.readData(PCIFR) & ~(1 << PCIF2);
        };
      case INT0_VECTOR:
        return () => {
          this.cpu.data[EIFR] = this.cpu.readData(EIFR) & ~(1 << INTF0);
        };
      case INT1_VECTOR:
        return () => {
          this.cpu.data[EIFR] = this.cpu.readData(EIFR) & ~(1 << INTF1);
        };
      default:
        return undefined;
    }
  }

  private pinEvent(pin: number, high: boolean): PinChangeEvent {
    const info = pinInfo(pin);
    return {
      pin,
      high,
      port: info.port,
      bit: info.bit,
      cycles: this.cpu.cycles,
      timeMs: (this.cpu.cycles / this.clockHz) * 1000,
    };
  }

  private emitPinEvent(event: PinChangeEvent): void {
    if (this.coalescePinEvents && this.frameDepth > 0) {
      this.pendingPinEvents.set(event.pin, event);
      return;
    }
    this.deliverPinEvent(event);
  }

  private flushPinEvents(): void {
    if (this.pendingPinEvents.size === 0) return;
    const events = [...this.pendingPinEvents.values()];
    this.pendingPinEvents.clear();
    for (const event of events) this.deliverPinEvent(event);
  }

  private deliverPinEvent(event: PinChangeEvent): void {
    for (const listener of [...this.pinListeners]) listener(event);
  }

  private emitSerialByte(byte: number): void {
    const text = String.fromCharCode(byte);
    this.serialChunks.push(text);
    this.serialTextDirty = true;
    if (this.serialChunks.length >= SERIAL_CHUNK_COMPACT_THRESHOLD) {
      this.serialTextCache += this.serialChunks.join("");
      this.serialChunks = [];
      this.serialTextDirty = false;
    }
    if (this.textListeners.size === 0) return;
    if (this.textListeners.size === 1) {
      this.textListeners.values().next().value?.(text);
      return;
    }
    for (const listener of [...this.textListeners]) listener(text);
  }

  private getSerialText(): string {
    if (this.serialTextDirty) {
      this.serialTextCache += this.serialChunks.join("");
      this.serialChunks = [];
      this.serialTextDirty = false;
    }
    return this.serialTextCache;
  }

  private setSerialText(text: string): void {
    this.serialTextCache = text;
    this.serialChunks = [];
    this.serialTextDirty = false;
  }

  private scheduleLoop(): void {
    const raf = (globalThis as {
      requestAnimationFrame?: (callback: (timestamp: number) => void) => number;
    }).requestAnimationFrame;

    const tick = (timestamp?: number): void => {
      if (!this.running) return;
      const now = typeof timestamp === "number" ? timestamp : this.nowMs();
      const deltaMs = Math.max(0, now - this.lastHostFrameMs);
      this.lastHostFrameMs = now;
      try {
        if (!this.paused) this.frame(deltaMs);
      } catch (error) {
        this.stop();
        this.emit("error", error);
        return;
      }
      // reportDebugState (called by frame -> runCycles) may have stopped the loop
      // on a breakpoint or captured error. Don't reschedule in that case.
      if (!this.running) return;
      if (this.loopUsesRaf) this.loopHandle = raf!(tick);
    };

    if (raf) {
      this.loopUsesRaf = true;
      this.loopHandle = raf(tick);
      return;
    }

    this.loopUsesRaf = false;
    this.loopHandle = setInterval(() => tick(), 16);
  }

  private cancelLoop(): void {
    if (this.loopHandle === null) return;
    if (this.loopUsesRaf) {
      const cancel = (globalThis as { cancelAnimationFrame?: (handle: number) => void }).cancelAnimationFrame;
      cancel?.(this.loopHandle as number);
    } else {
      clearInterval(this.loopHandle as ReturnType<typeof setInterval>);
    }
    this.loopHandle = null;
  }

  private speedMultiplier(): number {
    return this.speed === "max" ? AVRRuntime.maxSpeedMultiplier : this.speed;
  }

  private nowMs(): number {
    return (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
  }

  private emit(type: AVREventName, error?: unknown, pc?: number): void {
    const listeners = this.eventListeners.get(type);
    if (!listeners || listeners.size === 0) return;
    const event: AVREvent = { type, status: this.status(), error, pc };
    for (const listener of [...listeners]) listener(event);
  }
}

/**
 * Create a simulator. Accepts a HEX string, an options object, or nothing
 * (for fluent setup):
 *
 *   AVR(hexText)
 *   AVR({ hex, chip, clockHz })
 *   AVR().useChip("atmega328p").useClock(16_000_000).useHex(hexText)
 */
export function AVR(input?: string | AVROptions): AVR {
  const runtime = new AVRRuntime();
  if (typeof input === "string") {
    runtime.useHex(input);
  } else if (input) {
    runtime.use(input);
  }
  return runtime;
}
