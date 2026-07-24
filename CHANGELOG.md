# Changelog

All notable user-facing changes are recorded here. This project follows
Semantic Versioning once a version is published.

## 0.1.0 - Unreleased

### Added

- Function-first `AVR(...)` package facade for ATmega328P simulation.
- Timed CPU, interrupt, GPIO, timer, ADC, EEPROM, watchdog, USART, SPI, TWI,
  sleep/wake, fuse, lock-bit, self-programming, and Optiboot behavior.
- Browser worker runtime, snapshots, debugger/watchpoints, circuit adapters,
  and explicit `avrts/browser` and `avrts/advanced` package subpaths.
- Native simavr state, timing, peripheral, and Optiboot oracle checks.
- Reproducible JavaScript/declaration builds and packed Node/Bun/browser
  consumer smoke tests.

### Known limitations

- Electrical analog behavior, debugWIRE, exact power consumption, flash wear,
  and other documented non-goals remain out of scope. See
  `docs/limitations.md` in the repository.
- Package licensing is intentionally `UNLICENSED` until the owner selects a
  license for third-party distribution.
