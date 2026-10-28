import { AVR } from "../../src";

const avr = AVR("examples/serial/hello.hex");

avr.serial.onText((text) => {
  process.stdout.write(text);
});

avr.runCycles(9);
