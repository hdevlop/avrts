/**
 * Opt-in native simavr state dump harness.
 *
 * This compiles scripts/simavr-state-dump.c on demand against a local simavr
 * install, then runs one firmware for a fixed cycle budget and prints JSON.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AVR, loadHex } from "../src";
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
  SPH_ADDR,
  SPL_ADDR,
  SREG_ADDR,
  TCCR0A,
  TCCR2A,
  TWCR,
  TWDR,
  TWINT,
  TWSR,
  UDRE0,
} from "../src/cpu";
import { compareDspFixed, compareIsrHeavy, comparePeripheralMix, compareStringHeavy } from "./benchmark-results";

interface Options {
  hex: string;
  mcu: string;
  freq: number;
  cycles: number;
  cyclesSet: boolean;
  dumps: string[];
  pokes: string[];
  adc0Raw?: number;
  d2High?: boolean;
  untilResult?: string;
  flushCycles: number;
  twiSlave?: number;
  uartRxScript: boolean;
  optibootScript: boolean;
  optiboot: boolean;
  spiMasterScript: boolean;
  acompScript: boolean;
  acompInjectCycle?: number;
  twiMasterScript?: number;
  twiMasterStartCycle?: number;
  resultCase?: ResultCase;
  timingCase?: TimingCase;
  analogRaw: number;
  compareAvrts: boolean;
  compareDumps: string[];
  sregMask: number;
  json: boolean;
}

interface SimavrState {
  mcu: string;
  frequency: number;
  targetCycles: number;
  cycles: number;
  completed: boolean;
  state: string;
  pcBytes: number;
  pcWords: number;
  sp: number;
  sreg: number;
  registers: number[];
  dumps: Record<string, number[]>;
  serial: number[];
  flash?: number[];
  optiboot?: OptibootScriptState;
  twi: TwiTranscript;
  twiMaster?: TwiMasterTranscript;
  spiMaster?: SpiMasterTranscript;
}

interface CompareState {
  cycles: number;
  pcBytes: number;
  pcWords: number;
  sp: number;
  sreg: number;
  registers: number[];
  dumps: Record<string, number[]>;
}

interface CompareResult {
  pass: boolean;
  differences: string[];
  simavr: SimavrState;
  avrts: CompareState;
}

const DEFAULT_HEX = "examples/timer0-overflow-blink/timer0-overflow-blink.hex";
const CLOCK_HZ = 16_000_000;
const RESULT_ADDR = 0x0300;
const RESULT_LEN = 21;
const RESULT_START = 0xa7;
const RESULT_END = 0x5c;
const RESULT_MODE_ADDR = 0x02ff;
const RESULT_HALT_MODE = 0x42;
const STRING_HEAVY_SERIAL_FLUSH_CYCLES = 500_000;
const DEFAULT_MAX_CYCLES = 5_000_000;
const DEFAULT_ANALOG_RAW = 512;
const DEFAULT_D2_HIGH = true;
const RESULT_SCENARIOS = ["peripheral-mix", "isr-heavy", "string-heavy", "dsp-fixed"] as const;
const TIMING_RESULT_ADDR = 0x0300;
const TIMING_RESULT_LEN = 40;
const TIMING_MAX_CYCLES = 1_000_000;
const TIMING_HEX_PATH = "examples/peripheral-timing-oracle/peripheral-timing-oracle.hex";
const TIMING_TWI_SLAVE_ADDR = 0x50;
const TIMING_UART_RX_MARKER_ADDR = TIMING_RESULT_ADDR + 39;
const TIMING_UART_RX_READY_ONE = 0x71;
const TIMING_UART_RX_READY_OVERFLOW = 0x72;
const TWI_SLAVE_HEX_PATH = "examples/arduino-wire-slave/arduino-wire-slave.ino.hex";
const TWI_SLAVE_RESULT_ADDR = 0x0300;
const TWI_SLAVE_RESULT_LEN = 16;
const TWI_SLAVE_ADDR = 0x42;
const TWI_SLAVE_MAX_CYCLES = 500_000;
const TWI_SLAVE_START_CYCLE = 100_000;
const SPI_SLAVE_HEX_PATH = "examples/spi-slave-oracle/spi-slave-oracle.hex";
const SPI_SLAVE_RESULT_ADDR = 0x0300;
const SPI_SLAVE_RESULT_LEN = 16;
const SPI_SLAVE_MAX_CYCLES = 100_000;
const SPI_SLAVE_READY_MARKER_ADDR = SPI_SLAVE_RESULT_ADDR + 14;
const SPI_SLAVE_READY = 0x51;
const SPI_SLAVE_INPUT_BYTE = 0x3c;
const TIMER2_ASYNC_HEX_PATH = "examples/timer2-async-oracle/timer2-async-oracle.hex";
const TIMER2_ASYNC_RESULT_ADDR = 0x0300;
const TIMER2_ASYNC_RESULT_LEN = 8;
const TIMER2_ASYNC_MAX_CYCLES = 3_000_000;
const COMPARATOR_HEX_PATH = "examples/comparator-oracle/comparator-oracle.hex";
const COMPARATOR_RESULT_ADDR = 0x0300;
const COMPARATOR_RESULT_LEN = 5;
const COMPARATOR_INJECT_CYCLE = 50_000;
const COMPARATOR_MAX_CYCLES = 200_000;
// AIN thresholds mirror the state-dump comparator script (millivolts -> volts).
const COMPARATOR_AIN1_VOLTS = 1.5;
const COMPARATOR_AIN0_LOW_VOLTS = 0.5;
const COMPARATOR_AIN0_HIGH_VOLTS = 3.0;
const OPTIBOOT_HEX_PATH = "examples/optiboot/optiboot_atmega328.hex";
const OPTIBOOT_APP_HEX_PATH = "examples/blink/blink.hex";
const OPTIBOOT_MAX_CYCLES = 5_000_000;
const OPTIBOOT_PAGE_BYTES = 128;
const OPTIBOOT_HIGH_FUSE = 0xde;
const STK_OK = 0x10;
const STK_INSYNC = 0x14;
const CRC_EOP = 0x20;
const STK_GET_SYNC = 0x30;
const STK_LEAVE_PROGMODE = 0x51;
const STK_LOAD_ADDRESS = 0x55;
const STK_PROG_PAGE = 0x64;
const STK_READ_PAGE = 0x74;

type ResultScenario = (typeof RESULT_SCENARIOS)[number];
type ResultCase = ResultScenario | "all";
type TimingCase = "all" | "twi-slave" | "spi-slave" | "timer2-async" | "comparator";

interface TwiTranscript {
  starts: string[];
  writes: number[];
  reads: number[];
  stops: number;
}

interface TwiMasterTranscript extends TwiTranscript {
  completed?: boolean;
  failed?: boolean;
}

interface SpiMasterTranscript {
  writes: number[];
  outputs: number[];
  completed?: boolean;
}

interface ScenarioOutcome {
  completed: boolean;
  cycles: number;
  result: number[];
  registers: Record<string, number>;
  twi: TwiTranscript;
  serial: number[];
}

interface TimingOutcome {
  completed: boolean;
  cycles: number;
  result: number[];
  twi: TwiTranscript;
  serial: number[];
}

interface TimingComparison {
  pass: boolean;
  differences: string[];
  normalizations: string[];
  simavr: TimingOutcome;
  avrts: TimingOutcome;
  raw: SimavrState;
}

interface TwiSlaveOutcome {
  completed: boolean;
  cycles: number;
  result: number[];
  twiMaster: TwiMasterTranscript;
}

interface SpiSlaveOutcome {
  completed: boolean;
  cycles: number;
  result: number[];
  spiMaster: SpiMasterTranscript;
}

interface Timer2AsyncOutcome {
  completed: boolean;
  cycles: number;
  result: number[];
}

interface ComparatorOutcome {
  completed: boolean;
  cycles: number;
  result: number[];
}

interface ComparatorComparison {
  pass: boolean;
  differences: string[];
  simavr: ComparatorOutcome;
  avrts: ComparatorOutcome;
  raw: SimavrState;
}

interface TwiSlaveComparison {
  pass: boolean;
  differences: string[];
  simavr: TwiSlaveOutcome;
  avrts: TwiSlaveOutcome;
  raw: SimavrState;
}

interface SpiSlaveComparison {
  pass: boolean;
  differences: string[];
  normalizations: string[];
  simavr: SpiSlaveOutcome;
  avrts: SpiSlaveOutcome;
  raw: SimavrState;
}

interface Timer2AsyncComparison {
  pass: boolean;
  differences: string[];
  simavr: Timer2AsyncOutcome;
  avrts: Timer2AsyncOutcome;
  raw: SimavrState;
}

interface OptibootScriptState {
  phase: number;
  sawPortBHigh: boolean;
  sawPortBLowAfterHigh: boolean;
}

interface OptibootOutcome {
  completed: boolean;
  cycles: number;
  flash: number[];
  serial: number[];
  optiboot?: OptibootScriptState;
}

interface OptibootComparison {
  pass: boolean;
  differences: string[];
  normalizations: string[];
  simavr: OptibootOutcome;
  avrts: OptibootOutcome;
  raw: SimavrState;
}

const RESULT_HEX_PATHS: Record<ResultScenario, string> = {
  "peripheral-mix": "examples/arduino-peripheral-mix/arduino-peripheral-mix.ino.hex",
  "isr-heavy": "examples/arduino-isr-heavy/arduino-isr-heavy.ino.hex",
  "string-heavy": "examples/arduino-string-heavy/arduino-string-heavy.ino.hex",
  "dsp-fixed": "examples/arduino-dsp-fixed/arduino-dsp-fixed.ino.hex",
};

const RESULT_AVRTS_COMPARE: Record<ResultScenario, (options: { maxCycles: number; analogRaw: number; d2High: boolean }) => { avrts: ScenarioOutcome }> = {
  "peripheral-mix": comparePeripheralMix,
  "isr-heavy": compareIsrHeavy,
  "string-heavy": compareStringHeavy,
  "dsp-fixed": compareDspFixed,
};

const PERIPHERAL_MIX_TIMER_THRESHOLD_RESULT_INDEX = 6;
const PERIPHERAL_MIX_PORTD_RESULT_INDEX = 12;

function parseArgs(args: string[]): Options {
  const options: Options = {
    hex: DEFAULT_HEX,
    mcu: "atmega328p",
    freq: 16_000_000,
    cycles: 1000,
    cyclesSet: false,
    dumps: ["regs:0:32", "io:32:96"],
    pokes: [],
    flushCycles: 0,
    uartRxScript: false,
    optibootScript: false,
    optiboot: false,
    spiMasterScript: false,
    acompScript: false,
    analogRaw: DEFAULT_ANALOG_RAW,
    compareAvrts: false,
    compareDumps: [],
    sregMask: 0x7f,
    json: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--hex") {
      options.hex = required(args[++i], "--hex");
    } else if (arg === "--mcu") {
      options.mcu = required(args[++i], "--mcu");
    } else if (arg === "--freq") {
      options.freq = parsePositiveInt(args[++i], "--freq");
    } else if (arg === "--cycles") {
      options.cycles = parsePositiveInt(args[++i], "--cycles");
      options.cyclesSet = true;
    } else if (arg === "--dump") {
      options.dumps.push(required(args[++i], "--dump"));
    } else if (arg === "--poke") {
      options.pokes.push(required(args[++i], "--poke"));
    } else if (arg === "--adc0-raw") {
      options.adc0Raw = parseAnalog(args[++i], "--adc0-raw");
    } else if (arg === "--analog") {
      options.analogRaw = parseAnalog(args[++i], "--analog");
    } else if (arg === "--d2") {
      options.d2High = parseBoolean(args[++i], "--d2");
    } else if (arg === "--until-result") {
      options.untilResult = required(args[++i], "--until-result");
    } else if (arg === "--flush-cycles") {
      options.flushCycles = parsePositiveInt(args[++i], "--flush-cycles");
    } else if (arg === "--twi-slave") {
      options.twiSlave = parseAddress(args[++i], "--twi-slave", 0x7f);
    } else if (arg === "--uart-rx-script") {
      options.uartRxScript = true;
    } else if (arg === "--optiboot-script") {
      options.optibootScript = true;
    } else if (arg === "--optiboot") {
      options.optiboot = true;
    } else if (arg === "--spi-master-script") {
      options.spiMasterScript = true;
    } else if (arg === "--twi-master-script") {
      options.twiMasterScript = parseAddress(args[++i], "--twi-master-script", 0x7f);
    } else if (arg === "--twi-master-start-cycle") {
      options.twiMasterStartCycle = parsePositiveInt(args[++i], "--twi-master-start-cycle");
    } else if (arg === "--result-case" || arg === "--case") {
      options.resultCase = parseResultCase(args[++i]);
    } else if (arg === "--timing-case") {
      options.timingCase = parseTimingCase(args[++i]);
    } else if (arg === "--compare-dump") {
      options.compareDumps.push(required(args[++i], "--compare-dump"));
    } else if (arg === "--compare-avrts") {
      options.compareAvrts = true;
    } else if (arg === "--sreg-mask") {
      options.sregMask = parseByteMask(args[++i], "--sreg-mask");
    } else if (arg === "--no-default-dumps") {
      options.dumps = [];
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown simavr oracle argument "${arg}".`);
    }
  }

  return options;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} expects a value.`);
  return value;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer, got ${value}.`);
  }
  return parsed;
}

function parseByteMask(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xff) {
    throw new Error(`${flag} expects an integer from 0..255, got ${value}.`);
  }
  return parsed;
}

function parseAnalog(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1023) {
    throw new Error(`${flag} expects an integer from 0..1023, got ${value}.`);
  }
  return parsed;
}

function parseAddress(value: string | undefined, flag: string, max: number): number {
  const text = required(value, flag);
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${flag} expects an integer from 0..${max}, got ${value}.`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, flag: string): boolean {
  if (value === "high" || value === "true" || value === "1") return true;
  if (value === "low" || value === "false" || value === "0") return false;
  throw new Error(`${flag} expects high/low, true/false, or 1/0, got ${value}.`);
}

function parseResultCase(value: string | undefined): ResultCase {
  if (value === "all") return value;
  if (value === "peripheral-mix" || value === "isr-heavy" || value === "string-heavy" || value === "dsp-fixed") return value;
  throw new Error(`--result-case expects all, peripheral-mix, isr-heavy, string-heavy, or dsp-fixed, got ${value}.`);
}

function parseTimingCase(value: string | undefined): TimingCase {
  if (value === "all") return value;
  if (value === "twi-slave") return value;
  if (value === "spi-slave") return value;
  if (value === "timer2-async") return value;
  if (value === "comparator") return value;
  throw new Error(`--timing-case expects all, twi-slave, spi-slave, timer2-async, or comparator, got ${value}.`);
}

function candidateSimavrPrefixes(): string[] {
  const user = basename(homedir());
  return [
    process.env.SIMAVR_PREFIX,
    join(homedir(), "msys64", "home", user, "tools", "simavr-installed"),
    join(homedir(), "msys64", "home", "hdevlop", "tools", "simavr-installed"),
  ].filter((value): value is string => Boolean(value));
}

function findSimavrPrefix(): string {
  for (const prefix of candidateSimavrPrefixes()) {
    if (existsSync(join(prefix, "include", "simavr", "sim_avr.h")) && existsSync(join(prefix, "lib", "libsimavr.a"))) {
      return prefix;
    }
  }
  throw new Error("Could not find simavr headers/libs. Set SIMAVR_PREFIX to the simavr install prefix.");
}

function findGcc(): string {
  const candidates = [
    process.env.SIMAVR_CC,
    join(homedir(), "msys64", "mingw64", "bin", "gcc.exe"),
    join(homedir(), "msys64", "mingw64", "bin", "cc.exe"),
    "gcc",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (candidate === "gcc" || existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find a C compiler. Set SIMAVR_CC to a gcc-compatible compiler.");
}

function findBash(): string | undefined {
  const candidate = join(homedir(), "msys64", "usr", "bin", "bash.exe");
  return existsSync(candidate) ? candidate : undefined;
}

function toMsysPath(path: string): string {
  const resolved = resolve(path);
  const drive = resolved[0]?.toLowerCase();
  if (process.platform !== "win32" || resolved[1] !== ":" || !drive) return resolved.replace(/\\/g, "/");
  return `/${drive}${resolved.slice(2).replace(/\\/g, "/")}`;
}

function needsBuild(output: string, source: string): boolean {
  if (!existsSync(output)) return true;
  return statSync(source).mtimeMs > statSync(output).mtimeMs;
}

function runTool(cmd: string, args: string[], label: string): string {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${label} failed (exit ${result.status})${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

function buildHelper(): string {
  const source = resolve("scripts", "simavr-state-dump.c");
  const out = resolve(".cache", "simavr-state-dump.exe");
  mkdirSync(dirname(out), { recursive: true });
  if (!needsBuild(out, source)) return out;

  const prefix = findSimavrPrefix();
  const bash = process.platform === "win32" ? findBash() : undefined;
  if (bash) {
    const compile = [
      "gcc",
      "-std=gnu99",
      "-O2",
      "-Wall",
      "-Wextra",
      "-I",
      quoteShell(toMsysPath(join(prefix, "include"))),
      quoteShell(toMsysPath(source)),
      "-L",
      quoteShell(toMsysPath(join(prefix, "lib"))),
      "-lsimavr",
      "-lelf",
      "-lm",
      "-lws2_32",
      "-o",
      quoteShell(toMsysPath(out)),
    ].join(" ");
    const command = ["set -e", "export PATH=/mingw64/bin:/usr/bin:$PATH", `cd ${quoteShell(toMsysPath(process.cwd()))}`, compile].join(" && ");
    runTool(bash, ["-lc", command], "simavr helper build");
  } else {
    const gcc = findGcc();
    runTool(
      gcc,
      [
        "-std=gnu99",
        "-O2",
        "-Wall",
        "-Wextra",
        "-I",
        join(prefix, "include"),
        source,
        "-L",
        join(prefix, "lib"),
        "-lsimavr",
        "-lelf",
        "-lm",
        "-lws2_32",
        "-o",
        out,
      ],
      "simavr helper build",
    );
  }
  return out;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runOracle(options: Options): SimavrState {
  const helper = buildHelper();
  const args = [
    "--hex",
    resolve(options.hex),
    "--mcu",
    options.mcu,
    "--freq",
    String(options.freq),
    "--cycles",
    String(options.cycles),
  ];
  for (const dump of options.dumps) args.push("--dump", dump);
  for (const poke of options.pokes) args.push("--poke", poke);
  if (options.adc0Raw !== undefined) args.push("--adc0-raw", String(options.adc0Raw));
  if (options.d2High !== undefined) args.push("--d2", options.d2High ? "high" : "low");
  if (options.untilResult) args.push("--until-result", options.untilResult);
  if (options.flushCycles) args.push("--flush-cycles", String(options.flushCycles));
  if (options.twiSlave !== undefined) args.push("--twi-slave", String(options.twiSlave));
  if (options.uartRxScript) args.push("--uart-rx-script");
  if (options.optibootScript) args.push("--optiboot-script");
  if (options.spiMasterScript) args.push("--spi-master-script");
  if (options.acompScript) {
    args.push("--acomp-script");
    if (options.acompInjectCycle !== undefined) args.push("--acomp-inject-cycle", String(options.acompInjectCycle));
  }
  if (options.twiMasterScript !== undefined) args.push("--twi-master-script", String(options.twiMasterScript));
  if (options.twiMasterStartCycle !== undefined) args.push("--twi-master-start-cycle", String(options.twiMasterStartCycle));
  const stdout = runTool(helper, args, "simavr helper");
  return JSON.parse(stdout) as SimavrState;
}

function runAvrts(options: Options, simavr: SimavrState): CompareState {
  const hex = readFileSync(options.hex, "utf8");
  const avr = AVR({ hex, timing: "cycle-exact" });
  avr.runCycles(options.cycles);
  const data = avr.cpu.data;
  const dumps: Record<string, number[]> = {};
  for (const [name, bytes] of Object.entries(simavr.dumps)) {
    const spec = findDumpSpec(options.dumps, name);
    if (!spec) continue;
    dumps[name] = [...data.slice(spec.addr, spec.addr + bytes.length)];
  }
  return {
    cycles: avr.cpu.cycles,
    pcWords: avr.cpu.pc,
    pcBytes: avr.cpu.pc * 2,
    sp: data[SPL_ADDR]! | (data[SPH_ADDR]! << 8),
    sreg: data[SREG_ADDR]!,
    registers: [...data.slice(0, 32)],
    dumps,
  };
}

function findDumpSpec(dumps: string[], name: string): { addr: number; length: number } | undefined {
  for (const dump of dumps) {
    const [label, addr, length] = dump.split(":");
    if (label === name && addr !== undefined && length !== undefined) {
      return { addr: Number(addr), length: Number(length) };
    }
  }
  return undefined;
}

function compareWithAvrts(simavr: SimavrState, options: Options): CompareResult {
  const avrts = runAvrts(options, simavr);
  const differences: string[] = [];
  compareNumber(differences, "cycles", simavr.cycles, avrts.cycles);
  compareNumber(differences, "pcWords", simavr.pcWords, avrts.pcWords);
  compareNumber(differences, "pcBytes", simavr.pcBytes, avrts.pcBytes);
  compareNumber(differences, "sp", simavr.sp, avrts.sp);
  compareNumber(differences, `sreg&0x${options.sregMask.toString(16).padStart(2, "0")}`, simavr.sreg & options.sregMask, avrts.sreg & options.sregMask);
  compareArray(differences, "registers", simavr.registers, avrts.registers);
  for (const name of options.compareDumps) {
    compareArray(differences, `dump:${name}`, simavr.dumps[name] ?? [], avrts.dumps[name] ?? []);
  }
  return { pass: differences.length === 0, differences, simavr, avrts };
}

function compareNumber(differences: string[], label: string, simavr: number, avrts: number): void {
  if (simavr !== avrts) differences.push(`${label}: simavr=${simavr} avrts=${avrts}`);
}

function compareArray(differences: string[], label: string, simavr: number[], avrts: number[]): void {
  if (simavr.length !== avrts.length) {
    differences.push(`${label}: length simavr=${simavr.length} avrts=${avrts.length}`);
    return;
  }
  for (let i = 0; i < simavr.length; i += 1) {
    if (simavr[i] !== avrts[i]) {
      differences.push(`${label}[${i}]: simavr=${simavr[i]} avrts=${avrts[i]}`);
      if (differences.length >= 20) {
        differences.push("stopped after 20 differences");
        return;
      }
    }
  }
}

function optionsForResultScenario(base: Options, scenario: ResultScenario): Options {
  return {
    ...base,
    hex: RESULT_HEX_PATHS[scenario],
    freq: CLOCK_HZ,
    cycles: base.cyclesSet ? base.cycles : DEFAULT_MAX_CYCLES,
    dumps: ["result:0x300:21", "data:0:1024"],
    pokes: [`0x${RESULT_MODE_ADDR.toString(16)}:0x${RESULT_HALT_MODE.toString(16)}`],
    adc0Raw: base.analogRaw,
    d2High: base.d2High ?? DEFAULT_D2_HIGH,
    untilResult: `0x${RESULT_ADDR.toString(16)}:${RESULT_LEN}:0x${RESULT_START.toString(16)}:0x${RESULT_END.toString(16)}`,
    flushCycles: scenario === "string-heavy" ? STRING_HEAVY_SERIAL_FLUSH_CYCLES : 0,
    twiSlave: scenario === "peripheral-mix" ? 0x50 : undefined,
    compareAvrts: false,
    compareDumps: [],
  };
}

function simavrOutcome(simavr: SimavrState): ScenarioOutcome {
  const data = simavr.dumps.data ?? [];
  return {
    completed: simavr.completed,
    cycles: simavr.cycles,
    result: simavr.dumps.result ?? [],
    registers: readRegisters(data),
    twi: simavr.twi,
    serial: simavr.serial,
  };
}

function readRegisters(data: number[]): Record<string, number> {
  return {
    portB: data[PORTB] ?? 0,
    portC: data[PORTC] ?? 0,
    portD: data[PORTD] ?? 0,
    ddrD: data[DDRD] ?? 0,
    pinD2: (data[PIND] ?? 0) & (1 << 2),
    ocr0b: data[OCR0B] ?? 0,
    ocr2b: data[OCR2B] ?? 0,
    tccr0a: data[TCCR0A] ?? 0,
    tccr2a: data[TCCR2A] ?? 0,
    twsr: (data[TWSR] ?? 0) & 0xf8,
    twdr: data[TWDR] ?? 0,
    adcl: data[ADCL] ?? 0,
    adch: data[ADCH] ?? 0,
  };
}

function compareResultScenario(
  scenario: ResultScenario,
  base: Options,
): { pass: boolean; differences: string[]; normalizations: string[]; simavr: ScenarioOutcome; avrts: ScenarioOutcome; raw: SimavrState } {
  const options = optionsForResultScenario(base, scenario);
  const raw = runOracle(options);
  const simavr = simavrOutcome(raw);
  const avrts = RESULT_AVRTS_COMPARE[scenario]({
    maxCycles: options.cycles,
    analogRaw: options.adc0Raw ?? DEFAULT_ANALOG_RAW,
    d2High: options.d2High ?? DEFAULT_D2_HIGH,
  }).avrts;
  const differences: string[] = [];
  const normalizations: string[] = [];

  if (!simavr.completed) differences.push(`simavr did not write the result marker within ${simavr.cycles} cycles`);
  if (!avrts.completed) differences.push(`avrts did not write the result marker within ${avrts.cycles} cycles`);
  compareArray(differences, "result", comparableResult(scenario, simavr, normalizations), comparableResult(scenario, avrts, normalizations));
  compareArray(differences, "serial", simavr.serial, avrts.serial);
  if (JSON.stringify(simavr.twi) !== JSON.stringify(avrts.twi)) {
    differences.push(`twi: simavr=${stableJson(simavr.twi)} avrts=${stableJson(avrts.twi)}`);
  }
  const simavrRegisters = comparableRegisters(scenario, simavr, normalizations);
  const avrtsRegisters = comparableRegisters(scenario, avrts, normalizations);
  if (JSON.stringify(simavrRegisters) !== JSON.stringify(avrtsRegisters)) {
    differences.push(`registers: simavr=${stableJson(simavrRegisters)} avrts=${stableJson(avrtsRegisters)}`);
  }

  return { pass: differences.length === 0, differences, normalizations: [...new Set(normalizations)], simavr, avrts, raw };
}

function optionsForTimingScenario(base: Options): Options {
  return {
    ...base,
    hex: TIMING_HEX_PATH,
    freq: CLOCK_HZ,
    cycles: base.cyclesSet ? base.cycles : TIMING_MAX_CYCLES,
    dumps: [`result:0x${TIMING_RESULT_ADDR.toString(16)}:${TIMING_RESULT_LEN}`],
    pokes: [],
    untilResult: `0x${TIMING_RESULT_ADDR.toString(16)}:${TIMING_RESULT_LEN}:0xa7:0x5c`,
    flushCycles: 0,
    twiSlave: TIMING_TWI_SLAVE_ADDR,
    uartRxScript: true,
    compareAvrts: false,
    compareDumps: [],
  };
}

function timingComplete(data: Uint8Array): boolean {
  return data[TIMING_RESULT_ADDR] === 0xa7 && data[TIMING_RESULT_ADDR + TIMING_RESULT_LEN - 1] === 0x5c;
}

function nextTimingTwiRead(transcript: TwiTranscript): number {
  const last = transcript.writes.at(-1) ?? 0;
  const prev = transcript.writes.at(-2) ?? 0;
  return (0xa5 ^ last ^ prev ^ ((transcript.writes.length * 17) & 0xff)) & 0xff;
}

function createTimingTwiSlave(transcript: TwiTranscript) {
  return {
    start(address: number, read: boolean): boolean {
      transcript.starts.push(`${read ? "R" : "W"}@${address.toString(16).padStart(2, "0")}`);
      return address === TIMING_TWI_SLAVE_ADDR;
    },
    write(byte: number): boolean {
      transcript.writes.push(byte & 0xff);
      return true;
    },
    read(): number {
      const value = nextTimingTwiRead(transcript);
      transcript.reads.push(value);
      return value;
    },
    stop(): void {
      transcript.stops += 1;
    },
  };
}

function runAvrtsTiming(options: Options): TimingOutcome {
  const hex = readFileSync(options.hex, "utf8");
  const avr = AVR({ hex, timing: "cycle-exact" });
  const twi = { starts: [], writes: [], reads: [], stops: 0 } satisfies TwiTranscript;
  const serial: number[] = [];
  avr.twi.connect(TIMING_TWI_SLAVE_ADDR, createTimingTwiSlave(twi));
  avr.serial.onByte((byte) => serial.push(byte & 0xff));
  avr.watchData(TIMING_UART_RX_MARKER_ADDR, ({ value }) => {
    if (value === TIMING_UART_RX_READY_ONE) {
      avr.serial.write(Uint8Array.of(0x31));
    } else if (value === TIMING_UART_RX_READY_OVERFLOW) {
      avr.serial.write(Uint8Array.of(0x41, 0x42, 0x43));
    }
  });

  while (avr.cpu.cycles < options.cycles && !timingComplete(avr.cpu.data)) {
    avr.runCycles(1_000);
  }

  return {
    completed: timingComplete(avr.cpu.data),
    cycles: avr.cpu.cycles,
    result: [...avr.cpu.data.slice(TIMING_RESULT_ADDR, TIMING_RESULT_ADDR + TIMING_RESULT_LEN)],
    twi,
    serial,
  };
}

function timingOutcome(simavr: SimavrState): TimingOutcome {
  return {
    completed: simavr.completed,
    cycles: simavr.cycles,
    result: simavr.dumps.result ?? [],
    twi: simavr.twi,
    serial: simavr.serial,
  };
}

function comparableTimingResult(outcome: TimingOutcome, normalizations: string[]): number[] {
  const result = [...outcome.result];
  if (result.length >= TIMING_RESULT_LEN) {
    // Not timing signals for this oracle:
    // - native simavr echoes MOSI into SPDR and clears SPIF after the fixture's
    //   SPSR-then-SPDR read sequence; avrts uses the configured responder byte.
    // - native simavr reports the first SLA+W ACK on its virtual-slave IRQ path
    //   much sooner than later byte operations. START/STOP and data byte timing
    //   are the calibration targets here.
    result[5] = 0;
    result[6] = 0;
    result[10] = 0;
    result[11] = 0;
    // The native helper and avrts inject the RX bytes after the firmware writes
    // a ready marker; the marker-to-injection handoff differs by a few cycles.
    result[29] = 0;
    result[30] = 0;
    // simavr does not report UDRE0 in the RX status snapshot the same way as
    // avrts after the TX poll; RXC0/data are the signals under comparison here.
    result[32] = result[32]! & ~(1 << UDRE0);
    // Native simavr's UART input IRQ uses a 64-byte host FIFO and does not
    // reproduce the ATmega328P two-byte receive-buffer DOR condition. The
    // fixture still records avrts DOR behavior; native comparison starts at the
    // received bytes.
    result[33] = 0;
    result[34] = 0;
    result[35] = 0;
    result[38] = 0;
    normalizations.push("SPI received/status bytes normalized; this oracle compares SPI SPIF polling delay.");
    normalizations.push("First TWI SLA+W elapsed bytes normalized; START/STOP and byte read/write delays remain compared.");
    normalizations.push("USART RXC elapsed and UDRE status bit normalized; RXC status and received data remain compared.");
    normalizations.push("USART DOR status normalized because native simavr's UART input IRQ has a 64-byte host FIFO; avrts DOR behavior remains covered by Bun tests.");
  }
  return result;
}

function compareTimingScenario(base: Options): TimingComparison {
  const options = optionsForTimingScenario(base);
  const raw = runOracle(options);
  const simavr = timingOutcome(raw);
  const avrts = runAvrtsTiming(options);
  const differences: string[] = [];
  const normalizations: string[] = [];

  if (!simavr.completed) differences.push(`simavr did not write the timing result marker within ${simavr.cycles} cycles`);
  if (!avrts.completed) differences.push(`avrts did not write the timing result marker within ${avrts.cycles} cycles`);
  compareArray(differences, "timing-result", comparableTimingResult(simavr, normalizations), comparableTimingResult(avrts, normalizations));
  compareArray(differences, "serial", simavr.serial, avrts.serial);
  if (JSON.stringify(simavr.twi) !== JSON.stringify(avrts.twi)) {
    differences.push(`twi: simavr=${stableJson(simavr.twi)} avrts=${stableJson(avrts.twi)}`);
  }

  return { pass: differences.length === 0, differences, normalizations: [...new Set(normalizations)], simavr, avrts, raw };
}

function optionsForTwiSlaveScenario(base: Options): Options {
  return {
    ...base,
    hex: TWI_SLAVE_HEX_PATH,
    freq: CLOCK_HZ,
    cycles: base.cyclesSet ? base.cycles : TWI_SLAVE_MAX_CYCLES,
    dumps: [`result:0x${TWI_SLAVE_RESULT_ADDR.toString(16)}:${TWI_SLAVE_RESULT_LEN}`],
    pokes: [],
    untilResult: undefined,
    flushCycles: 0,
    twiSlave: undefined,
    twiMasterScript: TWI_SLAVE_ADDR,
    twiMasterStartCycle: TWI_SLAVE_START_CYCLE,
    compareAvrts: false,
    compareDumps: [],
  };
}

function optionsForSpiSlaveScenario(base: Options): Options {
  return {
    ...base,
    hex: SPI_SLAVE_HEX_PATH,
    freq: CLOCK_HZ,
    cycles: base.cyclesSet ? base.cycles : SPI_SLAVE_MAX_CYCLES,
    dumps: [`result:0x${SPI_SLAVE_RESULT_ADDR.toString(16)}:${SPI_SLAVE_RESULT_LEN}`],
    pokes: [],
    untilResult: `0x${SPI_SLAVE_RESULT_ADDR.toString(16)}:${SPI_SLAVE_RESULT_LEN}:0xa7:0x5c`,
    flushCycles: 0,
    twiSlave: undefined,
    uartRxScript: false,
    spiMasterScript: true,
    twiMasterScript: undefined,
    compareAvrts: false,
    compareDumps: [],
  };
}

function optionsForTimer2AsyncScenario(base: Options): Options {
  return {
    ...base,
    hex: TIMER2_ASYNC_HEX_PATH,
    freq: CLOCK_HZ,
    cycles: base.cyclesSet ? base.cycles : TIMER2_ASYNC_MAX_CYCLES,
    dumps: [`result:0x${TIMER2_ASYNC_RESULT_ADDR.toString(16)}:${TIMER2_ASYNC_RESULT_LEN}`],
    pokes: [],
    untilResult: `0x${TIMER2_ASYNC_RESULT_ADDR.toString(16)}:${TIMER2_ASYNC_RESULT_LEN}:0xa7:0x5c`,
    flushCycles: 0,
    twiSlave: undefined,
    uartRxScript: false,
    spiMasterScript: false,
    twiMasterScript: undefined,
    compareAvrts: false,
    compareDumps: [],
  };
}

function optionsForComparatorScenario(base: Options): Options {
  return {
    ...base,
    hex: COMPARATOR_HEX_PATH,
    freq: CLOCK_HZ,
    cycles: base.cyclesSet ? base.cycles : COMPARATOR_MAX_CYCLES,
    dumps: [`result:0x${COMPARATOR_RESULT_ADDR.toString(16)}:${COMPARATOR_RESULT_LEN}`],
    pokes: [],
    untilResult: `0x${COMPARATOR_RESULT_ADDR.toString(16)}:${COMPARATOR_RESULT_LEN}:0xa7:0x5c`,
    // The sticky end marker completes mid-loop-iteration (right after the ISR
    // runs but before edges/ACO are re-published); flush one more full loop so
    // the result block settles to its stable post-edge values before the dump.
    flushCycles: 2_000,
    twiSlave: undefined,
    uartRxScript: false,
    spiMasterScript: false,
    acompScript: true,
    acompInjectCycle: COMPARATOR_INJECT_CYCLE,
    twiMasterScript: undefined,
    compareAvrts: false,
    compareDumps: [],
  };
}

function optionsForOptibootScenario(base: Options): Options {
  return {
    ...base,
    hex: OPTIBOOT_HEX_PATH,
    freq: CLOCK_HZ,
    cycles: base.cyclesSet ? base.cycles : OPTIBOOT_MAX_CYCLES,
    dumps: [],
    pokes: [],
    untilResult: undefined,
    flushCycles: 0,
    twiSlave: undefined,
    uartRxScript: false,
    optibootScript: true,
    spiMasterScript: false,
    twiMasterScript: undefined,
    compareAvrts: false,
    compareDumps: [],
  };
}

interface HexImage {
  bytes: Uint8Array;
  maxByteAddress: number;
}

class Stk500Client {
  private readonly rx: number[] = [];
  private cursor = 0;

  constructor(private readonly avr: ReturnType<typeof AVR>) {
    avr.serial.onByte((byte) => this.rx.push(byte & 0xff));
  }

  command(bytes: number[], responseLength = 2): number[] {
    this.avr.serial.write(Uint8Array.from([...bytes, CRC_EOP]));
    return this.read(responseLength);
  }

  sync(): void {
    expectResponse(this.command([STK_GET_SYNC]), [STK_INSYNC, STK_OK], "GET_SYNC");
  }

  loadAddress(byteAddress: number): void {
    const wordAddress = byteAddress >> 1;
    expectResponse(
      this.command([STK_LOAD_ADDRESS, wordAddress & 0xff, (wordAddress >> 8) & 0xff]),
      [STK_INSYNC, STK_OK],
      "LOAD_ADDRESS",
    );
  }

  programPage(bytes: Uint8Array): void {
    if (bytes.length !== OPTIBOOT_PAGE_BYTES) throw new Error(`programPage expected ${OPTIBOOT_PAGE_BYTES} bytes.`);
    expectResponse(
      this.command([STK_PROG_PAGE, (bytes.length >> 8) & 0xff, bytes.length & 0xff, 0x46, ...bytes]),
      [STK_INSYNC, STK_OK],
      "PROG_PAGE",
    );
  }

  readPage(length: number): number[] {
    const response = this.command([STK_READ_PAGE, (length >> 8) & 0xff, length & 0xff, 0x46], length + 2);
    if (response[0] !== STK_INSYNC || response.at(-1) !== STK_OK) {
      throw new Error(`READ_PAGE returned ${formatBytes(response)}.`);
    }
    return response.slice(1, -1);
  }

  leaveProgrammingMode(): void {
    expectResponse(this.command([STK_LEAVE_PROGMODE]), [STK_INSYNC, STK_OK], "LEAVE_PROGMODE");
  }

  serial(): number[] {
    return [...this.rx];
  }

  private read(length: number): number[] {
    const startCycle = this.avr.cpu.cycles;
    while (this.rx.length - this.cursor < length && this.avr.cpu.cycles - startCycle < 8_000_000) {
      this.avr.runCycles(500);
    }
    const available = this.rx.length - this.cursor;
    if (available < length) {
      throw new Error(`Timed out waiting for ${length} STK500 byte(s); got ${available}: ${formatBytes(this.rx.slice(this.cursor))}`);
    }
    const out = this.rx.slice(this.cursor, this.cursor + length);
    this.cursor += length;
    return out;
  }
}

function expectResponse(actual: number[], expected: number[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} returned ${formatBytes(actual)}, expected ${formatBytes(expected)}.`);
  }
}

function imageFromHex(hex: string): HexImage {
  const flash = new Uint16Array(FLASH_WORDS);
  flash.fill(0xffff);
  const result = loadHex(hex, flash);
  const bytes = new Uint8Array(result.maxByteAddress + 1);
  bytes.fill(0xff);
  for (let address = 0; address <= result.maxByteAddress; address += 1) {
    const word = flash[address >> 1]!;
    bytes[address] = (address & 1) === 0 ? word & 0xff : word >> 8;
  }
  return { bytes, maxByteAddress: result.maxByteAddress };
}

function optibootPage(image: HexImage, pageBase: number): Uint8Array {
  const out = new Uint8Array(OPTIBOOT_PAGE_BYTES);
  out.fill(0xff);
  out.set(image.bytes.subarray(pageBase, Math.min(pageBase + OPTIBOOT_PAGE_BYTES, image.bytes.length)));
  return out;
}

function createOptibootRuntime(): ReturnType<typeof AVR> {
  const optiboot = readFileSync(OPTIBOOT_HEX_PATH, "utf8");
  const avr = AVR().useClock(CLOCK_HZ).useFuses({ high: OPTIBOOT_HIGH_FUSE });
  avr.cpu.flash.fill(0xffff);
  loadHex(optiboot, avr.cpu.flash);
  avr.resetExternal();
  return avr;
}

function runAvrtsOptiboot(): OptibootOutcome {
  const app = imageFromHex(readFileSync(OPTIBOOT_APP_HEX_PATH, "utf8"));
  const avr = createOptibootRuntime();
  const stk = new Stk500Client(avr);
  let sawPortBHigh = false;
  let sawPortBLowAfterHigh = false;

  stk.sync();
  for (let pageBase = 0; pageBase <= app.maxByteAddress; pageBase += OPTIBOOT_PAGE_BYTES) {
    const bytes = optibootPage(app, pageBase);
    stk.loadAddress(pageBase);
    stk.programPage(bytes);
    stk.loadAddress(pageBase);
    const readback = stk.readPage(OPTIBOOT_PAGE_BYTES);
    expectResponse(readback, [...bytes], `READ_PAGE data @${pageBase}`);
  }

  avr.watchData(PORTB, (event) => {
    if (event.value === 0x20) sawPortBHigh = true;
    if (sawPortBHigh && event.value === 0x00) sawPortBLowAfterHigh = true;
  });
  stk.leaveProgrammingMode();
  const start = avr.cpu.cycles;
  while (!sawPortBLowAfterHigh && avr.cpu.cycles - start < OPTIBOOT_MAX_CYCLES) {
    avr.runCycles(500);
  }

  return {
    completed: sawPortBLowAfterHigh,
    cycles: avr.cpu.cycles,
    flash: flashBytes(avr.cpu.flash, OPTIBOOT_PAGE_BYTES),
    serial: stk.serial(),
    optiboot: { phase: 7, sawPortBHigh, sawPortBLowAfterHigh },
  };
}

function flashBytes(flash: Uint16Array, length: number): number[] {
  const out: number[] = [];
  for (let address = 0; address < length; address += 1) {
    const word = flash[address >> 1]!;
    out.push((address & 1) === 0 ? word & 0xff : (word >> 8) & 0xff);
  }
  return out;
}

function optibootOutcome(raw: SimavrState): OptibootOutcome {
  return {
    completed: raw.completed && raw.optiboot?.sawPortBLowAfterHigh === true,
    cycles: raw.cycles,
    flash: raw.flash ?? [],
    serial: raw.serial,
    optiboot: raw.optiboot,
  };
}

function compareOptibootScenario(base: Options): OptibootComparison {
  const options = optionsForOptibootScenario(base);
  const raw = runOracle(options);
  const simavr = optibootOutcome(raw);
  const avrts = runAvrtsOptiboot();
  const differences: string[] = [];
  const normalizations = ["Optiboot cycle counts are treated as an envelope: both engines must complete under the configured max cycles."];

  if (!simavr.completed) differences.push(`simavr did not complete the Optiboot STK500 session within ${simavr.cycles} cycles`);
  if (!avrts.completed) differences.push(`avrts did not complete the Optiboot STK500 session within ${avrts.cycles} cycles`);
  compareArray(differences, "optiboot-flash-page0", simavr.flash, avrts.flash);
  compareArray(differences, "optiboot-serial", simavr.serial, avrts.serial);

  return { pass: differences.length === 0, differences, normalizations, simavr, avrts, raw };
}

function twiSlaveResultComplete(result: number[], twiMaster: TwiMasterTranscript): boolean {
  const rxXor = 0x11 ^ 0x22 ^ 0x33;
  const expectedTx = 0x90 ^ rxXor ^ 1;
  return (
    result[0] === 0xa7 &&
    result[1] === 1 &&
    result[2] === 1 &&
    result[3] === 3 &&
    result[4] === rxXor &&
    result[5] === 0x33 &&
    result[6] === expectedTx &&
    result[7] === 0x5c &&
    result[8] === 3 &&
    twiMaster.reads[0] === expectedTx
  );
}

function spiSlaveResultComplete(result: number[]): boolean {
  return (
    result[0] === 0xa7 &&
    result[3] === SPI_SLAVE_INPUT_BYTE &&
    (result[4]! & 0x80) !== 0 &&
    (result[5]! & 0x80) === 0 &&
    result[6] === 0x40 &&
    result[7] === SPI_SLAVE_INPUT_BYTE &&
    result[14] === SPI_SLAVE_READY &&
    result[15] === 0x5c
  );
}

function timer2AsyncResultComplete(result: number[]): boolean {
  // Completion is independent of acceptance; compare the entire result below.
  return result.length === TIMER2_ASYNC_RESULT_LEN && result[0] === 0xa7 && result[7] === 0x5c;
}

function comparatorResultComplete(result: number[]): boolean {
  return (
    result[0] === 0xa7 &&
    result[1] === 1 && // one rising edge counted.
    result[2] === 1 && // ACO live high after the crossing.
    result[3] === 1 && // ACO sampled high inside the ISR.
    result[4] === 0x5c
  );
}

function runAvrtsComparator(options: Options): ComparatorOutcome {
  const hex = readFileSync(options.hex, "utf8");
  const avr = AVR({ hex, timing: "cycle-exact" });
  const injectCycle = options.acompInjectCycle ?? COMPARATOR_INJECT_CYCLE;

  // Park the inputs so ACO starts low (AIN0 < AIN1), mirroring the state-dump
  // comparator script's millivolt thresholds.
  avr.comparator.setInput("ain1", COMPARATOR_AIN1_VOLTS);
  avr.comparator.setInput("ain0", COMPARATOR_AIN0_LOW_VOLTS);

  avr.runCycles(injectCycle);
  // Drive AIN0 above AIN1: one rising comparator-output edge.
  avr.comparator.setInput("ain0", COMPARATOR_AIN0_HIGH_VOLTS);

  while (avr.cpu.cycles < options.cycles) {
    const result = [...avr.cpu.data.slice(COMPARATOR_RESULT_ADDR, COMPARATOR_RESULT_ADDR + COMPARATOR_RESULT_LEN)];
    if (comparatorResultComplete(result)) break;
    avr.runCycles(500);
  }

  const result = [...avr.cpu.data.slice(COMPARATOR_RESULT_ADDR, COMPARATOR_RESULT_ADDR + COMPARATOR_RESULT_LEN)];
  return {
    completed: comparatorResultComplete(result),
    cycles: avr.cpu.cycles,
    result,
  };
}

function comparatorOutcome(simavr: SimavrState): ComparatorOutcome {
  const result = simavr.dumps.result ?? [];
  return {
    completed: simavr.completed && comparatorResultComplete(result),
    cycles: simavr.cycles,
    result,
  };
}

function compareComparatorScenario(base: Options): ComparatorComparison {
  const options = optionsForComparatorScenario(base);
  const raw = runOracle(options);
  const simavr = comparatorOutcome(raw);
  const avrts = runAvrtsComparator(options);
  const differences: string[] = [];

  if (!simavr.completed) differences.push(`simavr did not complete the comparator fixture within ${simavr.cycles} cycles`);
  if (!avrts.completed) differences.push(`avrts did not complete the comparator fixture within ${avrts.cycles} cycles`);
  compareArray(differences, "comparator-result", simavr.result, avrts.result);

  return { pass: differences.length === 0, differences, simavr, avrts, raw };
}

function runUntilTwintClears(avr: ReturnType<typeof AVR>, maxCycles = 50_000): void {
  for (let elapsed = 0; elapsed < maxCycles; elapsed += 50) {
    if (((avr.cpu.readData(TWCR) >> TWINT) & 1) === 0) return;
    avr.runCycles(50);
  }
  throw new Error("firmware did not clear TWI TWINT in time");
}

function completeHostTwiEvent(avr: ReturnType<typeof AVR>, cycles = 2_000): void {
  avr.runCycles(cycles);
  runUntilTwintClears(avr);
  avr.runCycles(1_000);
}

function runAvrtsTimer2Async(options: Options): Timer2AsyncOutcome {
  const hex = readFileSync(options.hex, "utf8");
  const avr = AVR({ hex, timing: "cycle-exact" });

  while (avr.cpu.cycles < options.cycles) {
    const result = [...avr.cpu.data.slice(TIMER2_ASYNC_RESULT_ADDR, TIMER2_ASYNC_RESULT_ADDR + TIMER2_ASYNC_RESULT_LEN)];
    if (timer2AsyncResultComplete(result)) break;
    avr.runCycles(1_000);
  }

  const result = [...avr.cpu.data.slice(TIMER2_ASYNC_RESULT_ADDR, TIMER2_ASYNC_RESULT_ADDR + TIMER2_ASYNC_RESULT_LEN)];
  return {
    completed: timer2AsyncResultComplete(result),
    cycles: avr.cpu.cycles,
    result,
  };
}

function runAvrtsTwiSlave(options: Options): TwiSlaveOutcome {
  const hex = readFileSync(options.hex, "utf8");
  const avr = AVR({ hex, timing: "cycle-exact" });
  const master = avr.twi.master();
  const twiMaster: TwiMasterTranscript = { starts: [], writes: [], reads: [], stops: 0, completed: false, failed: false };

  avr.runCycles(TWI_SLAVE_START_CYCLE);

  if (!master.start(TWI_SLAVE_ADDR, false)) throw new Error("avrts TWI slave did not ACK SLA+W.");
  twiMaster.starts.push(`W@${TWI_SLAVE_ADDR.toString(16).padStart(2, "0")}`);
  completeHostTwiEvent(avr);
  for (const byte of [0x11, 0x22, 0x33]) {
    master.write(byte);
    twiMaster.writes.push(byte);
    completeHostTwiEvent(avr);
  }
  master.stop();
  twiMaster.stops += 1;
  completeHostTwiEvent(avr, 1);

  if (!master.start(TWI_SLAVE_ADDR, true)) throw new Error("avrts TWI slave did not ACK SLA+R.");
  twiMaster.starts.push(`R@${TWI_SLAVE_ADDR.toString(16).padStart(2, "0")}`);
  completeHostTwiEvent(avr);
  twiMaster.reads.push(master.read(false));
  completeHostTwiEvent(avr);

  const result = [...avr.cpu.data.slice(TWI_SLAVE_RESULT_ADDR, TWI_SLAVE_RESULT_ADDR + TWI_SLAVE_RESULT_LEN)];
  twiMaster.completed = twiSlaveResultComplete(result, twiMaster);
  return {
    completed: twiMaster.completed === true,
    cycles: avr.cpu.cycles,
    result,
    twiMaster,
  };
}

function runAvrtsSpiSlave(options: Options): SpiSlaveOutcome {
  const hex = readFileSync(options.hex, "utf8");
  const avr = AVR({ hex, timing: "cycle-exact" });
  const spiMaster: SpiMasterTranscript = { writes: [], outputs: [], completed: false };
  let transferStarted = false;

  avr.pin(10).setInput(false);
  avr.watchData(SPI_SLAVE_READY_MARKER_ADDR, ({ value }) => {
    if (transferStarted || value !== SPI_SLAVE_READY) return;
    transferStarted = true;
    spiMaster.writes.push(SPI_SLAVE_INPUT_BYTE);
    spiMaster.outputs.push(avr.spi.master().transfer(SPI_SLAVE_INPUT_BYTE));
  });

  while (avr.cpu.cycles < options.cycles) {
    const result = [...avr.cpu.data.slice(SPI_SLAVE_RESULT_ADDR, SPI_SLAVE_RESULT_ADDR + SPI_SLAVE_RESULT_LEN)];
    if (spiSlaveResultComplete(result)) break;
    avr.runCycles(1_000);
  }

  const result = [...avr.cpu.data.slice(SPI_SLAVE_RESULT_ADDR, SPI_SLAVE_RESULT_ADDR + SPI_SLAVE_RESULT_LEN)];
  spiMaster.completed = transferStarted;
  return {
    completed: spiSlaveResultComplete(result),
    cycles: avr.cpu.cycles,
    result,
    spiMaster,
  };
}

function twiSlaveOutcome(simavr: SimavrState): TwiSlaveOutcome {
  const twiMaster = simavr.twiMaster ?? { starts: [], writes: [], reads: [], stops: 0, completed: false, failed: false };
  const result = simavr.dumps.result ?? [];
  return {
    completed: simavr.completed && twiMaster.completed === true && twiSlaveResultComplete(result, twiMaster),
    cycles: simavr.cycles,
    result,
    twiMaster,
  };
}

function spiSlaveOutcome(simavr: SimavrState): SpiSlaveOutcome {
  const result = simavr.dumps.result ?? [];
  const spiMaster = simavr.spiMaster ?? { writes: [], outputs: [], completed: false };
  return {
    completed: simavr.completed && spiMaster.completed === true && spiSlaveResultComplete(result),
    cycles: simavr.cycles,
    result,
    spiMaster,
  };
}

function timer2AsyncOutcome(simavr: SimavrState): Timer2AsyncOutcome {
  const result = simavr.dumps.result ?? [];
  return {
    completed: simavr.completed && timer2AsyncResultComplete(result),
    cycles: simavr.cycles,
    result,
  };
}

function compareTwiSlaveScenario(base: Options): TwiSlaveComparison {
  const options = optionsForTwiSlaveScenario(base);
  const raw = runOracle(options);
  const simavr = twiSlaveOutcome(raw);
  const avrts = runAvrtsTwiSlave(options);
  const differences: string[] = [];

  if (!simavr.completed) differences.push(`simavr did not complete the TWI slave Wire script within ${simavr.cycles} cycles`);
  if (!avrts.completed) differences.push(`avrts did not complete the TWI slave Wire script within ${avrts.cycles} cycles`);
  compareArray(differences, "twi-slave-result", simavr.result, avrts.result);
  if (JSON.stringify(simavr.twiMaster) !== JSON.stringify(avrts.twiMaster)) {
    differences.push(`twiMaster: simavr=${stableJson(simavr.twiMaster)} avrts=${stableJson(avrts.twiMaster)}`);
  }

  return { pass: differences.length === 0, differences, simavr, avrts, raw };
}

function comparableSpiSlaveResult(outcome: SpiSlaveOutcome, normalizations: string[]): number[] {
  const result = [...outcome.result];
  if (result.length >= SPI_SLAVE_RESULT_LEN) {
    result[1] = 0;
    result[2] = 0;
    normalizations.push("SPI slave elapsed bytes normalized; native simavr delivers external SPI through an IRQ while avrts schedules the host transfer over SCK cycles.");
  }
  return result;
}

function comparableSpiMasterTranscript(outcome: SpiSlaveOutcome, normalizations: string[]): SpiMasterTranscript {
  normalizations.push("SPI slave host-output byte normalized; native simavr echoes the input IRQ byte, while avrts returns the preloaded slave SPDR byte.");
  return {
    writes: outcome.spiMaster.writes,
    outputs: [],
    completed: outcome.spiMaster.completed,
  };
}

function compareSpiSlaveScenario(base: Options): SpiSlaveComparison {
  const options = optionsForSpiSlaveScenario(base);
  const raw = runOracle(options);
  const simavr = spiSlaveOutcome(raw);
  const avrts = runAvrtsSpiSlave(options);
  const differences: string[] = [];
  const normalizations: string[] = [];

  if (!simavr.completed) differences.push(`simavr did not complete the SPI slave script within ${simavr.cycles} cycles`);
  if (!avrts.completed) differences.push(`avrts did not complete the SPI slave script within ${avrts.cycles} cycles`);
  compareArray(differences, "spi-slave-result", comparableSpiSlaveResult(simavr, normalizations), comparableSpiSlaveResult(avrts, normalizations));
  if (JSON.stringify(comparableSpiMasterTranscript(simavr, normalizations)) !== JSON.stringify(comparableSpiMasterTranscript(avrts, normalizations))) {
    differences.push(`spiMaster: simavr=${stableJson(simavr.spiMaster)} avrts=${stableJson(avrts.spiMaster)}`);
  }

  return { pass: differences.length === 0, differences, normalizations: [...new Set(normalizations)], simavr, avrts, raw };
}

function compareTimer2AsyncScenario(base: Options): Timer2AsyncComparison {
  const options = optionsForTimer2AsyncScenario(base);
  const raw = runOracle(options);
  const simavr = timer2AsyncOutcome(raw);
  const avrts = runAvrtsTimer2Async(options);
  const differences: string[] = [];

  if (!simavr.completed) differences.push(`simavr did not complete the Timer2 async fixture within ${simavr.cycles} cycles`);
  if (!avrts.completed) differences.push(`avrts did not complete the Timer2 async fixture within ${avrts.cycles} cycles`);
  compareArray(differences, "timer2-async-result", simavr.result, avrts.result);

  return { pass: differences.length === 0, differences, simavr, avrts, raw };
}

function comparableResult(scenario: ResultScenario, outcome: ScenarioOutcome, normalizations: string[]): number[] {
  const result = [...outcome.result];
  if (scenario === "peripheral-mix" && result.length > PERIPHERAL_MIX_TIMER_THRESHOLD_RESULT_INDEX) {
    result[PERIPHERAL_MIX_TIMER_THRESHOLD_RESULT_INDEX] = 0;
    normalizations.push("peripheral-mix timer-threshold byte is normalized; timed TWI makes the old ticks<=120 threshold engine-dependent.");
  }
  if (scenario === "peripheral-mix" && result.length > PERIPHERAL_MIX_PORTD_RESULT_INDEX) {
    result[PERIPHERAL_MIX_PORTD_RESULT_INDEX] = 0;
    normalizations.push("peripheral-mix PORTD PWM latch byte is normalized; simavr keeps timer-driven OC0B separate from the PORTD latch.");
  }
  return result;
}

function comparableRegisters(scenario: ResultScenario, outcome: ScenarioOutcome, normalizations: string[]): Record<string, number> {
  if (scenario !== "peripheral-mix") return outcome.registers;
  normalizations.push("peripheral-mix PORTD register summary is normalized for the same timer-driven OC0B latch model difference.");
  return { ...outcome.registers, portD: 0 };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function printScenarioOutcome(label: string, outcome: ScenarioOutcome): void {
  console.log(
    `${label.padEnd(6)} completed=${String(outcome.completed).padEnd(5)} cycles=${outcome.cycles.toLocaleString()} result=${outcome.result
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")}`,
  );
  console.log(`       twi starts=${outcome.twi.starts.length} writes=${outcome.twi.writes.length} reads=${outcome.twi.reads.length} stops=${outcome.twi.stops}`);
  console.log(`       serial bytes=${outcome.serial.length}`);
}

function read16(bytes: number[], offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function printTimingOutcome(label: string, outcome: TimingOutcome): void {
  const result = outcome.result;
  console.log(`${label.padEnd(6)} completed=${String(outcome.completed).padEnd(5)} cycles=${outcome.cycles.toLocaleString()}`);
  console.log(
    `       usartTXC=${read16(result, 1)} usartRXC=${read16(result, 29)} usartDOR=${read16(result, 33)} spiSPIF=${read16(result, 3)} twiStart=${read16(result, 7)} twiWrite=${read16(result, 13)} twiRestart=${read16(result, 16)} twiSlaR=${read16(result, 19)} twiRead=${read16(result, 22)} twiStop=${read16(result, 26)}`,
  );
  console.log(`       usart rxByte=0x${(result[31] ?? 0).toString(16)} rxStatus=0x${(result[32] ?? 0).toString(16)} dorStatus=0x${(result[35] ?? 0).toString(16)} dorBytes=${formatBytes(result.slice(36, 38))} dorAfter=0x${(result[38] ?? 0).toString(16)}`);
  console.log(`       statuses start=0x${(result[9] ?? 0).toString(16)} write=0x${(result[15] ?? 0).toString(16)} read=0x${(result[24] ?? 0).toString(16)} twcrStop=0x${(result[28] ?? 0).toString(16)}`);
  console.log(`       serial bytes=${outcome.serial.length} twi starts=${outcome.twi.starts.length} writes=${outcome.twi.writes.length} reads=${outcome.twi.reads.length} stops=${outcome.twi.stops}`);
}

function formatBytes(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function printTwiSlaveOutcome(label: string, outcome: TwiSlaveOutcome): void {
  console.log(`${label.padEnd(6)} completed=${String(outcome.completed).padEnd(5)} cycles=${outcome.cycles.toLocaleString()} result=${formatBytes(outcome.result)}`);
  console.log(
    `       master starts=${outcome.twiMaster.starts.join(",")} writes=${formatBytes(outcome.twiMaster.writes)} reads=${formatBytes(outcome.twiMaster.reads)} stops=${outcome.twiMaster.stops}`,
  );
}

function printSpiSlaveOutcome(label: string, outcome: SpiSlaveOutcome): void {
  console.log(`${label.padEnd(6)} completed=${String(outcome.completed).padEnd(5)} cycles=${outcome.cycles.toLocaleString()} result=${formatBytes(outcome.result)}`);
  console.log(
    `       master writes=${formatBytes(outcome.spiMaster.writes)} outputs=${formatBytes(outcome.spiMaster.outputs)} completed=${outcome.spiMaster.completed === true}`,
  );
}

function printTimer2AsyncOutcome(label: string, outcome: Timer2AsyncOutcome): void {
  console.log(`${label.padEnd(6)} completed=${String(outcome.completed).padEnd(5)} cycles=${outcome.cycles.toLocaleString()} result=${formatBytes(outcome.result)}`);
  console.log(`       firstTCNT2=0x${(outcome.result[1] ?? 0).toString(16)} finalTCNT2=0x${(outcome.result[4] ?? 0).toString(16)} finalTIFR2=0x${(outcome.result[5] ?? 0).toString(16)} ASSR=0x${(outcome.result[6] ?? 0).toString(16)}`);
}

function printComparatorOutcome(label: string, outcome: ComparatorOutcome): void {
  console.log(`${label.padEnd(6)} completed=${String(outcome.completed).padEnd(5)} cycles=${outcome.cycles.toLocaleString()} result=${formatBytes(outcome.result)}`);
  console.log(`       risingEdges=${outcome.result[1] ?? 0} acoLive=${outcome.result[2] ?? 0} acoInIsr=${outcome.result[3] ?? 0}`);
}

function printOptibootOutcome(label: string, outcome: OptibootOutcome): void {
  console.log(`${label.padEnd(6)} completed=${String(outcome.completed).padEnd(5)} cycles=${outcome.cycles.toLocaleString()} serial=${outcome.serial.length} bytes`);
  console.log(`       flash[0..15]=${formatBytes(outcome.flash.slice(0, 16))}`);
  if (outcome.optiboot) {
    console.log(
      `       phase=${outcome.optiboot.phase} portBHigh=${outcome.optiboot.sawPortBHigh} portBLowAfterHigh=${outcome.optiboot.sawPortBLowAfterHigh}`,
    );
  }
}

function runResultOracle(options: Options): boolean {
  const scenarios = options.resultCase === "all" ? RESULT_SCENARIOS : [options.resultCase!];
  let failed = false;
  for (const scenario of scenarios) {
    const result = compareResultScenario(scenario, options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`simavr native result oracle: ${scenario} vs avrts`);
      printScenarioOutcome("simavr", result.simavr);
      printScenarioOutcome("avrts", result.avrts);
      if (result.pass) {
        console.log("\nPASS: result block, serial output, I2C transcript, and register summary match.");
        for (const note of result.normalizations) console.log(`NOTE: ${note}`);
      } else {
        console.error("\nFAILED");
        for (const difference of result.differences) console.error(`\n${difference}`);
      }
      if (scenarios.length > 1) console.log("");
    }
    failed ||= !result.pass;
  }
  return !failed;
}

function runOptibootOracle(options: Options): boolean {
  const result = compareOptibootScenario(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.pass;
  }

  console.log("simavr native Optiboot oracle: STK500v1 flash session vs avrts");
  printOptibootOutcome("simavr", result.simavr);
  printOptibootOutcome("avrts", result.avrts);
  if (result.pass) {
    console.log("\nPASS: Optiboot serial transcript, programmed flash page, and uploaded app execution match.");
    for (const note of result.normalizations) console.log(`NOTE: ${note}`);
  } else {
    console.error("\nFAILED");
    for (const difference of result.differences) console.error(`\n${difference}`);
  }
  return result.pass;
}

function runTimingOracle(options: Options): boolean {
  const runPolling = options.timingCase === "all";
  const runTwiSlave = options.timingCase === "all" || options.timingCase === "twi-slave";
  const runSpiSlave = options.timingCase === "all" || options.timingCase === "spi-slave";
  const runTimer2Async = options.timingCase === "all" || options.timingCase === "timer2-async";
  const runComparator = options.timingCase === "all" || options.timingCase === "comparator";
  const polling = runPolling ? compareTimingScenario(options) : undefined;
  const twiSlave = runTwiSlave ? compareTwiSlaveScenario(options) : undefined;
  const spiSlave = runSpiSlave ? compareSpiSlaveScenario(options) : undefined;
  const timer2Async = runTimer2Async ? compareTimer2AsyncScenario(options) : undefined;
  const comparator = runComparator ? compareComparatorScenario(options) : undefined;

  if (options.json) {
    console.log(JSON.stringify({ polling, twiSlave, spiSlave, timer2Async, comparator }, null, 2));
    return (
      (polling?.pass ?? true) &&
      (twiSlave?.pass ?? true) &&
      (spiSlave?.pass ?? true) &&
      (timer2Async?.pass ?? true) &&
      (comparator?.pass ?? true)
    );
  }

  let failed = false;
  if (polling) {
    console.log("simavr native timing oracle: USART/SPI/TWI polling vs avrts");
    printTimingOutcome("simavr", polling.simavr);
    printTimingOutcome("avrts", polling.avrts);
    if (polling.pass) {
      console.log("\nPASS: calibrated timing result, serial output, and I2C transcript match.");
      for (const note of polling.normalizations) console.log(`NOTE: ${note}`);
    } else {
      console.error("\nFAILED");
      for (const difference of polling.differences) console.error(`\n${difference}`);
      failed = true;
    }
    if (twiSlave || spiSlave || timer2Async || comparator) console.log("");
  }

  if (twiSlave) {
    console.log("simavr native TWI slave oracle: Arduino Wire slave vs avrts");
    printTwiSlaveOutcome("simavr", twiSlave.simavr);
    printTwiSlaveOutcome("avrts", twiSlave.avrts);
    if (twiSlave.pass) {
      console.log("\nPASS: Wire.onReceive/onRequest result block and external-master transcript match.");
      console.log("NOTE: simavr drives the slave transaction through TWI IRQs; the helper mirrors the read byte from the fixture's txLast result because this native simavr slave path does not emit it as a separate output IRQ.");
    } else {
      console.error("\nFAILED");
      for (const difference of twiSlave.differences) console.error(`\n${difference}`);
      failed = true;
    }
    if (spiSlave || timer2Async || comparator) console.log("");
  }

  if (spiSlave) {
    console.log("simavr native SPI slave oracle: external master transfer vs avrts");
    printSpiSlaveOutcome("simavr", spiSlave.simavr);
    printSpiSlaveOutcome("avrts", spiSlave.avrts);
    if (spiSlave.pass) {
      console.log("\nPASS: SPI slave result block and external-master write transcript match.");
      for (const note of spiSlave.normalizations) console.log(`NOTE: ${note}`);
    } else {
      console.error("\nFAILED");
      for (const difference of spiSlave.differences) console.error(`\n${difference}`);
      failed = true;
    }
    if (timer2Async || comparator) console.log("");
  }

  if (timer2Async) {
    console.log("simavr native Timer2 async oracle: 32.768 kHz drift vs avrts");
    printTimer2AsyncOutcome("simavr", timer2Async.simavr);
    printTimer2AsyncOutcome("avrts", timer2Async.avrts);
    if (timer2Async.pass) {
      console.log("\nPASS: Timer2 async TCNT2 snapshots and final flags match.");
    } else {
      console.error("\nFAILED");
      for (const difference of timer2Async.differences) console.error(`\n${difference}`);
      failed = true;
    }
    if (comparator) console.log("");
  }

  if (comparator) {
    console.log("simavr native comparator oracle: rising-edge ACI vs avrts");
    printComparatorOutcome("simavr", comparator.simavr);
    printComparatorOutcome("avrts", comparator.avrts);
    if (comparator.pass) {
      console.log("\nPASS: comparator rising-edge count, ACO, and ISR-sampled ACO match.");
      console.log("NOTE: both engines drive AIN0/AIN1 externally (simavr via ACOMP AIN input IRQs, avrts via the comparator handle); the injected edge cycle is identical, so the firmware-visible result block is compared, not the injection delay.");
    } else {
      console.error("\nFAILED");
      for (const difference of comparator.differences) console.error(`\n${difference}`);
      failed = true;
    }
  }

  return !failed;
}

function printResult(result: SimavrState, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const state = result;
  console.log("simavr native oracle");
  console.log(`mcu=${state.mcu} freq=${state.frequency} cycles=${state.cycles}/${state.targetCycles} state=${state.state}`);
  console.log(`pc=${state.pcWords} words (${state.pcBytes} bytes) sp=0x${state.sp.toString(16)} sreg=0x${state.sreg.toString(16).padStart(2, "0")}`);
  for (const [name, bytes] of Object.entries(state.dumps)) {
    const preview = bytes
      .slice(0, 32)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");
    console.log(`${name}[${bytes.length}] ${preview}${bytes.length > 32 ? " ..." : ""}`);
  }
  console.log(`serial bytes=${state.serial.length}`);
  console.log(`twi starts=${state.twi.starts.length} writes=${state.twi.writes.length} reads=${state.twi.reads.length} stops=${state.twi.stops}`);
}

function printCompare(result: CompareResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printResult(result.simavr, false);
  if (result.pass) {
    console.log("avrts compare PASS: normalized core state matches.");
    return;
  }
  console.log("avrts compare FAILED:");
  for (const difference of result.differences) console.log(`  ${difference}`);
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    if (options.optiboot) {
      if (!runOptibootOracle(options)) process.exit(1);
      process.exit(0);
    }
    if (options.timingCase) {
      if (!runTimingOracle(options)) process.exit(1);
      process.exit(0);
    }
    if (options.resultCase) {
      if (!runResultOracle(options)) process.exit(1);
      process.exit(0);
    }
    const simavr = runOracle(options);
    if (options.compareAvrts) {
      const result = compareWithAvrts(simavr, options);
      printCompare(result, options.json);
      if (!result.pass) process.exit(1);
    } else {
      printResult(simavr, options.json);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
