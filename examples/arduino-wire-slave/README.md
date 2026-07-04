# Arduino Wire Slave

Arduino `Wire.onReceive` / `Wire.onRequest` validation fixture.

The sketch configures the ATmega328P as an I2C slave at address `0x42`, records
received bytes into SRAM at `0x0300`, and returns one response byte from
`onRequest`. `test/twi-slave.test.ts` drives it through `avr.twi.master()` so the
TWI slave path is validated through the real Arduino Wire ISR/callback code.
