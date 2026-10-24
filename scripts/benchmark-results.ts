/**
 * Result/fidelity benchmark, not a speed benchmark.
 *
 * Runs compiled Arduino sketches in avrts and avr8js with the same host-provided
 * ADC/GPIO/I2C environment. The pass condition is identical observable result
 * state, not cycles/second.
 */
import { AVR, CPU } from "../src";
import { loadHex } from "../src/loader";
import {
  ADCH,
  ADCL,
  DDRD,
  FLASH_WORDS,
  OCR0B,
  OCR2B,
  PIND,
  PORTB,
  PORTC,
  PORTD,
  TCCR0A,
  TCCR2A,
  TWDR,
  TWSR,
} from "../src/cpu";
import peripheralMixHex from "../examples/arduino-peripheral-mix/arduino-peripheral-mix.ino.hex" with {
  type: "text",
};
import isrHeavyHex from "../examples/arduino-isr-heavy/arduino-isr-heavy.ino.hex" with {
  type: "text",
};
import stringHeavyHex from "../examples/arduino-string-heavy/arduino-string-heavy.ino.hex" with {
  type: "text",
};
import dspFixedHex from "../examples/arduino-dsp-fixed/arduino-dsp-fixed.ino.hex" with {
  type: "text",
};
import peripheralBoundHex from "../examples/arduino-peripheral-bound/arduino-peripheral-bound.ino.hex" with { type: "text" };
import floatMathHex from "../examples/arduino-float-math/arduino-float-math.ino.hex" with { type: "text" };
import serialPrintHex from "../examples/arduino-serial-print/arduino-serial-print.ino.hex" with { type: "text" };
import analogWriteHex from "../examples/arduino-analog-write/arduino-analog-write.ino.hex" with { type: "text" };
import delayBlinkHex from "../examples/delay-blink/delay-blink.ino.hex" with { type: "text" };
import tightLoopHex from "../examples/tight-loop/tight-loop.hex" with { type: "text" };
import sensorFormatHex from "../examples/arduino-sensor-format/arduino-sensor-format.ino.hex" with { type: "text" };
import bitbangCrcHex from "../examples/arduino-bitbang-crc/arduino-bitbang-crc.ino.hex" with { type: "text" };
import {
  CPU as Avr8jsCPU,
  avrInstruction,
  AVRADC,
  adcConfig,
  AVRIOPort,
  portBConfig,
  portCConfig,
  portDConfig,
  AVRTimer,
  timer0Config,
  timer1Config,
  timer2Config,
  AVRTWI,
  type TWIEventHandler,
  twiConfig,
  AVRUSART,
  usart0Config,
} from "avr8js";

const CLOCK_HZ = 16_000_000;
const RESULT_ADDR = 0x0300;
export function resultLengthFor(scenario: string): number {
  return scenario === "sensor-format" ? 53 : 21;
}
const RESULT_START = 0xa7;
const RESULT_END = 0x5c;
const RESULT_MODE_ADDR = 0x02ff;
const RESULT_HALT_MODE = 0x42;
const STRING_HEAVY_SERIAL_FLUSH_CYCLES = 500_000;
const DEFAULT_MAX_CYCLES = 5_000_000;
const DEFAULT_ANALOG_RAW = 512;
const DEFAULT_D2_HIGH = true;
const DEFAULT_CASE: ResultCase = "all";

type ResultScenario = "peripheral-mix" | "isr-heavy" | "string-heavy" | "dsp-fixed" | "peripheral-bound" | "float-math" | "bitbang-crc" | "sensor-format" | "serial-print" | "analog-write" | "delay-blink" | "tight-loop";
type ResultCase = ResultScenario | "all";

const RESULT_SCENARIOS: readonly ResultScenario[] = ["peripheral-mix", "isr-heavy", "string-heavy", "dsp-fixed", "peripheral-bound", "float-math", "bitbang-crc", "sensor-format", "serial-print", "analog-write", "delay-blink", "tight-loop"];

interface ResultOptions {
  scenario: ResultScenario;
  maxCycles: number;
  analogRaw: number;
  d2High: boolean;
  bitbangInput: number;
  sensorStart: number;
}

