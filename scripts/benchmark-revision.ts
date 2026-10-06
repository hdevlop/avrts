import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Compare two revisions on the same machine, with one fresh Bun process per
// revision/workload. Setup is excluded and warm-up precedes timed execution.
// bun scripts/benchmark-revision.ts --baseline PATH --output FILE [--case NAME]
const fixtures: Record<string, string> = {
  "delay-blink": "delay-blink",
  "serial-print": "arduino-serial-print",
  "analog-write": "arduino-analog-write",
  "sensor-format": "arduino-sensor-format",
  "float-math": "arduino-float-math",
  "bitbang-crc": "arduino-bitbang-crc",
  "peripheral-mix": "arduino-peripheral-mix",
  "isr-heavy": "arduino-isr-heavy",
  "string-heavy": "arduino-string-heavy",
  "dsp-fixed": "arduino-dsp-fixed",
  "timer2-rtc": "arduino-timer2-rtc",
  "peripheral-bound": "arduino-peripheral-bound",
};
const args = Bun.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`Missing ${name} value`);
  return args[index + 1]!;
};
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

if (args[0] === "--child") {
  const revision = resolve(args[1]!);
  const name = args[2]!;
  const fixtureRoot = resolve(args[3] ?? revision);
  if (!(name in fixtures)) throw new Error(`Unknown workload ${name}`);
  const { AVR } = await import(pathToFileURL(join(revision, "src/index.ts")).href);
  const fixture = fixtures[name]!;
  const hex = readFileSync(join(fixtureRoot, `examples/${fixture}/${fixture}.ino.hex`), "utf8");
  const cycles = 50_000_000;
  const samples: number[] = [];
  const elapsedMs: number[] = [];
  for (let trial = 0; trial < 10; trial++) {
    const avr = AVR(hex);
    avr.runCycles(500_000);
    const start = performance.now();
    avr.runCycles(cycles);
    const ms = performance.now() - start;
    if (trial > 0) {
      samples.push(cycles / (ms / 1000));
      elapsedMs.push(ms);
    }
  }
  console.log(JSON.stringify({ cycles, samples, elapsedMs, median: median(samples) }));
} else {
  if (!args.includes("--baseline")) throw new Error("Pass --baseline PATH to a checkout of the comparison revision");
  const baseline = resolve(option("--baseline")!);
  const candidate = resolve(import.meta.dir, "..");
  const names = Object.keys(fixtures).filter(name => !args.includes("--case") || name === option("--case"));
  if (names.length === 0) throw new Error("Unknown --case workload");
  const rows = [];
  for (const [index, name] of names.entries()) {
    const order = index % 2 === 0 ? [baseline, candidate] : [candidate, baseline];
    const outcomes = new Map<string, { cycles: number; samples: number[]; elapsedMs: number[]; median: number }>();
    for (const revision of order) {
      // Hold firmware constant even when a fixture was rebuilt since baseline.
      const processResult = Bun.spawnSync([process.execPath, import.meta.path, "--child", revision, name, candidate], { stdout: "pipe", stderr: "pipe" });
      if (processResult.exitCode !== 0) throw new Error(processResult.stderr.toString());
      outcomes.set(revision, JSON.parse(processResult.stdout.toString()));
    }
    const before = outcomes.get(baseline)!;
    const after = outcomes.get(candidate)!;
    const row = { name, cycles: after.cycles, baseline: before, candidate: after, changePercent: (after.median / before.median - 1) * 100 };
    rows.push(row);
    console.log(`${name}: baseline ${(before.median / 1e6).toFixed(2)} Mcycles/s; current ${(after.median / 1e6).toFixed(2)} Mcycles/s; ${row.changePercent.toFixed(1)}%`);
  }
  const result = { runtime: Bun.version, baseline, candidate, fixtureRoot: candidate, trials: 9, warmupCycles: 500_000, includesConstruction: false, rows };
  if (args.includes("--output")) await Bun.write(resolve(option("--output")!), JSON.stringify(result, null, 2) + "\n");
}
