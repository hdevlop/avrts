# Blink Fixture

Minimal ATmega328P HEX fixture for Phase 5 GPIO bring-up.

It sets PB5 (digital pin 13) as an output, drives it high, drives it low, then
loops forever. It intentionally does not use `delay()`; Timer0 arrives in Phase 6.

Run:

```bash
bun run examples/blink/runner.ts
```