interface CliOptions {
  scenario: ResultCase;
  maxCycles?: number;
  analogRaw: number;
  d2High: boolean;
  bitbangInput: number;
  sensorStart: number;
}

interface TwiTranscript {
  starts: string[];
  writes: number[];
  reads: number[];
  stops: number;
}

interface ScenarioOutcome {
  engine: "avrts" | "avr8js";
  completed: boolean;
  cycles: number;
  result: number[];
  registers: Record<string, number>;
  twi: TwiTranscript;
  serial: number[];
  bitbang?: BitbangTrace;
  pins?: PinTrace;
}

export interface BitbangTrace {
  risingEdges: number;
  fallingEdges: number;
  mosi: number[];
}

// Compiled AVR-libc bytes agreed by the independent peers; do not replace this
// with JavaScript Math, whose intermediate rounding differs from AVR float.
const FLOAT_MATH_RESULT = [0xa7, 32, 0x03, 0x82, 0x80, 0x41, 0x70, 0xc8, 0x8e, 0x3e,
  32, 0, 0, 0, 32, 32, 1, 1, 0, 0xf1, 0x5c];
const BITBANG_MOSI = [0x31, 0x43, 0x51, 0x67, 0x71, 0x83, 0x91, 0xaf,
  0xb1, 0xc3, 0xd1, 0xe7, 0xf1, 0x03, 0x11, 0x2f,
  0x21, 0x53, 0x41, 0x77, 0x61, 0x93, 0x81, 0xbf,
  0xa1, 0xd3, 0xc1, 0xf7, 0xe1, 0x13, 0x01, 0x3f];

// Host specification of Arduino's integer map, unsigned accumulation, circular
// history, PWM endpoint rules, and serial formatting. No simulator state is used.
export function expectedSensorFormat(start = 0): { result: number[]; serial: number[] } {
  const calibration = [12, 48, 103, 161, 220, 276, 331, 387,
    444, 503, 559, 612, 668, 721, 777, 831,
    884, 932, 978, 1007, 991, 941, 887, 832,
    776, 714, 655, 594, 531, 462, 391, 255];
  const history = Array<number>(16).fill(0);
  let index = start;
  let accumulator = 0;
  let raw = 0;
  let scaled = 0;
  let duty = 0;
  let ocr2b = 0;
  let ocr1a = 0;
  let text = "";
  for (let sample = 0; sample < 144; sample++) {
    raw = (calibration[index & 31]! + ((index * 37) & 1023)) & 1023;
    scaled = Math.trunc(raw * 1050 / 1023) - 200;
    accumulator = (accumulator + (scaled + 200) * ((index & 7) + 1)) >>> 0;
    history[index & 15] = scaled & 0xffff;
    duty = ((accumulator >>> 5) ^ (scaled & 0xffff)) & 255;
    if (duty !== 0 && duty !== 255) {
      ocr2b = duty;
      ocr1a = 255 - duty;
    }
    if ((index & 127) === 0) text += `sample=${index},raw=${raw},scaled=${scaled}\r\n`;
    index = (index + 1) & 0xffff;
  }
  const lo = (value: number) => value & 255;
  const hi = (value: number) => (value >>> 8) & 255;
  const connected = duty !== 0 && duty !== 255;
  return {
    result: [0xa7, lo(index), hi(index), lo(accumulator), hi(accumulator),
      (accumulator >>> 16) & 255, accumulator >>> 24, duty, lo(raw), hi(raw),
      lo(scaled), hi(scaled), ocr2b, ocr1a, 0, connected ? 0x21 : 1,
      connected ? 0x81 : 1, 0x98, 0x40, 0x53,
      ...history.flatMap((value) => [lo(value), hi(value)]), 0x5c],
    serial: [...new TextEncoder().encode(text)],
  };
}

