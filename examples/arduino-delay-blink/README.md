# Arduino Delay Blink Fixture

Real Arduino AVR core fixture compiled with Arduino CLI for `arduino:avr:uno`.

The sketch uses normal Arduino APIs:

- `pinMode(13, OUTPUT)`
- `digitalWrite(13, HIGH/LOW)`
- `delay(1)`

That makes it a stronger golden fixture than hand-written opcodes because it
exercises Arduino startup, Timer0 timekeeping, interrupt vectors, and compiled
core library code.

Build from the repository root:

```powershell
C:\Users\hdevlop\Downloads\arduino-ide\resources\app\lib\backend\resources\arduino-cli.exe compile --fqbn arduino:avr:uno --output-dir examples\arduino-delay-blink\build examples\arduino-delay-blink
.\avr-gcc\bin\avr-objdump.exe -d examples\arduino-delay-blink\build\arduino-delay-blink.ino.elf > examples\arduino-delay-blink\arduino-delay-blink.lst
```

`arduino-delay-blink.ino.hex` and `.lst` are committed so tests do not need
Arduino CLI at runtime.
