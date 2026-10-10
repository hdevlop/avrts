import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AVR } from "../src";

export function runRuntimeFixture(name: string, timing: "fast" | "cycle-exact" = "cycle-exact") {
  const hex = readFileSync(`examples/${name}/${name}.hex`, "utf8");
  const avr = AVR({ hex, timing });
  const budget = name === "timer1-top" ? 2_000_000 : 300_000;
  while (avr.cpu.cycles < budget && avr.cpu.data[0x314] !== 0x5c) avr.runCycles(1000);
  return { completed: avr.cpu.data[0x300] === 0xa7 && avr.cpu.data[0x314] === 0x5c,
    cycles: avr.cpu.cycles, result: [...avr.cpu.data.slice(0x300, 0x315)] };
}

export function validateProgrammingTiming(result: number[]): string[] {
  const errors: string[] = [];
  if (result.length !== 21 || result[0] !== 0xa7 || result[19] !== 0x60 || result[20] !== 0x5c) errors.push("missing programming result");
  if (result[4] !== 0x5a || result[9] !== 0xa5 || result[10] !== 0x5a) errors.push("EEPROM or flash data differs");
  if (result[1] !== 2 || result[5] !== 1 || result[8] !== 1) errors.push("programming busy flags missing");
  const eeprom = (result[2] ?? 0) | ((result[3] ?? 0) << 8);
  const flash = (result[6] ?? 0) | ((result[7] ?? 0) << 8);
  if (eeprom < 6800 || eeprom > 6810) errors.push(`EEPROM timer ticks ${eeprom}, expected 6800..6810`);
  if (flash < 8200 || flash > 8210) errors.push(`flash timer ticks ${flash}, expected 8200..8210`);
  return errors;
}

if (import.meta.main) {
  const rows = [];
  for (const name of ["programming-timing", "timer-external-clock", "timer1-top"]) {
    const avrts = runRuntimeFixture(name);
    const fast = runRuntimeFixture(name, "fast");
    const command = [process.execPath, "scripts/simavr-oracle.ts", "--hex", `examples/${name}/${name}.hex`,
      "--cycles", name === "timer1-top" ? "2000000" : "300000", "--until-result", "0x300:21:0xa7:0x5c", "--dump", "result:0x300:21", "--json"];
    const processResult = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    if (processResult.exitCode) throw new Error(processResult.stderr.toString());
    const native = JSON.parse(processResult.stdout.toString());
    const simavr = { completed: native.completed, cycles: native.cycles, result: native.dumps.result as number[] };
    const functionalOffsets = name === "programming-timing" ? [0, 4, 9, 10, 19, 20] : name === "timer1-top" ? [0, 3, 19, 20] : Array.from({length: 21}, (_, i) => i);
    const errors = [];
    if (!avrts.completed || !fast.completed || !simavr.completed) errors.push("completion missing");
    if (JSON.stringify(avrts.result) !== JSON.stringify(fast.result)) errors.push("fast and cycle-exact results differ");
    for (const offset of functionalOffsets) if (avrts.result[offset] !== simavr.result[offset]) errors.push(`native functional byte ${offset} differs`);
    if (name === "programming-timing") errors.push(...validateProgrammingTiming(avrts.result));
    else if (name === "timer1-top") {
      if ((avrts.result[1]! | (avrts.result[2]! << 8)) !== 1000) errors.push("Timer1 fast-PWM TOV must latch at TOP");
    }
    else if (JSON.stringify(avrts.result) !== JSON.stringify([0xa7, 2, 2, 0, 7, 7, ...Array<number>(13).fill(0), 0x61, 0x5c])) errors.push("external counter/flag expectation differs");
    const nativeTimingDifferences = name === "programming-timing" ? validateProgrammingTiming(simavr.result) : name === "timer1-top" && (simavr.result[1]! | (simavr.result[2]! << 8)) !== 1000 ? ["Native Timer1 fast-PWM TOV latches at BOTTOM; datasheet policy remains TOP"] : [];
    const hex = readFileSync(`examples/${name}/${name}.hex`);
    rows.push({ name, command, sha256: createHash("sha256").update(hex).digest("hex"), avrts, fast, simavr,
      functionalOffsets, errors, nativeTimingDifferences, nativeTimingCalibrated: name === "programming-timing" && nativeTimingDifferences.length === 0 });
  }
  const report = { scope: "functional native comparisons and independent avrts runtime timing; native timing deviations remain explicit", rows };
  const output = Bun.argv.indexOf("--output");
  if (output >= 0) {
    const path = Bun.argv[output + 1];
    if (!path) throw new Error("--output expects a filename");
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
  if (rows.some((row) => row.errors.length)) process.exit(1);
}