export function expectedArithmeticResult(scenario: string, input = 0x96): number[] | undefined {
  if (scenario === "float-math") return [...FLOAT_MATH_RESULT];
  if (scenario !== "bitbang-crc") return undefined;
  // CRC-8 polynomial 0x07, seed 0x5a, no reflection/final XOR. This host
  // specification operates on bytes, independently of the simulated AVR ALU.
  let crc8 = 0x5a;
  for (const value of BITBANG_MOSI) {
    crc8 ^= value ^ input;
    for (let bit = 0; bit < 8; bit++) crc8 = ((crc8 << 1) ^ ((crc8 & 0x80) ? 7 : 0)) & 0xff;
  }
  return [0xa7, 32, crc8, 0x19, 0x4f, 0, input, 0x3f, 32, 0, 0, 0,
    0x18, 0x28, (input & 1) ? 0x10 : 0, 0, 0, 0, 0, 0xb1, 0x5c];
}

export function validateResultExpectations(
  scenario: string,
  outcome: { result: number[]; serial?: number[]; bitbang?: BitbangTrace; pins?: PinTrace; unsupportedPinTrace?: number[] },
  input = 0x96,
  sensorStart = 0,
): string[] {
  const differences: string[] = [];
  const expected = expectedArithmeticResult(scenario, input);
  if (expected && JSON.stringify(outcome.result) !== JSON.stringify(expected)) {
    differences.push(`expected ${scenario} result ${JSON.stringify(expected)}, got ${JSON.stringify(outcome.result)}`);
  }
  if (scenario === "bitbang-crc") {
    const trace = { risingEdges: 256, fallingEdges: 256, mosi: BITBANG_MOSI };
    if (JSON.stringify(outcome.bitbang) !== JSON.stringify(trace)) {
      differences.push(`expected 256 rising/falling bitbang edges and MOSI ${JSON.stringify(BITBANG_MOSI)}, got ${JSON.stringify(outcome.bitbang)}`);
    }
  }
  if (scenario === "sensor-format") {
    const sensor = expectedSensorFormat(sensorStart);
    if (JSON.stringify(outcome.result) !== JSON.stringify(sensor.result)) {
      differences.push(`expected sensor-format result ${JSON.stringify(sensor.result)}, got ${JSON.stringify(outcome.result)}`);
    }
    if (JSON.stringify(outcome.serial) !== JSON.stringify(sensor.serial)) {
      differences.push(`expected sensor-format serial ${JSON.stringify(sensor.serial)}, got ${JSON.stringify(outcome.serial)}`);
    }
  }
  const startupExpected = scenario === "serial-print"
    ? [0xa7, 0x40, 0x98, 6, 207, 0, ...Array<number>(13).fill(0), 0x51, 0x5c]
    : scenario === "analog-write"
      ? [0xa7, 191, 64, 192, 51, 128, 0x23, 3, 0xa1, 3, 0xa1, 4, 14, 40, 0, 0, 0, 0, 0, 0x54, 0x5c]
      : scenario === "delay-blink"
        ? [0xa7, 2, 0, 32, 3, 3, ...Array<number>(13).fill(0), 0x52, 0x5c]
        : scenario === "tight-loop" ? [0, 255, 8, 0, ...Array<number>(32).fill(0)] : undefined;
  if (startupExpected && JSON.stringify(outcome.result) !== JSON.stringify(startupExpected)) differences.push(`expected ${scenario} state ${JSON.stringify(startupExpected)}, got ${JSON.stringify(outcome.result)}`);
  if (scenario === "serial-print" && JSON.stringify(outcome.serial) !== JSON.stringify([...new TextEncoder().encode("hello avrts\r\n")])) differences.push("expected exact serial-print startup text including final CRLF");
  if (scenario === "analog-write" || scenario === "delay-blink") differences.push(...validatePinTrace(scenario, outcome.pins, outcome.unsupportedPinTrace));
  return differences;
}

/** Repeated MSB-first input byte, sampled MOSI, and both clock edges. */
export function createBitbangDriver(input: number, readMosi: () => boolean, writeMiso: (high: boolean) => void) {
  const trace: BitbangTrace = { risingEdges: 0, fallingEdges: 0, mosi: [] };
  let previous = false;
  let byte = 0;
  writeMiso((input & 0x80) !== 0);
  return {
    trace,
    onClock(high: boolean) {
      if (high === previous) return;
      previous = high; // Input injection can re-enter a port listener.
      if (high) {
        const bit = trace.risingEdges & 7;
        writeMiso((input & (0x80 >> bit)) !== 0);
        byte = ((byte << 1) | Number(readMosi())) & 0xff;
        trace.risingEdges++;
        if (bit === 7) trace.mosi.push(byte);
      } else {
        trace.fallingEdges++;
      }
    },
  };
}

