# Peripheral Timing Oracle

Small avr-libc fixture for the native simavr oracle. It measures firmware
polling waits for USART TX complete, USART RX complete, SPI transfer complete,
and TWI master operations into SRAM at `0x0300`.

The DOR0 overrun probe is recorded for avrts, but native simavr's UART input
IRQ uses a 64-byte host FIFO and does not reproduce the ATmega328P two-byte
receive-buffer overrun path. The TypeScript oracle normalizes that status while
still comparing RXC0 status and received bytes.

Regenerate with `bun run fixtures:avr-gcc` or compile this file with the same
`avr-gcc -mmcu=atmega328p -Os -DF_CPU=16000000UL` flags used by the fixture
script.

## SPI setup

The master measurement configures PB2/SS as an output before setting MSTR, so
an externally low SS input cannot abort the transfer. The C source and committed
HEX/disassembly must be rebuilt together when the fixture changes.
