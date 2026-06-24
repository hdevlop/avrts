/**
 * avrts vs avr8js throughput comparison.
 *
 * Runs the same workloads through both simulators for the same CPU-cycle budget
 * and reports cycles/s for each plus the ratio. The default cycle budgets are
 * intentionally long enough that Arduino setup does not dominate the steady
 * loop comparison. Both simulators are wired with the same peripheral set
 * (timers 0/1/2, USART0, ADC, GPIO B/C/D, watchdog) so neither
 * gets a free pass by skipping peripheral work — though note the two use
 * different peripheral-timing architectures (avrts ticks every instruction;
 * avr8js schedules clock events), which is itself part of what is being compared.
 *
 *   bun run scripts/benchmark-compare.ts [--repeats N] [--case NAME] [--cycles N]
 */
import { AVR } from "../src";
import { loadHex } from "../src/loader";
import { FLASH_WORDS } from "../src/cpu";
import delayBlinkHex from "../examples/delay-blink/delay-blink.ino.hex" with { type: "text" };
import serialPrintHex from "../examples/arduino-serial-print/arduino-serial-print.ino.hex" with { type: "text" };
import analogWriteHex from "../examples/arduino-analog-write/arduino-analog-write.ino.hex" with { type: "text" };
import sensorFormatHex from "../examples/arduino-sensor-format/arduino-sensor-format.ino.hex" with { type: "text" };
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
}

const WORKLOADS: Workload[] = [
  { name: "tight-loop", cycles: 10_000_000 },
  { name: "delay-blink", cycles: 50_000_000, hex: delayBlinkHex },
  { name: "serial-print", cycles: 5_000_000, hex: serialPrintHex },
  { name: "analog-write", cycles: 5_000_000, hex: analogWriteHex },
  { name: "sensor-format", cycles: 5_000_000, hex: sensorFormatHex },
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

function runAvrts(workload: Workload): number {
  const create = () => {
    if (workload.hex === undefined) {
      const avr = AVR();
      avr.cpu.flash[0] = 0xcfff;
      return avr;
    }
    return AVR(workload.hex);
  };
  const start = performance.now();
  const avr = create();
  avr.runCycles(workload.cycles);
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
  const options: CompareOptions = { repeats: 3 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repeats") {
      options.repeats = parsePositiveInt(args[++i], "--repeats");
    } else if (arg === "--cycles") {
      options.cycles = parsePositiveInt(args[++i], "--cycles");
    } else if (arg === "--case") {
      options.only = args[++i];
    } else {
      throw new Error(`Unknown benchmark-compare argument "${arg}".`);
    }
  }
  return options;
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

  console.log(`avrts vs avr8js  (best of ${options.repeats}, clock ${CLOCK_HZ / 1e6} MHz)\n`);
  const head = `${"workload".padEnd(14)}${"cycles".padStart(12)}${"avrts".padStart(16)}${"avr8js".padStart(16)}${"avrts/avr8js".padStart(16)}`;
  console.log(head);
  console.log("-".repeat(head.length));

  for (const workload of workloads) {
    const avrts = best(runAvrts, workload, options.repeats);
    const avr8 = best(runAvr8js, workload, options.repeats);
    const ratio = avr8 === 0 ? 0 : avrts / avr8;
    console.log(
      `${workload.name.padEnd(14)}${fmt(workload.cycles).padStart(12)}${(fmt(avrts) + "/s").padStart(16)}${(fmt(avr8) + "/s").padStart(16)}${`${ratio.toFixed(2)}x`.padStart(16)}`,
    );
  }
}

main();
