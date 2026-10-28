# Serial Fixture

Minimal USART0 fixture for Phase 7.

It enables USART0 transmit, writes `H` and `i` to `UDR0`, then loops forever.

Run from the repository root (firmware paths use the working directory):

```bash
bun run examples/serial/runner.ts
```
