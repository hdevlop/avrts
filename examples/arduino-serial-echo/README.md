# Arduino Serial Echo

Arduino `Serial.available()` / `Serial.read()` validation fixture.

The sketch waits for host-injected USART bytes with `Serial.available()`, echoes
each byte with `Serial.write()`, and mirrors a small result block at SRAM
`0x0300`. `test/phase9-golden.test.ts` drives it through `avr.serial.write()`
so Phase 1 validates the real Arduino HardwareSerial receive path rather than
only direct UDR0 reads.
