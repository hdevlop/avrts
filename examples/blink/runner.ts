import { AVR } from "../../src";

const blinkHex = await Bun.file(new URL("./blink.hex", import.meta.url)).text();
const avr = AVR(blinkHex);

avr.pin(13).onChange((high) => {
  console.log(high ? "LED ON" : "LED OFF");
});

avr.runCycles(16);
