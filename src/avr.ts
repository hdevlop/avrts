import {
  ADC_VECTOR,
  ACI,
  ACSR,
  ADCSRA,
  ADIF,
  ANALOG_COMP_VECTOR,
  BORF,
  CPU,
  CLKPR,
  DEFAULT_CLOCK_HZ,
  Decoder,
  EIFR,
  EE_READY_VECTOR,
  EXTRF,
  FLASH_WORDS,
  INTF0,
  INTF1,
  ICF1,
  INT0_VECTOR,
  INT1_VECTOR,
  MCUSR,
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
  PORF,
  PCINT0_VECTOR,
  PCINT1_VECTOR,
  PCINT2_VECTOR,
  PRADC,
  PRSPI,
  PRTIM0,
  PRTIM1,
  PRTIM2,
  PRTWI,
  PRUSART0,
  SPIF,
  SPI_STC_VECTOR,
  SPSR,
  SPM_READY_VECTOR,
  TIFR0,
  TIFR1,
  TIFR2,
  TIMER0_COMPA_VECTOR,
  TIMER0_COMPB_VECTOR,
  TIMER0_OVF_VECTOR,
  TIMER1_COMPA_VECTOR,
  TIMER1_CAPT_VECTOR,
  TIMER1_COMPB_VECTOR,
  TIMER1_OVF_VECTOR,
  TIMER2_COMPA_VECTOR,
  TIMER2_COMPB_VECTOR,
  TIMER2_OVF_VECTOR,
  TOV0,
  TOV1,
  TOV2,
  TWI_VECTOR,
  TXC0,
  UCSR0A,
  USART_TX_VECTOR,
  USART_RX_VECTOR,
  USART_UDRE_VECTOR,
  WDRF,
  WDT_VECTOR,
} from "./cpu";
import type { IoWriteHook } from "./cpu";
import { IntelHexError, parseHex } from "./loader";
import {
  Adc,
  AnalogComparator,
  attachPeripheral,
  ChipControl,
  ClockControl,
  Eeprom,
  ExternalInterrupts,
  Gpio,
  PIN_MAP,
  pinInfo,
  PinChangeInterrupt,
  PowerReduction,
  SelfProgramming,
  SleepControl,
  Spi,
  Timer0,
  Timer1,
  Timer2,
  TimerSync,
  Twi,
  Usart0,
  Watchdog,
} from "./peripherals";
import type {
  AnalogChannelHandle,
  AnalogComparatorHandle,
  PinChangeEvent,
  PortName,
  PwmChannel,
  PwmSignal,
  PwmSource,
  SpiByteListener,
  SpiMasterHandle,
  SpiTransferResponder,
  TwiMasterHandle,
  TwiSlave,
} from "./peripherals";
import { AVR_SNAPSHOT_VERSION, type AVRSnapshot } from "./snapshot";

/**
 * Cap on buffered serial chunks before they are folded into the joined cache.
 * Keeps `serialChunks` bounded for long headless runs that never call
 * `serial.getText()`, while still avoiding a per-byte string concatenation during
 * bursts. (The browser worker bounds its own buffer per frame; this guards the
 * core `AVRRuntime` path.)
 */
const SERIAL_CHUNK_COMPACT_THRESHOLD = 1024;
/** Most host time one `start()` loop frame may simulate after a stall. */
const MAX_LOOP_CATCHUP_MS = 100;
const FUSE_BYTE_DEFAULT = 0xff;
const LOW_FUSE_CKDIV8 = 7;
const LOW_FUSE_SUT0 = 4;
const LOW_FUSE_SUT1 = 5;
const HIGH_FUSE_BOOTRST = 0;
const HIGH_FUSE_BOOTSZ0 = 1;
const HIGH_FUSE_BOOTSZ1 = 2;
const HIGH_FUSE_EESAVE = 3;
const HIGH_FUSE_WDTON = 4;
const FUSE_CONFIG_LOW = 1 << 0;
const FUSE_CONFIG_HIGH = 1 << 1;
const FUSE_CONFIG_EXTENDED = 1 << 2;
const FUSE_CONFIG_LOCK_BITS = 1 << 3;
const BOOT_SECTION_WORDS = [2048, 1024, 512, 256] as const;
const SUPPORTED_CHIPS: readonly AVRChip[] = ["atmega328p"];

