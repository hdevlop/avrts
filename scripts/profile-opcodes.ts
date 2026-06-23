import { Decoder, type ProfileRunState } from "../src/cpu";
import { createBenchmarkCases, type BenchmarkCase } from "./benchmark";

type ProfileMode = "opcode" | "pc" | "fast";

interface ProfileRow {
  pc?: number;
  opcode: number;
  mnemonic: string;
  count: number;
  cycles: number;
  kind?: ProfileRunState["kind"];
  blockKind?: ProfileRunState["blockKind"];
  window?: string;
}

interface ProfileOptions {
  cycles?: number;
  only?: string;
  top: number;
  mode: ProfileMode;
  window: number;
}

function parseArgs(args: string[]): ProfileOptions {
  const options: ProfileOptions = { top: 20, mode: "opcode", window: 0 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--cycles") {
      options.cycles = parsePositiveInt(args[++i], "--cycles");
    } else if (arg === "--case") {
      options.only = args[++i];
    } else if (arg === "--top") {
      options.top = parsePositiveInt(args[++i], "--top");
    } else if (arg === "--mode") {
      options.mode = parseMode(args[++i]);
    } else if (arg === "--window") {
      options.window = parsePositiveInt(args[++i], "--window");
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

function parseMode(value: string | undefined): ProfileMode {
  if (value === "opcode" || value === "pc" || value === "fast") return value;
  throw new Error(`--mode expects opcode, pc, or fast, got ${value}.`);
}

function profileCase(
  testCase: BenchmarkCase,
  decoder: Decoder,
  options: ProfileOptions,
): ProfileRow[] {
  if (options.mode === "fast") return profileFastCase(testCase, decoder, options.window);
  return profileTickCase(testCase, decoder, options.mode, options.window);
}

function profileTickCase(
  testCase: BenchmarkCase,
  decoder: Decoder,
  mode: Exclude<ProfileMode, "fast">,
  window: number,
): ProfileRow[] {
  const avr = testCase.create();
  const rows = new Map<string, ProfileRow>();
  const target = avr.cpu.cycles + testCase.cycles;
  while (avr.cpu.cycles < target) {
    const pc = avr.cpu.pc;
    const opcode = avr.cpu.flash[pc]!;
    const before = avr.cpu.cycles;
    avr.cpu.tick();
    const key = mode === "pc" ? `${pc}:${opcode}` : `${opcode}`;
    addRow(rows, key, {
      pc: mode === "pc" ? pc : undefined,
      opcode,
      mnemonic: decoder.mnemonicOf(opcode) ?? "UNKNOWN",
      cycles: avr.cpu.cycles - before,
    });
  }
  return finalizeRows(rows, avr.cpu.flash, decoder, window);
}

function profileFastCase(
  testCase: BenchmarkCase,
  decoder: Decoder,
  window: number,
): ProfileRow[] {
  const avr = testCase.create();
  const rows = new Map<string, ProfileRow>();
  avr.cpu.profileRun(testCase.cycles, (event) => {
    const block = event.blockKind ?? "";
    const key = `${event.kind}:${block}:${event.pc}:${event.opcode}`;
    addRow(rows, key, {
      pc: event.pc,
      opcode: event.opcode,
      mnemonic: event.mnemonic,
      cycles: event.elapsedCycles,
      kind: event.kind,
      blockKind: event.blockKind,
    });
  });
  return finalizeRows(rows, avr.cpu.flash, decoder, window);
}

function addRow(
  rows: Map<string, ProfileRow>,
  key: string,
  event: Omit<ProfileRow, "count" | "window">,
): void {
  const row = rows.get(key);
  if (row === undefined) {
    rows.set(key, { ...event, count: 1 });
    return;
  }
  row.count += 1;
  row.cycles += event.cycles;
}

function finalizeRows(
  rows: Map<string, ProfileRow>,
  flash: Uint16Array,
  decoder: Decoder,
  window: number,
): ProfileRow[] {
  const result = [...rows.values()].sort((a, b) => {
    return b.count - a.count || b.cycles - a.cycles || (a.pc ?? 0) - (b.pc ?? 0) || a.opcode - b.opcode;
  });
  if (window > 0) {
    for (const row of result) {
      if (row.pc !== undefined) row.window = formatWindow(flash, row.pc, decoder, window);
    }
  }
  return result;
}

function formatWindow(
  flash: Uint16Array,
  pc: number,
  decoder: Decoder,
  words: number,
): string {
  const parts: string[] = [];
  for (let offset = 0; offset < words && pc + offset < flash.length; offset += 1) {
    const wordPc = pc + offset;
    const opcode = flash[wordPc]!;
    parts.push(`${pcHex(wordPc)}:${decoder.mnemonicOf(opcode) ?? "???"}(${opcodeHex(opcode)})`);
  }
  return parts.join(" ");
}

function opcodeHex(opcode: number): string {
  return `0x${opcode.toString(16).padStart(4, "0")}`;
}

function pcHex(pc: number): string {
  return `0x${pc.toString(16).padStart(4, "0")}`;
}

function printRows(testCase: BenchmarkCase, rows: ProfileRow[], options: ProfileOptions): void {
  const totalEvents = rows.reduce((sum, row) => sum + row.count, 0);
  const totalCycles = rows.reduce((sum, row) => sum + row.cycles, 0);
  console.log(
    `\n${testCase.name} (${totalEvents.toLocaleString()} events, ${totalCycles.toLocaleString()} cycles sampled, mode=${options.mode})`,
  );
  if (options.mode === "opcode") {
    console.log(
      `${"opcode".padEnd(8)}${"mnemonic".padEnd(12)}${"count".padStart(12)}${"cycles".padStart(12)}${"events".padStart(10)}${"cycle%".padStart(10)}`,
    );
    console.log("-".repeat(64));
  } else {
    console.log(
      `${"pc".padEnd(8)}${"opcode".padEnd(8)}${"mnemonic".padEnd(12)}${"kind".padEnd(13)}${"block".padEnd(16)}${"count".padStart(12)}${"cycles".padStart(12)}${"events".padStart(10)}${"cycle%".padStart(10)}`,
    );
    console.log("-".repeat(103));
  }

  for (const row of rows.slice(0, options.top)) {
    const eventShare = totalEvents === 0 ? 0 : row.count / totalEvents;
    const cycleShare = totalCycles === 0 ? 0 : row.cycles / totalCycles;
    if (options.mode === "opcode") {
      console.log(
        `${opcodeHex(row.opcode).padEnd(8)}${row.mnemonic.padEnd(12)}${row.count
          .toLocaleString()
          .padStart(12)}${row.cycles.toLocaleString().padStart(12)}${`${(eventShare * 100).toFixed(1)}%`.padStart(10)}${`${(cycleShare * 100).toFixed(1)}%`.padStart(10)}`,
      );
    } else {
      console.log(
        `${pcHex(row.pc ?? 0).padEnd(8)}${opcodeHex(row.opcode).padEnd(8)}${row.mnemonic.padEnd(12)}${(row.kind ?? "instruction").padEnd(13)}${(row.blockKind ?? "").padEnd(16)}${row.count
          .toLocaleString()
          .padStart(12)}${row.cycles.toLocaleString().padStart(12)}${`${(eventShare * 100).toFixed(1)}%`.padStart(10)}${`${(cycleShare * 100).toFixed(1)}%`.padStart(10)}`,
      );
    }
    if (row.window !== undefined) console.log(`  ${row.window}`);
  }
}

function main(): void {
  const options = parseArgs(Bun.argv.slice(2));
  const cases = createBenchmarkCases(options.cycles).filter((testCase) => {
    return options.only === undefined || testCase.name === options.only;
  });
  if (cases.length === 0) throw new Error(`Unknown benchmark case "${options.only}".`);

  const decoder = new Decoder();
  for (const testCase of cases) {
    printRows(testCase, profileCase(testCase, decoder, options), options);
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
