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
- Versioned snapshots: `avr.snapshot()` stamps `version`
  (`AVR_SNAPSHOT_VERSION` in `avrts/advanced`); `restore()` rejects newer
  formats and other chips with a clear error, and still accepts unversioned
  snapshots.

### Fixed

- The program counter wraps at the flash boundary like the chip's 14-bit PC.
  Real Arduino Uno fuses (BOOTRST programmed) with an application-only HEX now
  slide through the empty boot section into the sketch instead of crashing.
- `createAVRWorkerRuntime()` without a `worker` option now finds the packaged
  `browser-worker.js`; the package smoke test verifies the URL resolves.
- `avr.start()` replays at most 100 ms of host time per frame after a stall or
  backgrounded tab, instead of blocking on the whole missed interval.
- `status().timeMs` and pin-event times no longer rescale past time when the
  firmware changes the CLKPR clock prescaler.
- `watchData` observes stack writes (PUSH, calls, interrupt entry), and its last
  unsubscribe removes the CPU hook.
- `AVR("name")` with neither HEX text nor a path-like string explains how to
  pass a path instead of reporting a HEX syntax error.
- Published types are built under `strict`, exclude `@internal` members and
  internal-only modules, and no longer ship declaration maps to unpublished
  sources.

### Known limitations

- Electrical analog behavior, debugWIRE, exact power consumption, flash wear,
  and other documented non-goals remain out of scope. See
  `docs/limitations.md` in the repository.
- Package licensing is intentionally `UNLICENSED` until the owner selects a
  license for third-party distribution.
