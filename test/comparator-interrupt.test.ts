import { describe, expect, test } from "bun:test";
import { AVR } from "../src";

// Phase 4 Arduino validation: a real analog-comparator sketch that arms the
// comparator interrupt on the *rising* output edge (ACIS1:0 = 11) and tallies
// edges in ISR(ANALOG_COMP_vect). Driving the comparator inputs from the host
// exercises the full path — ACO evaluation, edge selection, ACI, and interrupt
// dispatch — end to end through compiled Arduino ISR code. The result block at
// SRAM 0x0300 is [marker, risingEdges, acoInIsr, acoLive, marker].

async function loadComparator(): Promise<ReturnType<typeof AVR>> {
  const hex = await Bun.file(
    new URL(
      "../examples/arduino-comparator-interrupt/arduino-comparator-interrupt.ino.hex",
      import.meta.url,
    ),
  ).text();
  return AVR(hex);
}

function edges(avr: ReturnType<typeof AVR>): number {
  return avr.cpu.data[0x0301]!;
}

describe("Analog comparator interrupt Arduino sketch", () => {
  test("publishes its result block after setup with no edges seen yet", async () => {
    const avr = await loadComparator();
    avr.runCycles(200_000); // let setup() arm ACIE and publish.

    expect(avr.cpu.data[0x0300]).toBe(0xa7); // start marker.
    expect(avr.cpu.data[0x0304]).toBe(0x5c); // end marker.
    expect(edges(avr)).toBe(0);
  });

  test("counts only rising comparator-output edges and samples ACO in the ISR", async () => {
    const avr = await loadComparator();
    avr.runCycles(200_000);

    avr.comparator.setInput("ain1", 2.5); // fixed negative input.
    avr.comparator.setInput("ain0", 1.0); // below AIN1: ACO low.
    avr.runCycles(2_000);
    expect(edges(avr)).toBe(0);

    avr.comparator.setInput("ain0", 3.0); // rises above AIN1: rising edge #1.
    avr.runCycles(2_000);
    expect(edges(avr)).toBe(1);

    avr.comparator.setInput("ain0", 1.0); // falls back: falling edge, ignored.
    avr.runCycles(2_000);
    expect(edges(avr)).toBe(1);

    avr.comparator.setInput("ain0", 3.0); // rising edge #2.
    avr.runCycles(2_000);
    expect(edges(avr)).toBe(2);

    expect(avr.cpu.data[0x0302]).toBe(1); // ACO sampled high inside the ISR.
    expect(avr.cpu.data[0x0303]).toBe(1); // ACO still high live.
  });

  test("keeps counting across a snapshot/restore of an armed comparator", async () => {
    const source = await loadComparator();
    source.runCycles(200_000);
    source.comparator.setInput("ain1", 2.5);
    source.comparator.setInput("ain0", 3.0); // rising edge #1 before the snapshot.
    source.runCycles(2_000);
    expect(edges(source)).toBe(1);

    const restored = await loadComparator();
    restored.restore(source.snapshot());
    restored.runCycles(2_000);
    expect(edges(restored)).toBe(1); // no phantom edge on restore.

    restored.comparator.setInput("ain0", 0.5); // falling, ignored.
    restored.comparator.setInput("ain0", 3.0); // rising edge #2 after restore.
    restored.runCycles(2_000);
    expect(edges(restored)).toBe(2);
  });
});
