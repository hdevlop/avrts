import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  comparePeripheralMix, compareIsrHeavy, compareStringHeavy, compareDspFixed,
  comparePeripheralBound, compareFloatMath, compareBitbangCrc, compareSensorFormat,
  compareSerialPrint, compareAnalogWrite, compareDelayBlink, compareTightLoop,
} from "./benchmark-results";

// Capture both references with identical tracked firmware; never turn native
// normalizations or unavailable traces into an assertion of physical equality.
const cases = [
  ["peripheral-mix", "arduino-peripheral-mix", comparePeripheralMix],
  ["isr-heavy", "arduino-isr-heavy", compareIsrHeavy],
  ["string-heavy", "arduino-string-heavy", compareStringHeavy],
  ["dsp-fixed", "arduino-dsp-fixed", compareDspFixed],
  ["peripheral-bound", "arduino-peripheral-bound", comparePeripheralBound],
  ["float-math", "arduino-float-math", compareFloatMath],
  ["bitbang-crc", "arduino-bitbang-crc", compareBitbangCrc],
  ["sensor-format", "arduino-sensor-format", compareSensorFormat],
  ["serial-print", "arduino-serial-print", compareSerialPrint],
  ["analog-write", "arduino-analog-write", compareAnalogWrite],
  ["delay-blink", "delay-blink", compareDelayBlink],
  ["tight-loop", "tight-loop", compareTightLoop],
] as const;

const output = Bun.argv[2];
if (!output || Bun.argv.length !== 3) throw new Error("Usage: bun scripts/workload-result-evidence.ts OUTPUT.json");
const rows = [];
for (const [name, fixture, compare] of cases) {
  const command = [process.execPath, "scripts/simavr-oracle.ts", "--result-case", name, "--json"];
  const processResult = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (processResult.exitCode) throw new Error(`${name}: ${processResult.stderr.toString()}`);
  const native = JSON.parse(processResult.stdout.toString());
  const peer = compare();
  const hexPath = `examples/${fixture}/${fixture}${name === "tight-loop" ? "" : ".ino"}.hex`;
  const sha256 = createHash("sha256").update(readFileSync(hexPath)).digest("hex");
  rows.push({ name, hexPath, sha256, command, peer, native });
  console.log(`${name}: avr8js=${peer.pass}, native=${native.pass}`);
}
writeFileSync(output, JSON.stringify({ capturedAt: new Date().toISOString(), runtime: Bun.version,
  activity: "finite correctness observations; not throughput measurements", rows }, null, 2) + "\n");
if (rows.some(({ peer, native }) => !peer.pass || !native.pass)) process.exit(1);
