import { AVR } from "../../src";

const avr = AVR("./blink.hex");

avr.pin(13).onChange((high) => {
  console.log(high ? "LED ON" : "LED OFF");
});

avr.runCycles(16);