/**
 * Public consumer facade: the `avrts` package root. Consumers use the
 * `AVR(...)` factory — they should never need `new`.
 */

/** Chip presets. Starts with one; future chips extend this union. */
export type AVRChip = "atmega328p";

export interface AVRFuseBytes {
  low: number;
  high: number;
  extended: number;
  lockBits: number;
}

export interface AVRFuseConfig {
  low?: number;
  high?: number;
  extended?: number;
  lockBits?: number;
}
     
/**
 * Timing granularity used by the simulator. `"fast"` (default) notifies
 * peripherals once per instruction; `"cycle-exact"` notifies them once per
 * CPU cycle so timer compare / overflow events land on the exact cycle they
 * would on real hardware.
 */
export type AVRTiming = "fast" | "cycle-exact";

export interface AVROptions {
  hex?: string;
  /** Filesystem path to an Intel HEX file. Node/Bun-only; browsers should use loadFile(...). */
  hexPath?: string | URL;
  /** Alias for hexPath, for the common `AVR({ path: "sketch.hex" })` shape. */
  path?: string | URL;
  chip?: AVRChip;
  clockHz?: number;
  timing?: AVRTiming;
  fuses?: AVRFuseConfig;
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

interface RuntimeResetOptions {
  clearProgram?: boolean;
  preserveCycles?: boolean;
}

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
  /** Raw transmitted bytes, exactly as the firmware wrote them to UDR0. */
  onByte(handler: (byte: number) => void): () => void;
  /**
   * Transmitted text, decoded as streaming UTF-8: multi-byte characters are
   * delivered once complete, invalid sequences become U+FFFD.
   */
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
  onByte(handler: SpiByteListener): () => void;
  respondWith(responder: SpiTransferResponder): void;
  master(): SpiMasterHandle;
}

export interface TwiHandle {
  connect(address: number, slave: TwiSlave): void;
  master(): TwiMasterHandle;
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

/** The public facade type returned by `AVR(...)`. */
export interface AVR {
  /** Low-level escape hatch for inspection/debugging. */
  readonly cpu: CPU;
  readonly gpio: GpioHandle;
  readonly pins: PinsHandle;
  readonly serial: SerialHandle;
  readonly eeprom: EepromHandle;
  readonly spi: SpiHandle;
  readonly twi: TwiHandle;
  readonly comparator: AnalogComparatorHandle;

  start(): this;
  pause(): this;
  resume(): this;
  stop(): this;
  frame(deltaMs: number): this;
  setSpeed(speed: AVRSpeed): this;

  use(options: AVROptions): this;
  useChip(chip: AVRChip): this;
  useClock(clockHz: number): this;
  useFuses(fuses: AVRFuseConfig): this;
  fuses(): AVRFuseBytes;
  useHex(hex: string): this;
  useHexFile(path: string | URL): this;
  useTiming(timing: AVRTiming): this;
  setEventCoalescing(options: AVREventCoalescingOptions): this;
  load(options: AVROptions): this;
  loadHex(hex: string): this;
  loadHexFile(path: string | URL): this;
  loadFile(fileLike: { text(): Promise<string> }): Promise<this>;
  clearProgram(): this;
  chipErase(): this;
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
  resetExternal(): this;
  resetBrownOut(): this;
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
  readonly comparator: AnalogComparatorHandle;