interface CompareResult {
  pass: boolean;
  avrts: ScenarioOutcome;
  avr8js: ScenarioOutcome;
  differences: string[];
}

export function defaultResultBudget(scenario: string): number {
  return scenario === "delay-blink" ? 70_000_000 : scenario === "tight-loop" ? 10_000 : DEFAULT_MAX_CYCLES;
}

export type PinTrace = Record<string, { cycle: number; high: boolean }[]>;
export function tracePinsFor(scenario: string): number[] {
  return scenario === "analog-write" ? [3, 5, 9, 10, 11] : scenario === "delay-blink" ? [13] : [];
}
export function createPinTrace(scenario: string) {
  const pins: PinTrace = {};
  for (const pin of tracePinsFor(scenario)) pins[pin] = [];
  return { pins, onChange(pin: number, high: boolean, cycle: number) {
    const events = pins[pin]!;
    if (high === (events.at(-1)?.high ?? false)) return;
    events.push({cycle, high});
  }};
}

export function validatePinTrace(scenario: string, pins: PinTrace | undefined, unsupported: number[] = []): string[] {
  const errors: string[] = [];
  for (const pin of tracePinsFor(scenario)) {
    if (unsupported.includes(pin)) continue;
    const events = pins?.[pin] ?? [];
    if (scenario === "delay-blink") {
      if (JSON.stringify(events.map((e) => e.high)) !== "[true,false,true,false]") errors.push("blink must produce two complete high/low periods");
      for (let i = 1; i < events.length; i++) {
        if (Math.abs(events[i]!.cycle - events[i - 1]!.cycle - 16_000_000) > 32_768) errors.push("blink interval must be one second within two Timer0 overflow periods");
      }
    } else {
      // Discard connection/startup edges and the deliberate final stop edge.
      const steady = events.slice(3, -1);
      const rises = steady.filter((e) => e.high);
      const period = pin === 5 ? 16384 : 32640;
      const highCycles = ({ 3: 128 * 128, 5: 192 * 64, 9: 64 * 128, 10: 192 * 128, 11: 51 * 128 } as Record<number, number>)[pin]!;
      if (rises.length < 4) errors.push(`pin ${pin}: missing steady PWM periods`);
      for (let i = 1; i < rises.length; i++) if (Math.abs(rises[i]!.cycle - rises[i - 1]!.cycle - period) > 4) errors.push(`pin ${pin}: incorrect PWM period`);
      for (let i = 0; i < steady.length - 1; i++) if (steady[i]!.high && !steady[i + 1]!.high && Math.abs(steady[i + 1]!.cycle - steady[i]!.cycle - highCycles) > 128) errors.push(`pin ${pin}: incorrect PWM high time`);
    }
  }
  return errors;
}

const SCENARIO_HEX: Record<ResultScenario, string> = {
  "peripheral-mix": peripheralMixHex,
  "isr-heavy": isrHeavyHex,
  "string-heavy": stringHeavyHex,
  "dsp-fixed": dspFixedHex,
  "peripheral-bound": peripheralBoundHex,
  "float-math": floatMathHex,
  "bitbang-crc": bitbangCrcHex,
  "sensor-format": sensorFormatHex,
  "serial-print": serialPrintHex,
  "analog-write": analogWriteHex,
  "delay-blink": delayBlinkHex,
  "tight-loop": tightLoopHex,
};

function programFor(hex: string): Uint16Array {
  const progMem = new Uint16Array(FLASH_WORDS);
  loadHex(hex, progMem);
  return progMem;
}

export function createTranscript(): TwiTranscript {
  return { starts: [], writes: [], reads: [], stops: 0 };
}

function nextTwiRead(transcript: TwiTranscript): number {
  const last = transcript.writes.at(-1) ?? 0;
  const prev = transcript.writes.at(-2) ?? 0;
  return (0xa5 ^ last ^ prev ^ ((transcript.writes.length * 17) & 0xff)) & 0xff;
}

