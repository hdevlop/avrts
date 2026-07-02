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
import { AVR } from "../src";
import {
  ADCH,
  ADCL,
  DDRD,
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
  TWDR,
  TWSR,
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
  resultCase?: ResultCase;
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
  twi: TwiTranscript;
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

type ResultScenario = (typeof RESULT_SCENARIOS)[number];
type ResultCase = ResultScenario | "all";

interface TwiTranscript {
  starts: string[];
  writes: number[];
  reads: number[];
  stops: number;
}

interface ScenarioOutcome {
  completed: boolean;
  cycles: number;
  result: number[];
  registers: Record<string, number>;
  twi: TwiTranscript;
  serial: number[];
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
    } else if (arg === "--result-case" || arg === "--case") {
      options.resultCase = parseResultCase(args[++i]);
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

function comparableResult(scenario: ResultScenario, outcome: ScenarioOutcome, normalizations: string[]): number[] {
  const result = [...outcome.result];
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
