/**
 * avrts vs avr8js throughput comparison.
 *
 * Runs the same workloads through both simulators for the same CPU-cycle budget
 * and reports cycles/s for each plus the ratio. The default cycle budgets are
 * intentionally long enough that Arduino setup does not dominate the steady
 * loop comparison. Both simulators are wired with the same peripheral set
 * (timers 0/1/2, USART0, ADC, GPIO B/C/D, watchdog) so neither
 * gets a free pass by skipping peripheral work — though note the two use
 * different peripheral-timing architectures (avrts's default runtime uses CPU
 * clock events; this avr8js loop calls cpu.tick() after each instruction), which
 * is itself part of what is being compared.
 *
 *   bun run scripts/benchmark-compare.ts [--repeats N] [--case NAME] [--cycles N]
 */
import { AVR, CPU, type Udivmodsi4RegionMode } from "../src";
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

function runAvrts(workload: Workload, udivmodsi4Region: Udivmodsi4RegionMode): number {
  const create = () => {
    if (workload.hex === undefined) {
      const avr = AVR();
      avr.cpu.flash[0] = 0xcfff;
      return avr;
    }
    return AVR(workload.hex);
  };
  const start = performance.now();
  const previousRegion = CPU.udivmodsi4RegionMode;
  CPU.udivmodsi4RegionMode = udivmodsi4Region;
  try {
    const avr = create();
    avr.runCycles(workload.cycles);
  } finally {
    CPU.udivmodsi4RegionMode = previousRegion;
  }
  const elapsed = Math.max(0.001, performance.now() - start);
  return workload.cycles / (elapsed / 1000);
}

function runAvr8js(workload: Workload): number {
  const start = performance.now();
  const cpu = new Avr8jsCPU(programFor(workload.hex));
  // Full peripheral set, matching what avrts ticks each instruction.
  new AVRTimer(cpu, timer0Config);
  new AVRTimer(cpu, timer1Config);
  new AVRTimer(cpu, timer2Config);
  new AVRUSART(cpu, usart0Config, CLOCK_HZ);
  new AVRADC(cpu, adcConfig);
  new AVRIOPort(cpu, portBConfig);
  new AVRIOPort(cpu, portCConfig);
  new AVRIOPort(cpu, portDConfig);
  const clock = new AVRClock(cpu, CLOCK_HZ, clockConfig);
  new AVRWatchdog(cpu, watchdogConfig, clock);

  const target = cpu.cycles + workload.cycles;
  while (cpu.cycles < target) {
    avrInstruction(cpu);
    cpu.tick();
  }
  const elapsed = Math.max(0.001, performance.now() - start);
  return workload.cycles / (elapsed / 1000);
}

function best(fn: (w: Workload) => number, workload: Workload, repeats: number): number {
  let top = 0;
  for (let i = 0; i < repeats; i += 1) top = Math.max(top, fn(workload));
  return top;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
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
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repeats") {
      options.repeats = parsePositiveInt(args[++i], "--repeats");
    } else if (arg === "--cycles") {
      options.cycles = parsePositiveInt(args[++i], "--cycles");
    } else if (arg === "--case") {
      options.only = args[++i];
    } else if (arg === "--udivmodsi4-region") {
      options.udivmodsi4Region = parseUdivmodsi4RegionMode(args[++i]);
    } else if (arg === "--isolate") {
      options.isolate = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
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

function main(): void {
  const options = parseArgs(Bun.argv.slice(2));
  const workloads = WORKLOADS.filter((workload) => {
    return options.only === undefined || workload.name === options.only;
  }).map((workload) => ({
    ...workload,
    cycles: options.cycles ?? workload.cycles,
  }));
  if (workloads.length === 0) throw new Error(`Unknown benchmark case "${options.only}".`);

  if (!options.quiet) {
    const mode = options.isolate ? "isolated per-fixture process" : "single process";
    console.log(
      `avrts vs avr8js  (best of ${options.repeats}, clock ${CLOCK_HZ / 1e6} MHz, udivmodsi4 ${options.udivmodsi4Region}, ${mode})\n`,
    );
    const head = `${"workload".padEnd(14)}${"cycles".padStart(12)}${"avrts".padStart(16)}${"avr8js".padStart(16)}${"avrts/avr8js".padStart(16)}`;
    console.log(head);
    console.log("-".repeat(head.length));
  }

  // Isolate parent: re-invoke this script once per workload so each fixture gets a
  // fresh JSC heap (production-representative; see CompareOptions.isolate). The
  // children print only their data row (--quiet) and we forward it verbatim.
  if (options.isolate && options.only === undefined) {
    for (const workload of workloads) {
      runIsolatedChild(workload.name, options);
    }
    return;
  }

  for (const workload of workloads) {
    const avrts = best(
      (candidate) => runAvrts(candidate, options.udivmodsi4Region),
      workload,
      options.repeats,
    );
    const avr8 = best(runAvr8js, workload, options.repeats);
    const ratio = avr8 === 0 ? 0 : avrts / avr8;
    console.log(
      `${workload.name.padEnd(14)}${fmt(workload.cycles).padStart(12)}${(fmt(avrts) + "/s").padStart(16)}${(fmt(avr8) + "/s").padStart(16)}${`${ratio.toFixed(2)}x`.padStart(16)}`,
    );
  }
}

/** Spawn one child process to measure a single workload in a fresh heap. */
function runIsolatedChild(name: string, options: CompareOptions): void {
  const childArgs = [
    "run",
    import.meta.path,
    "--quiet",
    "--case",
    name,
    "--repeats",
    String(options.repeats),
    "--udivmodsi4-region",
    options.udivmodsi4Region,
  ];
  if (options.cycles !== undefined) childArgs.push("--cycles", String(options.cycles));
  const result = Bun.spawnSync(["bun", ...childArgs], { stdout: "pipe", stderr: "inherit" });
  if (!result.success) {
    throw new Error(`isolated child for "${name}" failed (exit ${result.exitCode}).`);
  }
  process.stdout.write(result.stdout.toString().trimEnd() + "\n");
}

main();