export function createAvrtsTwiSlave(transcript: TwiTranscript) {
  return {
    start(address: number, read: boolean): boolean {
      transcript.starts.push(`${read ? "R" : "W"}@${address.toString(16).padStart(2, "0")}`);
      return address === 0x50;
    },
    write(byte: number): boolean {
      transcript.writes.push(byte & 0xff);
      return true;
    },
    read(): number {
      const value = nextTwiRead(transcript);
      transcript.reads.push(value);
      return value;
    },
    stop(): void {
      transcript.stops += 1;
    },
  };
}

export class Avr8jsTwiSlave implements TWIEventHandler {
  constructor(
    private readonly twi: AVRTWI,
    private readonly transcript: TwiTranscript,
  ) {}

  start(): void {
    this.twi.completeStart();
  }

  stop(): void {
    this.transcript.stops += 1;
    this.twi.completeStop();
  }

  connectToSlave(address: number, write: boolean): void {
    this.transcript.starts.push(`${write ? "W" : "R"}@${address.toString(16).padStart(2, "0")}`);
    this.twi.completeConnect(address === 0x50);
  }

  writeByte(value: number): void {
    this.transcript.writes.push(value & 0xff);
    this.twi.completeWrite(true);
  }

  readByte(): void {
    const value = nextTwiRead(this.transcript);
    this.transcript.reads.push(value);
    this.twi.completeRead(value);
  }
}

function readResult(data: Uint8Array, scenario: string): number[] {
  return [...data.slice(RESULT_ADDR, RESULT_ADDR + resultLengthFor(scenario))];
}

function isComplete(data: Uint8Array, scenario: string): boolean {
  return data[RESULT_ADDR] === RESULT_START && data[RESULT_ADDR + resultLengthFor(scenario) - 1] === RESULT_END;
}

function readRegisters(data: Uint8Array): Record<string, number> {
  return {
    portB: data[PORTB]!,
    portC: data[PORTC]!,
    portD: data[PORTD]!,
    ddrD: data[DDRD]!,
    pinD2: data[PIND]! & (1 << 2),
    ocr0b: data[OCR0B]!,
    ocr2b: data[OCR2B]!,
    tccr0a: data[TCCR0A]!,
    tccr2a: data[TCCR2A]!,
    twsr: data[TWSR]! & 0xf8,
    twdr: data[TWDR]!,
    adcl: data[ADCL]!,
    adch: data[ADCH]!,
  };
}

function runAvrts(options: ResultOptions): ScenarioOutcome {
  const avr = AVR({ hex: SCENARIO_HEX[options.scenario], timing: "cycle-exact" });
  const transcript = createTranscript();
  const serial: number[] = [];
  const pinTrace = createPinTrace(options.scenario);
  const bitbang = options.scenario === "bitbang-crc"
    ? createBitbangDriver(options.bitbangInput, () => avr.pin(11).read(), (high) => avr.pin(12).setInput(high))
    : undefined;
  if (bitbang) avr.pin(13).onChange((high) => bitbang.onClock(high));
  for (const pin of tracePinsFor(options.scenario)) avr.pin(pin).onChange((high) => pinTrace.onChange(pin, high, avr.cpu.cycles));
  avr.cpu.data[RESULT_MODE_ADDR] = RESULT_HALT_MODE;
  if (options.scenario === "sensor-format") {
    avr.cpu.data[0x2fc] = options.sensorStart & 0xff;
    avr.cpu.data[0x2fd] = options.sensorStart >> 8;
  }
  avr.analog(0).setValue(options.analogRaw);
  avr.pin(2).setInput(options.d2High);
  avr.serial.onByte((byte) => serial.push(byte & 0xff));
  if (options.scenario === "peripheral-mix") {
    avr.twi.connect(0x50, createAvrtsTwiSlave(transcript));
  }

  while (avr.cpu.cycles < options.maxCycles && (options.scenario === "tight-loop" || !isComplete(avr.cpu.data, options.scenario))) {
    avr.runCycles(Math.min(10_000, options.maxCycles - avr.cpu.cycles));
  }
  if (options.scenario === "string-heavy" && isComplete(avr.cpu.data, options.scenario)) {
    avr.runCycles(STRING_HEAVY_SERIAL_FLUSH_CYCLES);
  }

  return {
    engine: "avrts",
    completed: options.scenario === "tight-loop" ? avr.cpu.cycles >= options.maxCycles : isComplete(avr.cpu.data, options.scenario),
    cycles: avr.cpu.cycles,
    result: options.scenario === "tight-loop" ? [avr.cpu.pc, avr.cpu.data[0x5d]!, avr.cpu.data[0x5e]!, avr.cpu.data[0x5f]!, ...avr.cpu.data.slice(0, 32)] : readResult(avr.cpu.data, options.scenario),
    registers: options.scenario === "tight-loop" ? {} : readRegisters(avr.cpu.data),
    twi: transcript,
    serial,
    bitbang: bitbang?.trace,
    pins: tracePinsFor(options.scenario).length ? pinTrace.pins : undefined,
  };
}

