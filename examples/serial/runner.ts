import { AVR } from "../../src";

const helloHex = await Bun.file(new URL("./hello.hex", import.meta.url)).text();
const avr = AVR(helloHex);

avr.serial.onText((text) => {
  process.stdout.write(text);
});

avr.runCycles(9);
