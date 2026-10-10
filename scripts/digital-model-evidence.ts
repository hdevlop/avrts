import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { AVR } from "../src";

const hexPath = "examples/timer2-sync-probe/timer2-sync-probe.hex";
const hex = readFileSync(hexPath, "utf8");
const modes = ["fast", "cycle-exact"] as const;
const avrts = modes.map((timing) => {
  const avr = AVR({ hex, timing });
  avr.runCycles(100_000);
  const result = [...avr.cpu.data.slice(0x300, 0x308)];
  const expected = [0xa7, 2, 0, 3, 2, 3, 0, 0x5c];
  if (JSON.stringify(result) !== JSON.stringify(expected)) throw new Error(`${timing}: asynchronous probe differs: ${result}`);
  return { timing, cycles: avr.cpu.cycles, result };
});
const command = [process.execPath, "scripts/simavr-oracle.ts", "--hex", hexPath,
  "--cycles", "100000", "--until-result", "0x300:8:0xa7:0x5c", "--dump", "result:0x300:8", "--json"];
const run = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
if (run.exitCode) throw new Error(run.stderr.toString());
const native = JSON.parse(run.stdout.toString());
if (!native.completed) throw new Error("Native asynchronous probe did not complete.");
const report = {
  scope: "Compiled Timer2 async handshake; native discrepancies remain raw, not normalized",
  firmware: { path: hexPath, sha256: createHash("sha256").update(hex).digest("hex") },
  command, avrts, native,
  policy: "PSRASY stays set until next source edge; no physical latency calibration is claimed",
  differences: avrts[0]!.result.flatMap((value, offset) => native.dumps.result[offset] === value ? []
    : [{ offset, avrts: value, native: native.dumps.result[offset] }]),
};
const outputIndex = Bun.argv.indexOf("--output");
if (outputIndex >= 0) {
  const path = Bun.argv[outputIndex + 1];
  if (!path) throw new Error("--output requires a path");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
