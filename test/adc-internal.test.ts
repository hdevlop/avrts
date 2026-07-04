import { describe, expect, test } from "bun:test";
import { AVR } from "../src";

// Phase 4 Arduino validation: the raw-register form of analogRead(TEMPERATURE).
// A real sketch reads the on-chip temperature sensor (MUX = 1000, internal
// 1.1 V reference) and the bandgap channel (MUX = 1110, AVcc reference) by hand
// through ADMUX/ADCSRA and busy-waits on ADSC. This exercises the internal-ADC
// channel model end to end. The result block at SRAM 0x0300 is
// [marker, tempLo, tempHi, bandgapLo, bandgapHi, marker].

const BANDGAP_AGAINST_AVCC = Math.round((1.1 / 5) * 1023); // 225.

async function loadAdc(temperatureRaw: number): Promise<ReturnType<typeof AVR>> {
  const hex = await Bun.file(
    new URL("../examples/arduino-adc-internal/arduino-adc-internal.ino.hex", import.meta.url),
  ).text();
  const avr = AVR(hex);
  avr.analog(8).setValue(temperatureRaw); // host-supplied temperature sample.
  return avr;
}

function temperature(avr: ReturnType<typeof AVR>): number {
  return avr.cpu.data[0x0301]! | (avr.cpu.data[0x0302]! << 8);
}

function bandgap(avr: ReturnType<typeof AVR>): number {
  return avr.cpu.data[0x0303]! | (avr.cpu.data[0x0304]! << 8);
}

describe("Internal ADC channel Arduino sketch", () => {
  test("reads the host-set temperature sensor value and the bandgap reference", async () => {
    const avr = await loadAdc(370);
    avr.runCycles(300_000); // setup() samples both channels and publishes.

    expect(avr.cpu.data[0x0300]).toBe(0xa7); // start marker.
    expect(avr.cpu.data[0x0305]).toBe(0x5c); // end marker.
    expect(temperature(avr)).toBe(370);
    expect(bandgap(avr)).toBe(BANDGAP_AGAINST_AVCC);
  });

  test("tracks a different host-set temperature sample", async () => {
    const cold = await loadAdc(289);
    cold.runCycles(300_000);
    expect(temperature(cold)).toBe(289);

    const hot = await loadAdc(512);
    hot.runCycles(300_000);
    expect(temperature(hot)).toBe(512);

    // The bandgap read is independent of the temperature channel.
    expect(bandgap(cold)).toBe(BANDGAP_AGAINST_AVCC);
    expect(bandgap(hot)).toBe(BANDGAP_AGAINST_AVCC);
  });
});