function runAvr8js(options: ResultOptions): ScenarioOutcome {
  const cpu = new Avr8jsCPU(programFor(SCENARIO_HEX[options.scenario]), 2048);
  cpu.data[RESULT_MODE_ADDR] = RESULT_HALT_MODE;
  if (options.scenario === "sensor-format") {
    cpu.data[0x2fc] = options.sensorStart & 0xff;
    cpu.data[0x2fd] = options.sensorStart >> 8;
  }
  const portB = new AVRIOPort(cpu, portBConfig);
  new AVRIOPort(cpu, portCConfig);
  const portD = new AVRIOPort(cpu, portDConfig);
  new AVRTimer(cpu, timer0Config);
  new AVRTimer(cpu, timer1Config);
  new AVRTimer(cpu, timer2Config);
  const adc = new AVRADC(cpu, adcConfig);
  const twi = new AVRTWI(cpu, twiConfig, CLOCK_HZ);
  const usart = new AVRUSART(cpu, usart0Config, CLOCK_HZ);
  const transcript = createTranscript();
  const serial: number[] = [];
  const pinTrace = createPinTrace(options.scenario);
  const bitbang = options.scenario === "bitbang-crc"
    ? createBitbangDriver(options.bitbangInput, () => (cpu.data[PORTB]! & 8) !== 0, (high) => portB.setPin(4, high))
    : undefined;
  if (bitbang) portB.addListener((value) => bitbang.onClock((value & 32) !== 0));
  for (const pin of tracePinsFor(options.scenario)) {
    const port = pin < 8 ? portD : portB;
    const bit = pin < 8 ? pin : pin - 8;
    port.addListener((value) => pinTrace.onChange(pin, (value & (1 << bit)) !== 0, cpu.cycles));
  }
  usart.onByteTransmit = (byte) => serial.push(byte & 0xff);
  if (options.scenario === "peripheral-mix") {
    twi.eventHandler = new Avr8jsTwiSlave(twi, transcript);
  }
  adc.channelValues[0] = (options.analogRaw / 1024) * 5;
  portD.setPin(2, options.d2High);

  while (cpu.cycles < options.maxCycles && (options.scenario === "tight-loop" || !isComplete(cpu.data, options.scenario))) {
    avrInstruction(cpu);
    cpu.tick();
  }
  if (options.scenario === "string-heavy" && isComplete(cpu.data, options.scenario)) {
    const flushTarget = cpu.cycles + STRING_HEAVY_SERIAL_FLUSH_CYCLES;
    while (cpu.cycles < flushTarget) {
      avrInstruction(cpu);
      cpu.tick();
    }
  }

  // Touch these so the harness keeps constructing the same visible GPIO surface
  // if a future cleanup tries to narrow the peripheral set too far.
  void portB;

  return {
    engine: "avr8js",
    completed: options.scenario === "tight-loop" ? cpu.cycles >= options.maxCycles : isComplete(cpu.data, options.scenario),
    cycles: cpu.cycles,
    result: options.scenario === "tight-loop" ? [cpu.pc, cpu.data[0x5d]!, cpu.data[0x5e]!, cpu.data[0x5f]!, ...cpu.data.slice(0, 32)] : readResult(cpu.data, options.scenario),
    registers: options.scenario === "tight-loop" ? {} : readRegisters(cpu.data),
    twi: transcript,
    serial,
    bitbang: bitbang?.trace,
    pins: tracePinsFor(options.scenario).length ? pinTrace.pins : undefined,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort(), 2);
}

