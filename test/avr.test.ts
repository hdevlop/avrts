import { expect, test } from "bun:test";
import { AVR, DDRB, IntelHexError, PINB, PORTB, TXEN0, UCSR0B, UDR0 } from "../src";
import { DEFAULT_USART_FRAME_CYCLES } from "./helpers";

function transmitByte(avr: ReturnType<typeof AVR>, byte: number): void {
  avr.cpu.writeData(UDR0, byte);
  avr.runCycles(DEFAULT_USART_FRAME_CYCLES);
}

test("AVR() constructs with ATmega328P defaults", () => {
  const status = AVR().status();
  expect(status.chip).toBe("atmega328p");
  expect(status.clockHz).toBe(16_000_000);
  expect(status.programLoaded).toBe(false);
  expect(status.running).toBe(false);
});

test("AVR(string) records a loaded program", () => {
  const avr = AVR(":00000001FF");
  expect(avr.status().programLoaded).toBe(true);
});

test("AVR(options) applies chip and clock", () => {
  const avr = AVR({ hex: ":00000001FF", chip: "atmega328p", clockHz: 8_000_000 });
  const status = avr.status();
  expect(status.clockHz).toBe(8_000_000);
  expect(status.programLoaded).toBe(true);
});

test("fluent setup chains", () => {
  const avr = AVR().useChip("atmega328p").useClock(8_000_000).useHex(":00000001FF");
  expect(avr.status().clockHz).toBe(8_000_000);
});

test("AVR({ hex }) loads program bytes into flash", () => {
  // :02 0000 00 0C94 -> flash[0] = 0x940C (little-endian word)
  const avr = AVR({ hex: ":020000000C945E\n:00000001FF\n" });
  expect(avr.cpu.flash[0]).toBe(0x940c);
});

test("end-to-end: load a hex program and run it", () => {
  // ldi r16, 0x2A (0xE20A) ; rjmp -1 (0xCFFF)
  const avr = AVR(":040000000AE2FFCF42\n:00000001FF\n");
  avr.runCycles(5);
  expect(avr.cpu.data[16]).toBe(0x2a);
});

test("exposes the CPU as a low-level escape hatch", () => {
  const avr = AVR();
  expect(avr.cpu.flash.length).toBe(0x4000);
});

test("useHex clears stale flash before loading a new program", () => {
  const avr = AVR(":020000000C945E\n:00000001FF\n");
  expect(avr.cpu.flash[0]).toBe(0x940c);
  avr.useHex(":00000001FF");
  expect(avr.cpu.flash[0]).toBe(0x0000);
});

test("useHex leaves the previous program intact when parsing fails", () => {
  const first = ":040000000AE2FFCF42\n:00000001FF\n";
  const avr = AVR(first);

  expect(() => avr.useHex(":020000000C945F\n:00000001FF\n")).toThrow(IntelHexError);
  expect(avr.cpu.flash[0]).toBe(0xe20a);
  expect(avr.status().programLoaded).toBe(true);

  avr.runCycles(1);
  expect(avr.cpu.data[16]).toBe(0x2a);
});

test("failed useHex does not emit load", () => {
  const avr = AVR();
  let loadEvents = 0;
  avr.on("load", () => {
    loadEvents += 1;
  });

  expect(() => avr.useHex(":0200000ZZZ9999\n")).toThrow(IntelHexError);
  expect(loadEvents).toBe(0);
  expect(avr.status().programLoaded).toBe(false);
});

test("facade pin(13) observes PB5 output toggles from a loaded program", () => {
  const avr = AVR(":0E00000000E204B900E205B900E005B9FFCF47\n:00000001FF\n");
  const pinEvents: boolean[] = [];
  const portEvents: Array<[number, number]> = [];

  avr.pin(13).onChange((high) => pinEvents.push(high));
  avr.gpio.port("B").onChange((value, oldValue) => portEvents.push([oldValue, value]));

  avr.runCycles(6);

  expect(pinEvents).toEqual([true, false]);
  expect(portEvents).toEqual([[0x00, 0x20], [0x20, 0x00]]);
  expect(avr.pin(13).read()).toBe(false);
});

test("pins.onChange observes pin changes without a pin-specific listener", () => {
  const avr = AVR(":0E00000000E204B900E205B900E005B9FFCF47\n:00000001FF\n");
  const seen: boolean[] = [];

  avr.pins.onChange((event) => {
    if (event.pin === 13) seen.push(event.high);
  });
  avr.runCycles(6);

  expect(seen).toEqual([true, false]);
});

test("pin input simulation drives input pins", () => {
  const avr = AVR();
  const seen: boolean[] = [];

  avr.pin(2).onChange((high) => seen.push(high));
  avr.pin(2).setInput(true);
  avr.pin(2).setInput(false);

  expect(seen).toEqual([true, false]);
  expect(avr.pin(2).read()).toBe(false);
});

test("writing a 1 to PINx toggles the PORTx output latch", () => {
  const avr = AVR();

  avr.cpu.writeData(DDRB, 0x20);
  avr.cpu.writeData(PINB, 0x20);

  expect(avr.cpu.readData(PORTB)).toBe(0x20);
  // PB5 is a driven-high output, so reading PINx reflects that effective level.
  expect(avr.cpu.readData(PINB)).toBe(0x20);
});

