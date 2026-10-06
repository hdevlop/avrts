/**
 * avrts vs avr8js throughput comparison.
 *
 * Runs the same workloads through both simulators for the same CPU-cycle budget
 * and reports cycles/s for each plus the ratio. The default cycle budgets are
 * preceded by an explicit warm-up, with construction excluded. Both simulators
 * instantiate the peripherals used by these workloads (timers 0/1/2, USART0,
 * ADC, GPIO B/C/D, watchdog, TWI). The two use
 * different peripheral-timing architectures (avrts's default runtime uses CPU
 * clock events; this avr8js loop calls cpu.tick() after each instruction), which
 * is itself part of what is being compared.
 *
 *   bun run scripts/benchmark-compare.ts --isolate [--repeats N] [--case NAME]
 *     [--cycles N] [--warmup-cycles N] [--json] [--output FILE]
 */
import { AVR, type Udivmodsi4RegionMode } from "../src";
import { createTranscript, createAvrtsTwiSlave, Avr8jsTwiSlave } from "./benchmark-results";
import { loadHex } from "../src/loader";
import { FLASH_WORDS } from "../src/cpu";
import delayBlinkHex from "../examples/delay-blink/delay-blink.ino.hex" with { type: "text" };
import serialPrintHex from "../examples/arduino-serial-print/arduino-serial-print.ino.hex" with { type: "text" };
import analogWriteHex from "../examples/arduino-analog-write/arduino-analog-write.ino.hex" with { type: "text" };
import sensorFormatHex from "../examples/arduino-sensor-format/arduino-sensor-format.ino.hex" with { type: "text" };
import floatMathHex from "../examples/arduino-float-math/arduino-float-math.ino.hex" with { type: "text" };
import bitbangCrcHex from "../examples/arduino-bitbang-crc/arduino-bitbang-crc.ino.hex" with { type: "text" };
import peripheralMixHex from "../examples/arduino-peripheral-mix/arduino-peripheral-mix.ino.hex" with { type: "text" };
import isrHeavyHex from "../examples/arduino-isr-heavy/arduino-isr-heavy.ino.hex" with { type: "text" };
import stringHeavyHex from "../examples/arduino-string-heavy/arduino-string-heavy.ino.hex" with { type: "text" };
import dspFixedHex from "../examples/arduino-dsp-fixed/arduino-dsp-fixed.ino.hex" with { type: "text" };
import {
  CPU as Avr8jsCPU,
  avrInstruction,
  AVRTimer,
  timer0Config,
  timer1Config,
  timer2Config,
  AVRUSART,
  usart0Config,
  AVRADC,
  adcConfig,
  AVRIOPort,
  portBConfig,
  portCConfig,
  portDConfig,
  AVRClock,
  clockConfig,
  AVRWatchdog,
  watchdogConfig,
  AVRTWI,
  twiConfig,
} from "avr8js";

const CLOCK_HZ = 16_000_000;

interface Workload {
  name: string;
  cycles: number;
  /** undefined → synthetic tight loop (rjmp -1); otherwise an Intel HEX program. */
  hex?: string;
}

interface CompareOptions {
  repeats: number;
  cycles?: number;
  only?: string;
  udivmodsi4Region: Udivmodsi4RegionMode;
  /**
   * Run each workload in its own subprocess (fresh JSC heap per fixture). This is
   * the production-representative measurement: real use runs one firmware per CPU,
   * so each fixture's hot methods stay monomorphic. The default single-process
   * mode co-runs all 11 firmwares, which megamorphically deoptimizes avrts's
   * shared hot path ~3x (avr8js is nearly immune) and under-reports real-code
   * throughput. See docs/performance-summary.md.
   */
  isolate: boolean;
  /** Suppress the run header (used for isolate child processes). */
  quiet: boolean;
  warmupCycles: number;
  json: boolean;
  output?: string;
}

interface Runner {
  readonly cycles: number;
  readonly twiStops?: number | undefined;
  run(cycles: number): void;
}

interface Sample {
  cycles: number;
  elapsedMs: number;
  constructionMs: number;
  cyclesPerSecond: number;
  twiStops?: number;
}

interface ComparisonRow {
  name: string;
  cycles: number;
  avrts: { samples: Sample[]; bestCyclesPerSecond: number };
  avr8js: { samples: Sample[]; bestCyclesPerSecond: number };
  ratio: number;
}

