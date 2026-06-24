import { CPU } from "../src/cpu";
import { GENERATED_FAST_CORE_METHOD_NAME } from "../src/cpu/generated/fast-core";
import {
  createBenchmarkCases,
  runBenchmarkCase,
  type BenchmarkCase,
  type BenchmarkOptions,
} from "./benchmark";

type RunFast = (this: CPU, target: number) => void;

interface GeneratedBenchmarkOptions extends BenchmarkOptions {
  repeats: number;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer, got ${value}.`);
  }
  return parsed;
}

function parseArgs(args: string[]): GeneratedBenchmarkOptions {
  const options: GeneratedBenchmarkOptions = { repeats: 3 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cycles") {
      options.cycles = parsePositiveInt(args[++i], "--cycles");
    } else if (arg === "--repeats") {
      options.repeats = parsePositiveInt(args[++i], "--repeats");
    } else if (arg === "--case") {
      options.only = args[++i];
    } else {
      throw new Error(`Unknown benchmark-generated-fast-core argument "${arg}".`);
    }
  }
  return options;
}

function withHandwrittenFastCore<T>(fn: () => T): T {
  const prototype = CPU.prototype as unknown as Record<string, RunFast>;
  const original = prototype[GENERATED_FAST_CORE_METHOD_NAME];
  const handwritten = prototype.runFast;
  if (original === undefined) throw new Error("missing generated fast core method");
  prototype[GENERATED_FAST_CORE_METHOD_NAME] = handwritten;
  try {
    return fn();
  } finally {
    prototype[GENERATED_FAST_CORE_METHOD_NAME] = original;
  }
}

function best(testCase: BenchmarkCase, repeats: number, generated: boolean): number {
  let top = 0;
  for (let i = 0; i < repeats; i += 1) {
    const result = generated
      ? runBenchmarkCase(testCase, 1)
      : withHandwrittenFastCore(() => runBenchmarkCase(testCase, 1));
    top = Math.max(top, result.cyclesPerSecond);
  }
  return top;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function main(): void {
  const options = parseArgs(Bun.argv.slice(2));
  const cases = createBenchmarkCases(options.cycles).filter((testCase) => {
    return options.only === undefined || testCase.name === options.only;
  });
  if (cases.length === 0) throw new Error(`Unknown benchmark case "${options.only}".`);

  console.log(`handwritten vs generated fast core  (best of ${options.repeats})\n`);
  const head = `${"workload".padEnd(22)}${"cycles".padStart(12)}${"handwritten".padStart(16)}${"generated".padStart(16)}${"generated/base".padStart(16)}`;
  console.log(head);
  console.log("-".repeat(head.length));
  for (const testCase of cases) {
    const handwritten = best(testCase, options.repeats, false);
    const generated = best(testCase, options.repeats, true);
    const ratio = handwritten === 0 ? 0 : generated / handwritten;
    console.log(
      `${testCase.name.padEnd(22)}${fmt(testCase.cycles).padStart(12)}${(fmt(handwritten) + "/s").padStart(16)}${(fmt(generated) + "/s").padStart(16)}${`${ratio.toFixed(2)}x`.padStart(16)}`,
    );
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
