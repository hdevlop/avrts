import { Decoder } from "../src/cpu";
import { createBenchmarkCases } from "./benchmark";

interface ProfileRow {
  opcode: number;
  mnemonic: string;
  count: number;
}

interface ProfileOptions {
  cycles?: number;
  only?: string;
  top: number;
}

function parseArgs(args: string[]): ProfileOptions {
  const options: ProfileOptions = { top: 20 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cycles") {
      options.cycles = parsePositiveInt(args[++i], "--cycles");
    } else if (arg === "--case") {
      options.only = args[++i];
    } else if (arg === "--top") {
      options.top = parsePositiveInt(args[++i], "--top");
    } else {
      throw new Error(`Unknown profile argument "${arg}".`);
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

function profileCase(testCase: ReturnType<typeof createBenchmarkCases>[number], decoder: Decoder): ProfileRow[] {
  const avr = testCase.create();
  const counts = new Map<number, number>();
  const target = avr.cpu.cycles + testCase.cycles;
  while (avr.cpu.cycles < target) {
    const opcode = avr.cpu.flash[avr.cpu.pc]!;
    counts.set(opcode, (counts.get(opcode) ?? 0) + 1);
    avr.cpu.tick();
  }
  return [...counts.entries()]
    .map(([opcode, count]) => ({
      opcode,
      mnemonic: decoder.mnemonicOf(opcode) ?? "UNKNOWN",
      count,
    }))
    .sort((a, b) => b.count - a.count || a.opcode - b.opcode);
}

function opcodeHex(opcode: number): string {
  return `0x${opcode.toString(16).padStart(4, "0")}`;
}

function main(): void {
  const options = parseArgs(Bun.argv.slice(2));
  const cases = createBenchmarkCases(options.cycles).filter((testCase) => {
    return options.only === undefined || testCase.name === options.only;
  });
  if (cases.length === 0) throw new Error(`Unknown benchmark case "${options.only}".`);

  const decoder = new Decoder();
  for (const testCase of cases) {
    const rows = profileCase(testCase, decoder);
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    console.log(`\n${testCase.name} (${total.toLocaleString()} instructions sampled)`);
    console.log(`${"opcode".padEnd(8)}${"mnemonic".padEnd(12)}${"count".padStart(12)}${"share".padStart(10)}`);
    console.log("-".repeat(42));
    for (const row of rows.slice(0, options.top)) {
      const share = total === 0 ? 0 : row.count / total;
      console.log(
        `${opcodeHex(row.opcode).padEnd(8)}${row.mnemonic.padEnd(12)}${row.count
          .toLocaleString()
          .padStart(12)}${`${(share * 100).toFixed(1)}%`.padStart(10)}`,
      );
    }
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