/** Time execution only, retaining setup cost separately and counting actual cycles. */
export function measureExecution(create: () => Runner, cycles: number, warmupCycles: number, now = () => performance.now()): Sample {
  const setupStart = now();
  const runner = create();
  const constructionMs = now() - setupStart;
  if (warmupCycles > 0) runner.run(warmupCycles);
  const before = runner.cycles;
  const twiStopsBefore = runner.twiStops;
  const start = now();
  runner.run(cycles);
  const elapsedMs = Math.max(0.001, now() - start);
  const actualCycles = runner.cycles - before;
  return { cycles: actualCycles, elapsedMs, constructionMs, cyclesPerSecond: actualCycles / (elapsedMs / 1000),
    ...(twiStopsBefore === undefined ? {} : { twiStops: runner.twiStops! - twiStopsBefore }) };
}

const WORKLOADS: Workload[] = [
  { name: "tight-loop", cycles: 10_000_000 },
  { name: "delay-blink", cycles: 50_000_000, hex: delayBlinkHex },
  { name: "serial-print", cycles: 5_000_000, hex: serialPrintHex },
  { name: "analog-write", cycles: 5_000_000, hex: analogWriteHex },
  { name: "sensor-format", cycles: 5_000_000, hex: sensorFormatHex },
  { name: "float-math", cycles: 5_000_000, hex: floatMathHex },
  { name: "bitbang-crc", cycles: 5_000_000, hex: bitbangCrcHex },
  { name: "peripheral-mix", cycles: 5_000_000, hex: peripheralMixHex },
  { name: "isr-heavy", cycles: 5_000_000, hex: isrHeavyHex },
  { name: "string-heavy", cycles: 5_000_000, hex: stringHeavyHex },
  { name: "dsp-fixed", cycles: 5_000_000, hex: dspFixedHex },
];

function programFor(hex?: string): Uint16Array {
  const progMem = new Uint16Array(FLASH_WORDS);
  if (hex === undefined) {
    progMem[0] = 0xcfff; // rjmp -1
  } else {
    loadHex(hex, progMem);
  }
  return progMem;
}

function runAvrts(workload: Workload, options: CompareOptions): Sample {
  return measureExecution(() => {
    const avr = workload.hex === undefined ? AVR() : AVR(workload.hex);
    if (workload.hex === undefined) avr.cpu.flash[0] = 0xcfff;
    avr.cpu.udivmodsi4RegionMode = options.udivmodsi4Region;
    avr.analog(0).setValue(512);
    avr.pin(2).setInput(true);
    const transcript = workload.name === "peripheral-mix" ? createTranscript() : undefined;
    if (transcript) avr.twi.connect(0x50, createAvrtsTwiSlave(transcript));
    return { get cycles() { return avr.cpu.cycles; }, run: (cycles) => { avr.runCycles(cycles); },
      get twiStops() { return transcript?.stops; } };
  }, workload.cycles, options.warmupCycles);
}

function runAvr8js(workload: Workload, options: CompareOptions): Sample {
  return measureExecution(() => {
    const cpu = new Avr8jsCPU(programFor(workload.hex));
    new AVRTimer(cpu, timer0Config);
    new AVRTimer(cpu, timer1Config);
    new AVRTimer(cpu, timer2Config);
    new AVRUSART(cpu, usart0Config, CLOCK_HZ);
    const adc = new AVRADC(cpu, adcConfig);
    adc.channelValues[0] = 2.5;
    new AVRIOPort(cpu, portBConfig);
    new AVRIOPort(cpu, portCConfig);
    const portD = new AVRIOPort(cpu, portDConfig);
    portD.setPin(2, true);
    const twi = new AVRTWI(cpu, twiConfig, CLOCK_HZ);
    const transcript = workload.name === "peripheral-mix" ? createTranscript() : undefined;
    if (transcript) twi.eventHandler = new Avr8jsTwiSlave(twi, transcript);
    const clock = new AVRClock(cpu, CLOCK_HZ, clockConfig);
    new AVRWatchdog(cpu, watchdogConfig, clock);

    return {
      get cycles() { return cpu.cycles; },
      run(cycles) {
        const target = cpu.cycles + cycles;
        while (cpu.cycles < target) { avrInstruction(cpu); cpu.tick(); }
      },
      get twiStops() { return transcript?.stops; },
    };
  }, workload.cycles, options.warmupCycles);
}

