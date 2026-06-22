# Arduino Digital Read Fixture

Real Arduino AVR core fixture compiled with Arduino CLI for `arduino:avr:uno`.

The sketch mirrors digital pin 2 onto digital pin 13:

- `pinMode(2, INPUT)`
- `pinMode(13, OUTPUT)`
- `digitalWrite(13, digitalRead(2))`

The simulator test drives pin 2 with `avr.pin(2).setInput(...)` and verifies the
compiled Arduino firmware updates pin 13.

Build from the repository root:

```powershell
C:\Users\hdevlop\Downloads\arduino-ide\resources\app\lib\backend\resources\arduino-cli.exe compile --fqbn arduino:avr:uno --output-dir examples\arduino-digital-read\build examples\arduino-digital-read
.\avr-gcc\bin\avr-objdump.exe -d examples\arduino-digital-read\build\arduino-digital-read.ino.elf > examples\arduino-digital-read\arduino-digital-read.lst
```

`arduino-digital-read.ino.hex` and `.lst` are committed so tests do not need
Arduino CLI at runtime.
