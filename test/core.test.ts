import { afterEach, expect, test } from "bun:test";
import { OnWrite, Op, ioRegistry, opRegistry } from "../src/core";

// @Op/@OnWrite push into shared global registries. Capture the baseline and
// truncate after each test so these decorator demos never pollute the real
// decode table built from InstructionSet.
const opBaseline = opRegistry.length;
const ioBaseline = ioRegistry.length;

afterEach(() => {
  opRegistry.length = opBaseline;
  ioRegistry.length = ioBaseline;
});

test("@Op registers a handler entry (idempotent by method name)", () => {
  class Sample {
    @Op("SAMPLE", 0xffff, 0xffff)
    sample(): void {}
  }
  void new Sample();

  const added = opRegistry.filter((entry) => entry.mnemonic === "SAMPLE");
  expect(added.length).toBe(1);
  expect(added[0]?.key).toBe("sample");
  expect(added[0]?.mask).toBe(0xffff);
});

test("@OnWrite records the data-space address it hooks", () => {
  class Periph {
    @OnWrite(0x25)
    onPortB(): void {}
  }
  void new Periph();

  expect(ioRegistry.some((entry) => entry.addr === 0x25 && entry.key === "onPortB")).toBe(true);
});