function best(fn: () => Sample, repeats: number) {
  const samples = Array.from({ length: repeats }, fn);
  return { samples, bestCyclesPerSecond: Math.max(...samples.map((sample) => sample.cyclesPerSecond)) };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer, got ${value}.`);
  }
  return parsed;
}

function parseArgs(args: string[]): CompareOptions {
  const options: CompareOptions = {
    repeats: 3,
    udivmodsi4Region: "semantic-direct",
    isolate: false,
    quiet: false,
    warmupCycles: 500_000,
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repeats") {
      options.repeats = parsePositiveInt(args[++i], "--repeats");
    } else if (arg === "--cycles") {
      options.cycles = parsePositiveInt(args[++i], "--cycles");
    } else if (arg === "--case") {
      options.only = args[++i];
      if (!options.only || options.only.startsWith("--")) throw new Error("--case expects a workload name");
    } else if (arg === "--udivmodsi4-region") {
      options.udivmodsi4Region = parseUdivmodsi4RegionMode(args[++i]);
    } else if (arg === "--isolate") {
      options.isolate = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--warmup-cycles") {
      const value = Number(args[++i]);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("--warmup-cycles expects a nonnegative integer");
      options.warmupCycles = value;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--output") {
      options.output = args[++i];
      if (!options.output || options.output.startsWith("--")) throw new Error("--output expects a file path");
    } else {
      throw new Error(`Unknown benchmark-compare argument "${arg}".`);
    }
  }
  return options;
}

function parseUdivmodsi4RegionMode(value: string | undefined): Udivmodsi4RegionMode {
  if (value === "handwritten" || value === "generated-cfg" || value === "semantic-direct") return value;
  throw new Error(
    `--udivmodsi4-region expects "handwritten", "generated-cfg", or "semantic-direct", got ${value}.`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const workloads = WORKLOADS.filter((workload) => {
    return options.only === undefined || workload.name === options.only;
  }).map((workload) => ({
    ...workload,
    cycles: options.cycles ?? workload.cycles,
  }));
  if (workloads.length === 0) throw new Error(`Unknown benchmark case "${options.only}".`);

  if (!options.quiet && !options.json) {
    const mode = options.isolate ? "isolated per-fixture process" : "single process";
    console.log(
      `avrts vs avr8js  (best of ${options.repeats}, clock ${CLOCK_HZ / 1e6} MHz, udivmodsi4 ${options.udivmodsi4Region}, ${mode}; construction excluded, ${options.warmupCycles} warm-up cycles)\n`,
    );
    const head = ["workload".padEnd(14), "cycles".padStart(12), "avrts".padStart(22), "avr8js".padStart(22), "avrts/avr8js".padStart(16)].join("  ");
    console.log(head);
    console.log("-".repeat(head.length));
  }

  // Isolate parent: re-invoke this script once per workload so each fixture gets a
  // fresh JSC heap (production-representative; see CompareOptions.isolate). The
  // Children return JSON samples; the parent renders rows and writes one report.
  const rows: ComparisonRow[] = [];
  for (const workload of workloads) {
    const row = options.isolate ? runIsolatedChild(workload.name, options) : (() => {
      const avrts = best(() => runAvrts(workload, options), options.repeats);
      const avr8js = best(() => runAvr8js(workload, options), options.repeats);
      return { name: workload.name, cycles: workload.cycles, avrts, avr8js, ratio: avrts.bestCyclesPerSecond / avr8js.bestCyclesPerSecond };
    })();
    rows.push(row);
    if (!options.json) console.log(
      [row.name.padEnd(14), fmt(row.cycles).padStart(12), (fmt(row.avrts.bestCyclesPerSecond) + "/s").padStart(22),
        (fmt(row.avr8js.bestCyclesPerSecond) + "/s").padStart(22), `${row.ratio.toFixed(2)}x`.padStart(16)].join("  "),
    );
  }
  const report = { runtime: Bun.version, clockHz: CLOCK_HZ, repeats: options.repeats,
    warmupCycles: options.warmupCycles, includesConstruction: false, isolate: options.isolate,
    udivmodsi4Region: options.udivmodsi4Region, rows };
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (options.output) await Bun.write(options.output, serialized);
  if (options.json) process.stdout.write(serialized);
}

/** Spawn one child process to measure a single workload in a fresh heap. */
function runIsolatedChild(name: string, options: CompareOptions): ComparisonRow {
  const childArgs = [
    "run",
    import.meta.path,
    "--quiet",
    "--json",
    "--case",
    name,
    "--repeats",
    String(options.repeats),
    "--udivmodsi4-region",
    options.udivmodsi4Region,
    "--warmup-cycles",
    String(options.warmupCycles),
  ];
  if (options.cycles !== undefined) childArgs.push("--cycles", String(options.cycles));
  const result = Bun.spawnSync([process.execPath, ...childArgs], { stdout: "pipe", stderr: "inherit" });
  if (!result.success) {
    throw new Error(`isolated child for "${name}" failed (exit ${result.exitCode}).`);
  }
  return (JSON.parse(result.stdout.toString()) as { rows: ComparisonRow[] }).rows[0]!;
}

if (import.meta.main) await main();
