# Arduino Servo Library

Arduino `Servo` library validation fixture.

The sketch attaches a servo to pin 9 and parks it at an exact 1500 us pulse with
`writeMicroseconds(1500)`. The Servo library times the pulse with Timer1
compare-match interrupts that toggle the pin in software (not hardware PWM), so
the simulator sees pin 9 driven high for the pulse width and refreshed every
20 ms. `test/servo.test.ts` measures the pin-9 high time (1500 us) and the 20 ms
refresh period, exercising Timer1 CTC + GPIO end to end through compiled Servo
library code. The commanded width is echoed to the result block at SRAM `0x0300`.

Needs the `Servo` library (`arduino-cli lib install Servo`). Regenerate with
`bun run fixtures:arduino`.