function comparableResult(scenario: ResultScenario, outcome: ScenarioOutcome): number[] {
  const result = [...outcome.result];
  if (scenario === "peripheral-mix") {
    // avrts now models TWI bus time, while avr8js completes TWI immediately.
    // The fixture's byte 6 is only the old "timerTicks <= 120" threshold, so it
    // is no longer a parity signal between these two engines.
    result[6] = 0;
  }
  return result;
}

function diffOutcomes(scenario: ResultScenario, avrts: ScenarioOutcome, avr8js: ScenarioOutcome): string[] {
  const differences: string[] = [];
  if (!avrts.completed) differences.push(`avrts did not write the result marker within ${avrts.cycles} cycles`);
  if (!avr8js.completed) differences.push(`avr8js did not write the result marker within ${avr8js.cycles} cycles`);
  if (JSON.stringify(comparableResult(scenario, avrts)) !== JSON.stringify(comparableResult(scenario, avr8js))) {
    differences.push(`result block differs:\navrts  ${JSON.stringify(avrts.result)}\navr8js ${JSON.stringify(avr8js.result)}`);
  }
  if (JSON.stringify(avrts.twi) !== JSON.stringify(avr8js.twi)) {
    differences.push(`I2C transcript differs:\navrts  ${stableJson(avrts.twi)}\navr8js ${stableJson(avr8js.twi)}`);
  }
  if (JSON.stringify(avrts.serial) !== JSON.stringify(avr8js.serial)) {
    differences.push(`serial output differs:\navrts  ${JSON.stringify(avrts.serial)}\navr8js ${JSON.stringify(avr8js.serial)}`);
  }
  if (JSON.stringify(avrts.registers) !== JSON.stringify(avr8js.registers)) {
    differences.push(`register summary differs:\navrts  ${stableJson(avrts.registers)}\navr8js ${stableJson(avr8js.registers)}`);
  }
  if (JSON.stringify(avrts.bitbang) !== JSON.stringify(avr8js.bitbang)) {
    differences.push(`bitbang trace differs:\navrts ${JSON.stringify(avrts.bitbang)}\navr8js ${JSON.stringify(avr8js.bitbang)}`);
  }
  return differences;
}

function compareScenario(scenario: ResultScenario, options: Partial<ResultOptions> = {}): CompareResult {
  const resolved: ResultOptions = {
    scenario,
    maxCycles: options.maxCycles ?? defaultResultBudget(scenario),
    analogRaw: options.analogRaw ?? DEFAULT_ANALOG_RAW,
    d2High: options.d2High ?? DEFAULT_D2_HIGH,
    bitbangInput: options.bitbangInput ?? 0x96,
    sensorStart: options.sensorStart ?? 0,
  };
  if (!Number.isInteger(resolved.bitbangInput) || resolved.bitbangInput < 0 || resolved.bitbangInput > 255) {
    throw new Error("bitbangInput expects a byte from 0..255.");
  }
  if (!Number.isInteger(resolved.sensorStart) || resolved.sensorStart < 0 || resolved.sensorStart > 65535) {
    throw new Error("sensorStart expects an integer from 0..65535.");
  }
  const avrts = runAvrts(resolved);
  const avr8js = runAvr8js(resolved);
  const differences = diffOutcomes(scenario, avrts, avr8js);
  for (const outcome of [avrts, avr8js]) {
    for (const error of validateResultExpectations(scenario, outcome, resolved.bitbangInput, resolved.sensorStart)) {
      differences.push(`${outcome.engine}: ${error}`);
    }
  }
  return { pass: differences.length === 0, avrts, avr8js, differences };
}

export function comparePeripheralMix(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("peripheral-mix", options);
}

export function compareIsrHeavy(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("isr-heavy", options);
}

export function compareStringHeavy(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("string-heavy", options);
}

export function compareDspFixed(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("dsp-fixed", options);
}

export function comparePeripheralBound(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("peripheral-bound", options);
}

export function compareFloatMath(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("float-math", options);
}

export function compareBitbangCrc(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("bitbang-crc", options);
}