  private chip: AVRChip = "atmega328p";
  private baseClockHz = DEFAULT_CLOCK_HZ;
  private clockHz = DEFAULT_CLOCK_HZ;
  // Simulated time is integrated across clock changes: `timeBaseMs` elapsed by
  // `timeBaseCycles`, plus the cycles since then at the current clock.
  private timeBaseMs = 0;
  private timeBaseCycles = 0;
  private fuseBytes: AVRFuseBytes = defaultFuses();
  private configuredFuseMask = 0;
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
  private readonly analogComparator: AnalogComparator;
  private readonly eepromDevice: Eeprom;
  private readonly spiDevice: Spi;
  private readonly clockControl: ClockControl;
  private readonly chipControl: ChipControl;
  private readonly selfProgramming: SelfProgramming;
  private readonly twiDevice: Twi;
  private readonly powerReduction: PowerReduction;
  private readonly sleepControl: SleepControl;
  private readonly timerSync: TimerSync;
  private readonly watchdog: Watchdog;
  private readonly pcint: PinChangeInterrupt;
  private readonly exti: ExternalInterrupts;
  private readonly pinListeners = new Set<(event: PinChangeEvent) => void>();
  private readonly pendingPinEvents = new Map<number, PinChangeEvent>();
  private readonly textListeners = new Set<(text: string) => void>();
  private readonly components = new Set<AVRComponent>();
  private readonly eventListeners = new Map<AVREventName, Set<AVREventHandler>>();
  private readonly watchpoints = new Map<number, { handlers: Set<DataWatchHandler>; hook: IoWriteHook }>();
  private serialChunks: string[] = [];
  private serialTextCache = "";
  private serialTextDirty = false;
  // Streaming UTF-8 decoder for the serial *text* path (`onText`/`getText`).
  // Bytes of an incomplete multi-byte sequence are held until the sequence
  // completes; invalid sequences decode to U+FFFD. `onByte` stays raw.
  private serialDecoder = new TextDecoder();
  private readonly serialByteBuffer = new Uint8Array(1);
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
    this.analogComparator = new AnalogComparator(this.cpu, this.adc);
    this.eepromDevice = new Eeprom(this.cpu);
    this.spiDevice = new Spi(this.cpu, this.gpioPeripheral);
    this.clockControl = new ClockControl(this.cpu, (divider) => this.applyClockDivider(divider));
    this.chipControl = new ChipControl(this.cpu, () => this.bootStartWord());
    this.selfProgramming = new SelfProgramming(
      this.cpu,
      () => this.fuseBytes,
      (lockBits) => {
        this.fuseBytes = { ...this.fuseBytes, lockBits: lockBits & 0xff };
      },
      () => this.bootStartWord(),
      () => this.eepromDevice.updateInterrupt(),
    );
    this.twiDevice = new Twi(this.cpu);
    this.powerReduction = new PowerReduction(this.cpu, [
      { bit: PRADC, target: this.adc },
      { bit: PRUSART0, target: this.usart0 },
      { bit: PRSPI, target: this.spiDevice },
      { bit: PRTIM1, target: this.timer1 },
      { bit: PRTIM0, target: this.timer0 },
      { bit: PRTIM2, target: this.timer2 },
      { bit: PRTWI, target: this.twiDevice },
    ]);
    this.sleepControl = new SleepControl(this.cpu, [this.timer0, this.timer1, this.spiDevice, this.usart0], this.timer2, this.adc);
    this.timerSync = new TimerSync(this.cpu, [this.timer0, this.timer1], [this.timer2]);
    this.watchdog = new Watchdog(this.cpu, this.clockHz, {
      onSystemReset: () => {
        this.resetInternal({ preserveCycles: true }, 1 << WDRF);
      },
      alwaysOn: () => this.wdtonFuseProgrammed(),
    });
    this.pcint = new PinChangeInterrupt(this.cpu, this.gpioPeripheral);
    this.exti = new ExternalInterrupts(this.cpu, this.gpioPeripheral);
    // ACIC: comparator output edges reach the Timer1 input-capture unit.
    this.analogComparator.onCaptureTrigger((high) => this.timer1.comparatorCaptureEdge(high));
    attachPeripheral(this.cpu, this.gpioPeripheral);
    attachPeripheral(this.cpu, this.timer0);
    attachPeripheral(this.cpu, this.timer1);
    attachPeripheral(this.cpu, this.timer2);
    attachPeripheral(this.cpu, this.usart0);
    attachPeripheral(this.cpu, this.adc);
    attachPeripheral(this.cpu, this.analogComparator);
    attachPeripheral(this.cpu, this.eepromDevice);
    attachPeripheral(this.cpu, this.spiDevice);
    attachPeripheral(this.cpu, this.clockControl);
    attachPeripheral(this.cpu, this.chipControl);
    attachPeripheral(this.cpu, this.selfProgramming);
    attachPeripheral(this.cpu, this.twiDevice);
    attachPeripheral(this.cpu, this.powerReduction);
    attachPeripheral(this.cpu, this.timerSync);
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
      master: () => this.spiDevice.master(),
    };
    this.twi = {
      connect: (address, slave) => {
        this.twiDevice.connect(address, slave);
      },
      master: () => this.twiDevice.master(),
    };
    this.comparator = {
      setInput: (input, volts) => {
        this.analogComparator.setInput(input, volts);
      },
      readOutput: () => this.analogComparator.readOutput(),
    };
    this.cpu.data[MCUSR] = 1 << PORF;
    this.analogComparator.reset();
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
    this.cancelLoop();
    this.emit("pause");
    return this;
  }

  resume(): this {
    if (!this.running) return this.start();
    if (!this.paused) return this;
    this.paused = false;
    this.lastHostFrameMs = this.nowMs();
    this.scheduleLoop();
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
    let watch = this.watchpoints.get(addr);
    if (!watch) {
      const handlers = new Set<DataWatchHandler>();
      const hook: IoWriteHook = (_cpu, writeAddr, value, oldValue) => {
        const event: DataWatchEvent = { address: writeAddr, oldValue, value };
        for (const h of [...handlers]) h(event);
      };
      watch = { handlers, hook };
      this.watchpoints.set(addr, watch);
      this.cpu.installWriteHook(addr, hook);
    }
    watch.handlers.add(handler);

    return () => {
      const current = this.watchpoints.get(addr);
      if (!current || !current.handlers.delete(handler)) return;
      if (current.handlers.size > 0) return;
      // Last watcher gone: drop the CPU hook so the address returns to the fast path.
      this.watchpoints.delete(addr);
      this.cpu.removeWriteHook(addr, current.hook);
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
    const programSources =
      (options.hex !== undefined ? 1 : 0) +
      (options.hexPath !== undefined ? 1 : 0) +
      (options.path !== undefined ? 1 : 0);
    if (programSources > 1) {
      throw new Error(`AVR(options) accepts one program source: "hex", "hexPath", or "path".`);
    }
    if (options.chip) this.useChip(options.chip);
    if (options.clockHz !== undefined) this.useClock(options.clockHz);
    if (options.timing) this.useTiming(options.timing);
    if (options.fuses) this.useFuses(options.fuses);
    if (options.eventCoalescing) this.setEventCoalescing(options.eventCoalescing);
    if (options.hex !== undefined) this.useHex(options.hex);
    if (options.hexPath !== undefined) this.useHexFile(options.hexPath);
    if (options.path !== undefined) this.useHexFile(options.path);
    return this;
  }

  useChip(chip: AVRChip): this {
    this.chip = chip;
    return this;
  }

  useClock(clockHz: number): this {
    if (!Number.isFinite(clockHz) || clockHz <= 0) {
      throw new Error(`useClock(clockHz) expects a positive finite number, got ${clockHz}.`);
    }
    this.baseClockHz = clockHz;
    this.applyClockDivider(this.clockDivider());
    return this;
  }

  useFuses(fuses: AVRFuseConfig): this {
    if (fuses.low !== undefined) this.configuredFuseMask |= FUSE_CONFIG_LOW;
    if (fuses.high !== undefined) this.configuredFuseMask |= FUSE_CONFIG_HIGH;
    if (fuses.extended !== undefined) this.configuredFuseMask |= FUSE_CONFIG_EXTENDED;
    if (fuses.lockBits !== undefined) this.configuredFuseMask |= FUSE_CONFIG_LOCK_BITS;
    this.fuseBytes = {
      low: fuseByte("low", fuses.low, this.fuseBytes.low),
      high: fuseByte("high", fuses.high, this.fuseBytes.high),
      extended: fuseByte("extended", fuses.extended, this.fuseBytes.extended),
      lockBits: fuseByte("lockBits", fuses.lockBits, this.fuseBytes.lockBits),
    };
    return this;
  }

  fuses(): AVRFuseBytes {
    return { ...this.fuseBytes };
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
    const parsed = parseHex(hex);
    this.programSource = hex;
    this.cpu.flash.set(parsed);
    this.reset();
    this.emit("load");
    return this;
  }

  useHexFile(path: string | URL): this {
    return this.useHex(readHexFileSync(path));
  }

  load(options: AVROptions): this {
    return this.use(options);
  }

  loadHex(hex: string): this {
    return this.useHex(hex);
  }

  loadHexFile(path: string | URL): this {
    return this.useHexFile(path);
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

  chipErase(): this {
    this.programSource = null;
    this.cpu.flash.fill(0xffff);
    this.cpu.invalidateDecodeCache();
    this.fuseBytes = { ...this.fuseBytes, lockBits: FUSE_BYTE_DEFAULT };
    if (!this.fuseProgrammed(this.fuseBytes.high, HIGH_FUSE_EESAVE)) {
      this.eepromDevice.erase();
    }
    this.reset();
    this.emit("clear");
    return this;
  }

  reload(): this {
    if (this.programSource === null) return this;
    const hex = this.programSource;
    const parsed = parseHex(hex);
    this.cpu.flash.set(parsed);
    this.reset();
    this.emit("load");
    return this;
  }

  step(): this {
    this.cpu.clearBreakpointHit();
    this.cpu.clearError();
    this.cpu.tick();
    this.cpu.wrapProgramCounter();
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
    return this.resetInternal(options, 1 << PORF);
  }

  resetExternal(): this {
    return this.resetInternal({}, 1 << EXTRF);
  }

  resetBrownOut(): this {
    return this.resetInternal({}, 1 << BORF);
  }

  private resetInternal(options: RuntimeResetOptions, mcusrFlags: number): this {
    // Only power-on clears previous reset causes; other sources accumulate
    // until firmware clears their MCUSR bits by writing zero.
    const resetFlags = (mcusrFlags & (1 << PORF)) !== 0
      ? mcusrFlags : this.cpu.data[MCUSR]! | mcusrFlags;
    const preservedCycles = options.preserveCycles ? this.cpu.cycles : 0;
    if (options.clearProgram) {
      this.programSource = null;
      this.cpu.flash.fill(0);
    }
    this.cpu.reset();
    if (options.preserveCycles) this.cpu.cycles = preservedCycles;
    else this.resetTimeBase();
    this.cpu.pc = this.resetVectorWord();
    this.cpu.data[MCUSR] = resetFlags & 0x0f;
    this.timer0.reset();
    this.timer1.reset();
    this.timer2.reset();
    this.usart0.reset();
    this.adc.reset();
    this.analogComparator.reset();
    this.eepromDevice.reset();
    this.spiDevice.reset();
    this.clockControl.reset();
    this.applyFuseClockOnReset();
    this.applyStartupDelayOnReset();
    this.chipControl.reset();
    this.selfProgramming.reset();
    this.twiDevice.reset();
    this.powerReduction.reset();
    this.sleepControl.reset();
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
      timeMs: this.elapsedMs(),
      cycles: this.cpu.cycles,
      speed: this.speed,
      chip: this.chip,
      clockHz: this.clockHz,
      programLoaded: this.programSource !== null,
    };
  }

  snapshot(): AVRSnapshot {
    // Timer counters are synchronized lazily. Do this before copying CPU data
    // so the register image and peripheral remainders describe the same cycle.
    const timer0 = this.timer0.snapshot();
    const timer1 = this.timer1.snapshot();
    const timer2 = this.timer2.snapshot();
    return {
      version: AVR_SNAPSHOT_VERSION,
      cpu: this.cpu.snapshot(),
      runtime: {
        clockHz: this.clockHz,
        baseClockHz: this.baseClockHz,
        chip: this.chip,
        speed: this.speed,
        programSource: this.programSource,
        running: this.running,
        paused: this.paused,
        serialText: this.getSerialText(),
        timing: this.cpu.timing,
        fuses: this.fuses(),
        configuredFuseMask: this.configuredFuseMask,
        timeBaseMs: this.timeBaseMs,
        timeBaseCycles: this.timeBaseCycles,
      },
      gpio: this.gpioPeripheral.snapshot(),
      timer0,
      timer1,
      timer2,
      usart0: this.usart0.snapshot(),
      adc: this.adc.snapshot(),
      eeprom: this.eepromDevice.snapshot(),
      spi: this.spiDevice.snapshot(),
      clock: this.clockControl.snapshot(),
      chip: this.chipControl.snapshot(),
      spm: this.selfProgramming.snapshot(),
      comparator: this.analogComparator.snapshot(),
      twi: this.twiDevice.snapshot(),
      watchdog: this.watchdog.snapshot(),
      pcint: this.pcint.snapshot(),
      exti: this.exti.snapshot(),
    };
  }

  restore(snap: AVRSnapshot): this {
    validateSnapshot(snap);
    const wasRunning = this.running;

    this.cpu.restore(snap.cpu, (vector) => this.acknowledgeForVector(vector));
    this.chip = snap.runtime.chip;
    this.baseClockHz = snap.runtime.baseClockHz ?? snap.runtime.clockHz;
    this.clockHz = snap.runtime.clockHz;
    this.fuseBytes = normalizeFuses(snap.runtime.fuses);
    this.configuredFuseMask = snap.runtime.configuredFuseMask ?? 0;
    this.speed = snap.runtime.speed;
    this.programSource = snap.runtime.programSource;
    this.cpu.timing = snap.runtime.timing;
    this.gpioPeripheral.restore(snap.gpio);
    this.timer0.restore(snap.timer0);
    this.timer1.restore(snap.timer1);
    this.timer2.restore(snap.timer2, this.clockHz);
    this.usart0.restore(snap.usart0);
    this.adc.restore(snap.adc);
    this.analogComparator.restore(snap.comparator);
    this.eepromDevice.restore(snap.eeprom);
    this.spiDevice.restore(snap.spi);
    this.twiDevice.restore(snap.twi);
    this.clockControl.restore(snap.clock);
    this.chipControl.restore(snap.chip);
    this.selfProgramming.restore(snap.spm);
    this.powerReduction.restore();
    this.sleepControl.restore();
    this.timerSync.restore();
    this.watchdog.restore(snap.watchdog);
    this.pcint.restore(snap.pcint);
    this.exti.restore(snap.exti);
    this.setSerialText(snap.runtime.serialText);
    // After the peripheral restores, which may re-apply the clock divider.
    this.timeBaseMs = snap.runtime.timeBaseMs ?? 0;
    this.timeBaseCycles = snap.runtime.timeBaseCycles ?? 0;

    // Running/paused: cancel any active loop, then restart if the snapshot says so.
    this.running = false;
    this.paused = false;
    this.cancelLoop();
    if (snap.runtime.running) {
      this.running = true;
      this.paused = snap.runtime.paused;
      this.lastHostFrameMs = this.nowMs();
      if (!this.paused) this.scheduleLoop();
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
      case EE_READY_VECTOR:
        return () => this.eepromDevice.updateInterrupt();
      case SPM_READY_VECTOR:
        return () => this.selfProgramming.updateInterrupt();
      case WDT_VECTOR:
        return () => this.watchdog.acknowledgeInterrupt();
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
      case TIMER1_CAPT_VECTOR:
        return () => {
          this.cpu.data[TIFR1] = this.cpu.data[TIFR1]! & ~(1 << ICF1);
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
          this.cpu.data[SPSR] = this.cpu.data[SPSR]! & ~(1 << SPIF);
        };
      case TWI_VECTOR:
        return () => this.twiDevice.acknowledgeInterrupt();
      case ANALOG_COMP_VECTOR:
        return () => {
          this.cpu.data[ACSR] = this.cpu.readData(ACSR) & ~(1 << ACI);
        };
      case USART_TX_VECTOR:
        return () => {
          this.cpu.data[UCSR0A] = this.cpu.readData(UCSR0A) & ~(1 << TXC0);
        };
      case USART_RX_VECTOR:
      case USART_UDRE_VECTOR:
        return () => this.usart0.acknowledgeReadyInterrupt();
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
      timeMs: this.elapsedMs(),
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
    this.serialByteBuffer[0] = byte;
    const text = this.serialDecoder.decode(this.serialByteBuffer, { stream: true });
    if (text === "") return; // mid-sequence: wait for the remaining UTF-8 bytes
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
    // Drop any buffered partial UTF-8 sequence along with the text.
    this.serialDecoder = new TextDecoder();
  }

  private scheduleLoop(): void {
    if (this.loopHandle !== null || !this.running || this.paused) return;

    const raf = (globalThis as {
      requestAnimationFrame?: (callback: (timestamp: number) => void) => number;
    }).requestAnimationFrame;

    const tick = (timestamp?: number): void => {
      if (!this.running || this.paused) {
        this.loopHandle = null;
        return;
      }
      const now = typeof timestamp === "number" ? timestamp : this.nowMs();
      // Clamp so a throttled/backgrounded tab never replays minutes of missed
      // time in one blocking frame (the worker runtime applies the same cap).
      const deltaMs = Math.min(MAX_LOOP_CATCHUP_MS, Math.max(0, now - this.lastHostFrameMs));
      this.lastHostFrameMs = now;
      try {
        if (!this.paused) this.frame(deltaMs);
      } catch (error) {
        this.stop();
        this.emit("error", error);
        return;
      }
      // reportDebugState (called by frame -> runCycles) may have paused on a
      // breakpoint/captured error, or pause()/stop() may have cancelled the loop.
      if (!this.running || this.paused) {
        this.loopHandle = null;
        return;
      }
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

  private resetVectorWord(): number {
    return this.fuseProgrammed(this.fuseBytes.high, HIGH_FUSE_BOOTRST) ? this.bootStartWord() : 0;
  }

  private bootStartWord(): number {
    const bootsz =
      ((this.fuseBytes.high >> HIGH_FUSE_BOOTSZ1) & 1) << 1 |
      ((this.fuseBytes.high >> HIGH_FUSE_BOOTSZ0) & 1);
    return FLASH_WORDS - BOOT_SECTION_WORDS[bootsz]!;
  }

  private applyFuseClockOnReset(): void {
    const clkps = this.fuseProgrammed(this.fuseBytes.low, LOW_FUSE_CKDIV8) ? 3 : 0;
    this.cpu.data[CLKPR] = clkps;
    this.applyClockDivider(1 << clkps);
  }

  private applyStartupDelayOnReset(): void {
    const delay = this.startupDelayCycles();
    if (delay > 0) this.cpu.cycles = this.cpu.cycles + delay;
  }

  private startupDelayCycles(): number {
    if ((this.configuredFuseMask & FUSE_CONFIG_LOW) === 0) return 0;

    const low = this.fuseBytes.low;
    const cksel = low & 0x0f;
    const sut = ((low >> LOW_FUSE_SUT1) & 1) << 1 | ((low >> LOW_FUSE_SUT0) & 1);
    if (cksel === 0x02) {
      switch (sut) {
        case 0:
          return 25; // 6 CK oscillator startup + 19 CK reset delay.
        case 1:
          return 25 + this.msToCycles(4);
        case 2:
          return 25 + this.msToCycles(65);
        default:
          return 0; // Reserved SUT setting for calibrated internal RC.
      }
    }

    const oscillatorCycles = sut === 0 ? 6 : sut === 1 ? 258 : 16_384;
    const resetCycles = 14;
    const extraDelayMs = sut === 2 ? 4 : sut === 3 ? 65 : 0;
    return oscillatorCycles + resetCycles + this.msToCycles(extraDelayMs);
  }

  private msToCycles(ms: number): number {
    return Math.max(0, Math.round((ms / 1000) * this.clockHz));
  }

  private wdtonFuseProgrammed(): boolean {
    return this.fuseProgrammed(this.fuseBytes.high, HIGH_FUSE_WDTON);
  }

  private fuseProgrammed(byte: number, bit: number): boolean {
    return (byte & (1 << bit)) === 0;
  }

  private clockDivider(): number {
    const clkps = this.cpu.data[CLKPR]! & 0x0f;
    return 1 << Math.min(clkps, 8);
  }

  private elapsedMs(): number {
    return this.timeBaseMs + ((this.cpu.cycles - this.timeBaseCycles) / this.clockHz) * 1000;
  }

  private resetTimeBase(): void {
    this.timeBaseMs = 0;
    this.timeBaseCycles = 0;
  }

  private applyClockDivider(divider: number): void {
    const normalized = Number.isFinite(divider) && divider > 0 ? divider : 1;
    // Bank the time elapsed at the old clock before switching rates.
    this.timeBaseMs = this.elapsedMs();
    this.timeBaseCycles = this.cpu.cycles;
    this.clockHz = this.baseClockHz / normalized;
    this.watchdog.setClock(this.clockHz);
    this.timer2.setClock(this.clockHz);
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
 *   AVR("sketch.hex")
 *   AVR({ hex, chip, clockHz })
 *   AVR({ path: "sketch.hex" })
 *   AVR().useHexFile("sketch.hex")
 */
export function AVR(input?: string | AVROptions): AVR {
  const runtime = new AVRRuntime();
  if (typeof input === "string") {
    runtime.useHex(resolveHexTextOrPath(input));
  } else if (input) {
    runtime.use(input);
  }
  return runtime;
}

function resolveHexTextOrPath(input: string): string {
  if (looksLikeHexText(input)) return input;
  if (looksLikeHexPath(input)) return readHexFileSync(input);
  const preview = input.length > 40 ? `${input.slice(0, 40)}...` : input;
  throw new IntelHexError(
    `AVR(string) expects Intel HEX text (records start with ':') or a path to a .hex file; ` +
      `got "${preview}". For a path without a .hex extension or directory, use AVR({ path }).`,
  );
}

function looksLikeHexText(input: string): boolean {
  return input.trimStart().startsWith(":");
}

function looksLikeHexPath(input: string): boolean {
  const text = input.trim();
  if (text === "" || /[\r\n]/.test(input)) return false;
  return /\.i?hex$/i.test(text) || /[\\/]/.test(text) || /^file:/i.test(text);
}

type ReadFileSync = (path: string | URL, encoding: BufferEncoding) => string;

function readHexFileSync(path: string | URL): string {
  const readFileSync = runtimeReadFileSync();
  const display = path instanceof URL ? path.href : path;
  if (!readFileSync) {
    throw new Error(
      `Cannot read HEX file "${display}" because this runtime has no synchronous filesystem API. ` +
        `Pass HEX text directly or use await avr.loadFile(file) in the browser.`,
    );
  }
  try {
    return readFileSync(normalizeFilePath(path), "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read HEX file "${display}": ${message}`);
  }
}

function normalizeFilePath(path: string | URL): string | URL {
  if (typeof path === "string" && /^file:/i.test(path)) return new URL(path);
  return path;
}

function runtimeReadFileSync(): ReadFileSync | null {
  const processWithBuiltins = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const fsFromProcess =
    processWithBuiltins?.getBuiltinModule?.("node:fs") ?? processWithBuiltins?.getBuiltinModule?.("fs");
  const fromProcess = readFileSyncFrom(fsFromProcess);
  if (fromProcess) return fromProcess;

  try {
    const requireFn = Function("return typeof require === 'function' ? require : undefined")() as
      | ((id: string) => unknown)
      | undefined;
    const fsFromRequire = requireFn?.("node:fs") ?? requireFn?.("fs");
    return readFileSyncFrom(fsFromRequire);
  } catch {
    return null;
  }
}

function readFileSyncFrom(moduleLike: unknown): ReadFileSync | null {
  const readFileSync = (moduleLike as { readFileSync?: unknown } | undefined)?.readFileSync;
  return typeof readFileSync === "function" ? (readFileSync.bind(moduleLike) as ReadFileSync) : null;
}

/** Reject snapshots this build cannot restore before any state is touched. */
function validateSnapshot(snap: AVRSnapshot): void {
  if (!snap || typeof snap !== "object" || !snap.cpu || !snap.runtime) {
    throw new Error("restore(snapshot) expects an object returned by avr.snapshot().");
  }
  const version = snap.version ?? 0;
  if (!Number.isInteger(version) || version < 0 || version > AVR_SNAPSHOT_VERSION) {
    throw new Error(
      `restore(snapshot) got snapshot version ${String(snap.version)}; ` +
        `this avrts build supports versions 0-${AVR_SNAPSHOT_VERSION}.`,
    );
  }
  if (!SUPPORTED_CHIPS.includes(snap.runtime.chip)) {
    throw new Error(`restore(snapshot) got a snapshot for unsupported chip "${String(snap.runtime.chip)}".`);
  }
}

function defaultFuses(): AVRFuseBytes {
  return {
    low: FUSE_BYTE_DEFAULT,
    high: FUSE_BYTE_DEFAULT,
    extended: FUSE_BYTE_DEFAULT,
    lockBits: FUSE_BYTE_DEFAULT,
  };
}

function normalizeFuses(fuses: AVRFuseConfig | undefined): AVRFuseBytes {
  const defaults = defaultFuses();
  return {
    low: fuseByte("low", fuses?.low, defaults.low),
    high: fuseByte("high", fuses?.high, defaults.high),
    extended: fuseByte("extended", fuses?.extended, defaults.extended),
    lockBits: fuseByte("lockBits", fuses?.lockBits, defaults.lockBits),
  };
}

function fuseByte(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`useFuses(${name}) expects an integer byte, got ${value}.`);
  }
  return value & 0xff;
}
