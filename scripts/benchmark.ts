import { AVR, CPU, type Udivmodsi4RegionMode } from "../src";
import delayBlinkHex from "../examples/delay-blink/delay-blink.ino.hex" with { type: "text" };
import serialPrintHex from "../examples/arduino-serial-print/arduino-serial-print.ino.hex" with { type: "text" };
import analogWriteHex from "../examples/arduino-analog-write/arduino-analog-write.ino.hex" with { type: "text" };
import sensorFormatHex from "../examples/arduino-sensor-format/arduino-sensor-format.ino.hex" with { type: "text" };
import floatMathHex from "../examples/arduino-float-math/arduino-float-math.ino.hex" with { type: "text" };
import bitbangCrcHex from "../examples/arduino-bitbang-crc/arduino-bitbang-crc.ino.hex" with { type: "text" };
import isrHeavyHex from "../examples/arduino-isr-heavy/arduino-isr-heavy.ino.hex" with { type: "text" };

const DEFAULT_CLOCK_HZ = 16_000_000;

export interface BenchmarkCase {
  name: string;
  description: string;
  cycles: number;
  create(): ReturnType<typeof AVR>;
}

export interface BenchmarkResult {
  name: string;
  description: string;
  cycles: number;
  repeats: number;
  elapsedMs: number;
  cyclesPerSecond: number;
  realtimeFactor: number;
}

export interface BenchmarkOptions {
  cycles?: number;
  repeats?: number;
  only?: string;
  udivmodsi4Region?: Udivmodsi4RegionMode;
}

export function createBenchmarkCases(cyclesOverride?: number): BenchmarkCase[] {
  const cycles = (fallback: number) => cyclesOverride ?? fallback;
  return [
    {
      name: "tight-loop",
      description: "RJMP -1 core dispatch loop",
      cycles: cycles(2_000_000),
      create: () => {
        const avr = AVR();
        avr.cpu.flash[0] = 0xcfff; // rjmp -1
        return avr;
      },
    },
    {
      name: "delay-blink",
      description: "Arduino delay()/millis() Blink fixture",
      cycles: cycles(2_000_000),
      create: () => AVR(delayBlinkHex),
    },
    {
      name: "serial-print",
      description: "Arduino Serial.println fixture",
      cycles: cycles(250_000),
      create: () => AVR(serialPrintHex),
    },
    {
      // Same fixture as serial-print but with a text subscriber attached, so the
      // Phase 5 serial-output path (listener dispatch + chunk handling) is
      // actually exercised. serial-print alone has no onText listener, so its
      // throughput is firmware-bound and cannot show Phase 5 wins/regressions.
      name: "serial-print-listener",
      description: "Arduino Serial.println fixture with an onText subscriber",
      cycles: cycles(250_000),
      create: () => {
        const avr = AVR(serialPrintHex);
        let received = 0;
        avr.serial.onText((text) => {
          received += text.length;
        });
        return avr;
      },
    },
    {
      name: "analog-write",
      description: "Arduino analogWrite PWM fixture",
      cycles: cycles(500_000),
      create: () => AVR(analogWriteHex),
    },
    {
      name: "sensor-format",
      description: "Arduino PROGMEM/math/Serial formatting fixture",
      cycles: cycles(5_000_000),
      create: () => AVR(sensorFormatHex),
    },
    {
      name: "float-math",
      description: "Arduino soft-float math fixture",
      cycles: cycles(5_000_000),
      create: () => AVR(floatMathHex),
    },
    {
      name: "bitbang-crc",
      description: "Arduino bit-banged IO and CRC fixture",
      cycles: cycles(5_000_000),
      create: () => AVR(bitbangCrcHex),
    },
    {
      name: "isr-heavy",
      description: "Arduino Timer1 ISR, software PWM, ADC, GPIO, and PWM fixture",
      cycles: cycles(5_000_000),
      create: () => AVR(isrHeavyHex),
    },
  ];
}

export function runBenchmarkCase(
  testCase: BenchmarkCase,
  repeats = 3,
  udivmodsi4Region: Udivmodsi4RegionMode = "semantic-direct",
): BenchmarkResult {
  const start = nowMs();
  const previousRegion = CPU.udivmodsi4RegionMode;
  CPU.udivmodsi4RegionMode = udivmodsi4Region;
  try {
    for (let i = 0; i < repeats; i += 1) {
      const avr = testCase.create();
      avr.runCycles(testCase.cycles);
    }
  } finally {
    CPU.udivmodsi4RegionMode = previousRegion;
  }
  const elapsedMs = Math.max(0.001, nowMs() - start);
  const totalCycles = testCase.cycles * repeats;
  const cyclesPerSecond = totalCycles / (elapsedMs / 1000);
  return {
    name: testCase.name,
    description: testCase.description,
    cycles: testCase.cycles,
    repeats,
    elapsedMs,
    cyclesPerSecond,
    realtimeFactor: cyclesPerSecond / DEFAULT_CLOCK_HZ,
  };
}

export function runBenchmarks(options: BenchmarkOptions = {}): BenchmarkResult[] {
  const repeats = options.repeats ?? 3;
  const cases = createBenchmarkCases(options.cycles).filter((testCase) => {
    return options.only === undefined || testCase.name === options.only;
  });
  if (cases.length === 0) {
    throw new Error(`Unknown benchmark case "${options.only}".`);
  }
  return cases.map((testCase) =>
    runBenchmarkCase(testCase, repeats, options.udivmodsi4Region ?? "semantic-direct"),
  );
}

function parseArgs(args: string[]): BenchmarkOptions & { json: boolean } {
  const options: BenchmarkOptions & { json: boolean } = { json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--cycles") {
      options.cycles = parsePositiveInt(args[++i], "--cycles");
    } else if (arg === "--repeats") {
      options.repeats = parsePositiveInt(args[++i], "--repeats");
    } else if (arg === "--case") {
      options.only = args[++i];
    } else if (arg === "--udivmodsi4-region") {
      options.udivmodsi4Region = parseUdivmodsi4RegionMode(args[++i]);
    } else {
      throw new Error(`Unknown benchmark argument "${arg}".`);
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

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer, got ${value}.`);
  }
  return parsed;
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function printResults(results: BenchmarkResult[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }

  console.log("avrts benchmark");
  for (const result of results) {
    console.log(
      [
        result.name.padEnd(13),
        `${Math.round(result.cyclesPerSecond).toLocaleString()} cycles/s`.padStart(20),
        `${result.realtimeFactor.toFixed(2)}x realtime`.padStart(16),
        `${result.elapsedMs.toFixed(1)} ms`.padStart(12),
      ].join("  "),
    );
  }
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    printResults(runBenchmarks(options), options.json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
