# avrts

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## Simulation Accuracy

USART TX, SPI master transfers, and TWI/I2C master operations are scheduled in
simulated CPU cycles, so firmware polling `TXC0`, `SPIF`, or `TWINT` observes a
real delay before completion. USART RX is still host-injected immediately.

Not modeled yet: bootloader behavior, fuses/lock bits, self-programming/SPM,
brown-out reset, exact sleep-mode power states, and analog bus effects such as
rise time, contention, capacitance, or noise.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
