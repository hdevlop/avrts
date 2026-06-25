/**
 * Result/fidelity benchmark, not a speed benchmark.
 *
 * Runs a mixed-peripheral compiled Arduino sketch in avrts and avr8js with the
 * same host-provided ADC/GPIO/I2C environment. The pass condition is identical
 * observable result state, not cycles/second.
 */
import { AVR } from "../src";
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
} from "avr8js";

const CLOCK_HZ = 16_000_000;
const RESULT_ADDR = 0x0300;
const RESULT_LEN = 21;
const RESULT_START = 0xa7;
const RESULT_END = 0x5c;
const DEFAULT_MAX_CYCLES = 5_000_000;
const DEFAULT_ANALOG_RAW = 512;
const DEFAULT_D2_HIGH = true;

interface ResultOptions {
  maxCycles: number;
  analogRaw: number;
  d2High: boolean;
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
}

interface CompareResult {
  pass: boolean;
  avrts: ScenarioOutcome;
  avr8js: ScenarioOutcome;
  differences: string[];
}

function programFor(hex: string): Uint16Array {
  const progMem = new Uint16Array(FLASH_WORDS);
  loadHex(hex, progMem);
  return progMem;
}

function createTranscript(): TwiTranscript {
  return { starts: [], writes: [], reads: [], stops: 0 };
}

function nextTwiRead(transcript: TwiTranscript): number {
  const last = transcript.writes.at(-1) ?? 0;
  const prev = transcript.writes.at(-2) ?? 0;
  return (0xa5 ^ last ^ prev ^ ((transcript.writes.length * 17) & 0xff)) & 0xff;
}

function createAvrtsTwiSlave(transcript: TwiTranscript) {
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

class Avr8jsTwiSlave implements TWIEventHandler {
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

function readResult(data: Uint8Array): number[] {
  return [...data.slice(RESULT_ADDR, RESULT_ADDR + RESULT_LEN)];
}

function isComplete(data: Uint8Array): boolean {
  return data[RESULT_ADDR] === RESULT_START && data[RESULT_ADDR + 20] === RESULT_END;
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
  const avr = AVR({ hex: peripheralMixHex, timing: "cycle-exact" });
  const transcript = createTranscript();
  avr.analog(0).setValue(options.analogRaw);
  avr.pin(2).setInput(options.d2High);
  avr.twi.connect(0x50, createAvrtsTwiSlave(transcript));

  while (avr.cpu.cycles < options.maxCycles && !isComplete(avr.cpu.data)) {
    avr.runCycles(10_000);
  }

  return {
    engine: "avrts",
    completed: isComplete(avr.cpu.data),
    cycles: avr.cpu.cycles,
    result: readResult(avr.cpu.data),
    registers: readRegisters(avr.cpu.data),
    twi: transcript,
  };
}

function runAvr8js(options: ResultOptions): ScenarioOutcome {
  const cpu = new Avr8jsCPU(programFor(peripheralMixHex));
  const portB = new AVRIOPort(cpu, portBConfig);
  new AVRIOPort(cpu, portCConfig);
  const portD = new AVRIOPort(cpu, portDConfig);
  new AVRTimer(cpu, timer0Config);
  new AVRTimer(cpu, timer1Config);
  new AVRTimer(cpu, timer2Config);
  const adc = new AVRADC(cpu, adcConfig);
  const twi = new AVRTWI(cpu, twiConfig, CLOCK_HZ);
  const transcript = createTranscript();
  twi.eventHandler = new Avr8jsTwiSlave(twi, transcript);
  adc.channelValues[0] = (options.analogRaw / 1024) * 5;
  portD.setPin(2, options.d2High);

  while (cpu.cycles < options.maxCycles && !isComplete(cpu.data)) {
    avrInstruction(cpu);
    cpu.tick();
  }

  // Touch these so the harness keeps constructing the same visible GPIO surface
  // if a future cleanup tries to narrow the peripheral set too far.
  void portB;

  return {
    engine: "avr8js",
    completed: isComplete(cpu.data),
    cycles: cpu.cycles,
    result: readResult(cpu.data),
    registers: readRegisters(cpu.data),
    twi: transcript,
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort(), 2);
}

function diffOutcomes(avrts: ScenarioOutcome, avr8js: ScenarioOutcome): string[] {
  const differences: string[] = [];
  if (!avrts.completed) differences.push(`avrts did not write the result marker within ${avrts.cycles} cycles`);
  if (!avr8js.completed) differences.push(`avr8js did not write the result marker within ${avr8js.cycles} cycles`);
  if (JSON.stringify(avrts.result) !== JSON.stringify(avr8js.result)) {
    differences.push(`result block differs:\navrts  ${JSON.stringify(avrts.result)}\navr8js ${JSON.stringify(avr8js.result)}`);
  }
  if (JSON.stringify(avrts.twi) !== JSON.stringify(avr8js.twi)) {
    differences.push(`I2C transcript differs:\navrts  ${stableJson(avrts.twi)}\navr8js ${stableJson(avr8js.twi)}`);
  }
  if (JSON.stringify(avrts.registers) !== JSON.stringify(avr8js.registers)) {
    differences.push(`register summary differs:\navrts  ${stableJson(avrts.registers)}\navr8js ${stableJson(avr8js.registers)}`);
  }
  return differences;
}

export function comparePeripheralMix(options: Partial<ResultOptions> = {}): CompareResult {
  const resolved: ResultOptions = {
    maxCycles: options.maxCycles ?? DEFAULT_MAX_CYCLES,
    analogRaw: options.analogRaw ?? DEFAULT_ANALOG_RAW,
    d2High: options.d2High ?? DEFAULT_D2_HIGH,
  };
  const avrts = runAvrts(resolved);
  const avr8js = runAvr8js(resolved);
  const differences = diffOutcomes(avrts, avr8js);
  return { pass: differences.length === 0, avrts, avr8js, differences };
}

function parseArgs(args: string[]): ResultOptions {
  const options: ResultOptions = {
    maxCycles: DEFAULT_MAX_CYCLES,
    analogRaw: DEFAULT_ANALOG_RAW,
    d2High: DEFAULT_D2_HIGH,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cycles") {
      options.maxCycles = parsePositiveInt(args[++i], "--cycles");
    } else if (arg === "--analog") {
      options.analogRaw = parseAnalog(args[++i]);
    } else if (arg === "--d2") {
      options.d2High = parseBoolean(args[++i], "--d2");
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
}

if (import.meta.main) {
  try {
    const result = comparePeripheralMix(parseArgs(Bun.argv.slice(2)));
    console.log("avrts result benchmark: peripheral-mix vs avr8js");
    printOutcome(result.avrts);
    printOutcome(result.avr8js);
    if (!result.pass) {
      console.error("\nFAILED");
      for (const difference of result.differences) console.error(`\n${difference}`);
      process.exit(1);
    }
    console.log("\nPASS: result block, I2C transcript, and register summary match.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
