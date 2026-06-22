# Delay Blink Fixture

Real Arduino AVR core Blink fixture compiled with Arduino CLI for
`arduino:avr:uno`.

This is the standard `delay()` / `millis()`-driven Blink shape:

- pin 13 HIGH
- `delay(1000)`
- pin 13 LOW
- `delay(1000)`

The golden test checks that pin 13 changes around `16_000_000` simulated cycles,
which proves real Timer0 overflow timekeeping works with compiled Arduino core
firmware.

Build from the repository root:

```powershell
C:\Users\hdevlop\Downloads\arduino-ide\resources\app\lib\backend\resources\arduino-cli.exe compile --fqbn arduino:avr:uno --output-dir examples\delay-blink\build examples\delay-blink
.\avr-gcc\bin\avr-objdump.exe -d examples\delay-blink\build\delay-blink.ino.elf > examples\delay-blink\delay-blink.lst
```

`delay-blink.ino.hex` and `.lst` are committed so tests do not need Arduino CLI
at runtime.
