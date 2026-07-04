# Arduino SoftwareSerial Loopback

Arduino `SoftwareSerial` pin-timing validation fixture.

The sketch listens on Arduino pin 8 and retransmits the received byte on Arduino
pin 9 plus hardware Serial. `test/phase9-golden.test.ts` bit-bangs the RX pin
at 9600 baud and decodes the TX pin waveform, so the validation covers the real
Arduino SoftwareSerial ISR/delay-loop path through simulated GPIO timing.