export function compareSensorFormat(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("sensor-format", options);
}

export function compareSerialPrint(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("serial-print", options);
}
export function compareAnalogWrite(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("analog-write", options);
}
export function compareDelayBlink(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("delay-blink", options);
}
export function compareTightLoop(options: Partial<ResultOptions> = {}): CompareResult {
  return compareScenario("tight-loop", options);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    scenario: DEFAULT_CASE,
    maxCycles: undefined,
    analogRaw: DEFAULT_ANALOG_RAW,
    d2High: DEFAULT_D2_HIGH,
    bitbangInput: 0x96,
    sensorStart: 0,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cycles") {
      options.maxCycles = parsePositiveInt(args[++i], "--cycles");
    } else if (arg === "--analog") {
      options.analogRaw = parseAnalog(args[++i]);
    } else if (arg === "--d2") {
      options.d2High = parseBoolean(args[++i], "--d2");
    } else if (arg === "--bitbang-input") {
      options.bitbangInput = Number(args[++i]);
      if (!Number.isInteger(options.bitbangInput) || options.bitbangInput < 0 || options.bitbangInput > 255) {
        throw new Error("--bitbang-input expects a byte from 0..255.");
      }
    } else if (arg === "--sensor-start") {
      options.sensorStart = Number(args[++i]);
      if (!Number.isInteger(options.sensorStart) || options.sensorStart < 0 || options.sensorStart > 65535) {
        throw new Error("--sensor-start expects an integer from 0..65535.");
      }
    } else if (arg === "--case") {
      options.scenario = parseScenario(args[++i]);
    } else {
      throw new Error(`Unknown result benchmark argument "${arg}".`);
    }
  }
  return options;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer, got ${value}.`);
  }
  return parsed;
}

function parseAnalog(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--analog expects a value from 0..1023, got ${value}.`);
  }
  if (parsed > 1023) throw new Error(`--analog expects a value from 0..1023, got ${value}.`);
  return parsed;
}

function parseScenario(value: string | undefined): ResultCase {
  if (value === "all") return value;
  if (RESULT_SCENARIOS.includes(value as ResultScenario)) return value as ResultScenario;
  throw new Error(`--case expects all or ${RESULT_SCENARIOS.join(", ")}, got ${value}.`);
}

function parseBoolean(value: string | undefined, flag: string): boolean {
  if (value === "high" || value === "true" || value === "1") return true;
  if (value === "low" || value === "false" || value === "0") return false;
  throw new Error(`${flag} expects high/low, true/false, or 1/0, got ${value}.`);
}

function printOutcome(outcome: ScenarioOutcome): void {
  console.log(
    `${outcome.engine.padEnd(6)} completed=${String(outcome.completed).padEnd(5)} cycles=${outcome.cycles.toLocaleString()} result=${outcome.result
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")}`,
  );
  console.log(`       twi starts=${outcome.twi.starts.length} writes=${outcome.twi.writes.length} reads=${outcome.twi.reads.length} stops=${outcome.twi.stops}`);
  console.log(`       serial bytes=${outcome.serial.length}`);
  if (outcome.bitbang) console.log(`       bitbang rising=${outcome.bitbang.risingEdges} falling=${outcome.bitbang.fallingEdges} bytes=${outcome.bitbang.mosi.length}`);
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const scenarios = options.scenario === "all" ? RESULT_SCENARIOS : [options.scenario];
    const runOptions = {
      maxCycles: options.maxCycles,
      analogRaw: options.analogRaw,
      d2High: options.d2High,
      bitbangInput: options.bitbangInput,
      sensorStart: options.sensorStart,
    };
    let failed = false;
    for (const scenario of scenarios) {
      const result = compareScenario(scenario, runOptions);
      console.log(`avrts result benchmark: ${scenario} vs avr8js`);
      printOutcome(result.avrts);
      printOutcome(result.avr8js);
      if (!result.pass) {
        failed = true;
        console.error("\nFAILED");
        for (const difference of result.differences) console.error(`\n${difference}`);
      } else {
        console.log("\nPASS: result block, serial output, I2C transcript, and register summary match.");
      }
      if (scenarios.length > 1) console.log("");
    }
    if (failed) process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
