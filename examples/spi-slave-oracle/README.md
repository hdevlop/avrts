# SPI Slave Oracle Fixture

Small avr-libc fixture for the native simavr timing oracle. Firmware configures
the ATmega328P SPI peripheral as a slave, preloads `SPDR`, waits for an external
master byte, and records the `SPIF` status/read-clear behavior into SRAM at
`0x0300`.

The native helper drives the transfer through simavr's SPI input IRQ. That
validates the firmware-visible receive/SPIF result block, but simavr echoes the
injected byte on its output IRQ instead of returning the preloaded slave `SPDR`
byte. The TypeScript oracle reports and normalizes that host-output difference.

Regenerate with `bun run fixtures:avr-gcc` or compile this file with the same
`avr-gcc -mmcu=atmega328p -Os -DF_CPU=16000000UL` flags used by the fixture
script.
