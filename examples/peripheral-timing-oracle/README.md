# Peripheral Timing Oracle

Small avr-libc fixture for the native simavr oracle. It measures firmware
polling waits for USART TX complete, SPI transfer complete, and TWI master
operations into SRAM at `0x0300`.

Regenerate with `bun run fixtures:avr-gcc` or compile this file with the same
`avr-gcc -mmcu=atmega328p -Os -DF_CPU=16000000UL` flags used by the fixture
script.