test("frame advances simulated time using speed", () => {
  const avr = AVR({ clockHz: 1_000 });

  avr.frame(5);
  expect(avr.status().cycles).toBe(5);

  avr.setSpeed(10).frame(2);
  expect(avr.status().cycles).toBe(25);
  expect(avr.status().speed).toBe(10);
});

test("serial text decodes multi-byte UTF-8 output; onByte stays raw", () => {
  const avr = AVR();
  avr.cpu.writeData(UCSR0B, 1 << TXEN0);
  const chunks: string[] = [];
  const rawBytes: number[] = [];
  avr.serial.onText((text) => chunks.push(text));
  avr.serial.onByte((byte) => rawBytes.push(byte));

  const encoded = new TextEncoder().encode("T=25°C é");
  for (const byte of encoded) transmitByte(avr, byte);

  expect(avr.serial.getText()).toBe("T=25°C é");
  expect(chunks.join("")).toBe("T=25°C é");
  // Multi-byte characters arrive whole, never as partial-sequence chunks.
  expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
  expect(rawBytes).toEqual([...encoded]);
});

test("serial.clear() drops a buffered partial UTF-8 sequence", () => {
  const avr = AVR();
  avr.cpu.writeData(UCSR0B, 1 << TXEN0);

  transmitByte(avr, 0xc3); // first byte of a 2-byte sequence ("é")
  expect(avr.serial.getText()).toBe("");
  avr.serial.clear();

  transmitByte(avr, 0x41); // "A"
  expect(avr.serial.getText()).toBe("A");
});

test("invalid serial bytes decode to U+FFFD without derailing later text", () => {
  const avr = AVR();
  avr.cpu.writeData(UCSR0B, 1 << TXEN0);

  transmitByte(avr, 0xff); // never valid in UTF-8
  transmitByte(avr, 0x41); // "A"

  expect(avr.serial.getText()).toBe("�A");
});

test("useClock rejects invalid clock rates", () => {
  const avr = AVR();

  expect(() => avr.useClock(0)).toThrow("positive finite number");
  expect(() => avr.useClock(-16_000_000)).toThrow("positive finite number");
  expect(() => avr.useClock(NaN)).toThrow("positive finite number");
  expect(() => avr.use({ clockHz: 0 })).toThrow("positive finite number");

  avr.use({ clockHz: 8_000_000 });
  expect(avr.status().clockHz).toBe(8_000_000);
});

test("start, pause, resume, and stop update runtime status and events", () => {
  const avr = AVR();
  const events: string[] = [];

  avr.on("start", (event) => events.push(event.type));
  avr.on("pause", (event) => events.push(event.type));
  avr.on("resume", (event) => events.push(event.type));
  avr.on("stop", (event) => events.push(event.type));

  avr.start();
  expect(avr.status().running).toBe(true);
  expect(avr.status().paused).toBe(false);

  avr.pause();
  expect(avr.status().running).toBe(true);
  expect(avr.status().paused).toBe(true);

  avr.resume();
  expect(avr.status().running).toBe(true);
  expect(avr.status().paused).toBe(false);

  avr.stop();
  expect(avr.status().running).toBe(false);
  expect(avr.status().paused).toBe(false);
  expect(events).toEqual(["start", "pause", "resume", "stop"]);
});

test("load aliases, reload, clearProgram, and loadFile cover UI loading flows", async () => {
  const avr = AVR();
  const first = ":020000000C945E\n:00000001FF\n";
  const second = ":0200000034E0EA\n:00000001FF\n";

  avr.loadHex(first);
  expect(avr.cpu.flash[0]).toBe(0x940c);
  expect(avr.status().programLoaded).toBe(true);

  avr.cpu.flash[0] = 0;
  avr.reload();
  expect(avr.cpu.flash[0]).toBe(0x940c);

  avr.load({ hex: second });
  expect(avr.cpu.flash[0]).toBe(0xe034);

  avr.clearProgram();
  expect(avr.cpu.flash[0]).toBe(0);
  expect(avr.status().programLoaded).toBe(false);

  await avr.loadFile({ text: async () => first });
  expect(avr.cpu.flash[0]).toBe(0x940c);
  expect(avr.status().programLoaded).toBe(true);
});

test("reset can clear or preserve a loaded program", () => {
  const avr = AVR(":020000000C945E\n:00000001FF\n");

  avr.reset();
  expect(avr.cpu.flash[0]).toBe(0x940c);
  expect(avr.status().programLoaded).toBe(true);

  avr.reset({ clearProgram: true });
  expect(avr.cpu.flash[0]).toBe(0);
  expect(avr.status().programLoaded).toBe(false);
});

test("pin pulse raises input, advances simulated time, then lowers it", () => {
  const avr = AVR({ clockHz: 1_000 });
  const seen: boolean[] = [];

  avr.pin(2).onChange((high) => seen.push(high));
  avr.pin(2).pulse(3);

  expect(seen).toEqual([true, false]);
  expect(avr.status().cycles).toBe(3);
  expect(avr.pin(2).read()).toBe(false);
});

test("connect and disconnect manage component adapters", () => {
  const avr = AVR();
  const calls: string[] = [];
  const component = {
    attach: () => calls.push("attach"),
    detach: () => calls.push("detach"),
  };

  avr.connect(component).connect(component);
  avr.disconnect(component).disconnect(component);

  expect(calls).toEqual(["attach", "detach"]);
});
