/**
 * Construction/setup benchmark, not a CPU-throughput benchmark.
 *
 * This isolates fixture creation cost (HEX load, CPU/peripheral setup, Decoder
 * construction/cache setup) so short-run throughput numbers do not hide startup
 * noise inside simulated cycles/second.
 */
import { createBenchmarkCases, type BenchmarkCase } from "./benchmark";

interface StartupOptions {
  repeats: number;
  only?: string;
  json: boolean;
}

interface StartupResult {
  name: string;
  description: string;
  repeats: number;
  bestMs: number;
  avgMs: number;
}

function parseArgs(args: string[]): StartupOptions {
  const options: StartupOptions = { repeats: 100, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repeats") {
      options.repeats = parsePositiveInt(args[++i], "--repeats");
    } else if (arg === "--case") {
      options.only = args[++i];
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown startup benchmark argument "${arg}".`);
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

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function measureStartup(testCase: BenchmarkCase, repeats: number): StartupResult {
  let bestMs = Number.POSITIVE_INFINITY;
  let totalMs = 0;
  for (let i = 0; i < repeats; i += 1) {
    const start = nowMs();
    const avr = testCase.create();
    // Touch the CPU so bundlers/runtimes cannot prove the freshly-created object
    // unused in a future optimization pass.
    if (avr.cpu.flash.length === 0) throw new Error("unexpected empty flash");
    const elapsedMs = Math.max(0.001, nowMs() - start);
    bestMs = Math.min(bestMs, elapsedMs);
    totalMs += elapsedMs;
  }
  return {
    name: testCase.name,
    description: testCase.description,
    repeats,
    bestMs,
    avgMs: totalMs / repeats,
  };
}

function runStartupBenchmarks(options: StartupOptions): StartupResult[] {
  const cases = createBenchmarkCases().filter((testCase) => {
    return options.only === undefined || testCase.name === options.only;
  });
  if (cases.length === 0) throw new Error(`Unknown benchmark case "${options.only}".`);
  return cases.map((testCase) => measureStartup(testCase, options.repeats));
}

function printResults(results: StartupResult[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }

  console.log("avrts startup benchmark");
  const head = `${"fixture".padEnd(24)}${"repeats".padStart(10)}${"best".padStart(12)}${"avg".padStart(12)}`;
  console.log(head);
  console.log("-".repeat(head.length));
  for (const result of results) {
    console.log(
      `${result.name.padEnd(24)}${String(result.repeats).padStart(10)}${`${result.bestMs.toFixed(3)} ms`.padStart(12)}${`${result.avgMs.toFixed(3)} ms`.padStart(12)}`,
    );
  }
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    printResults(runStartupBenchmarks(options), options.json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
