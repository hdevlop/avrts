# arduino-sensor-format

Real Arduino AVR core performance fixture compiled with Arduino CLI for
`arduino:avr:uno`.

The sketch is intentionally less loop-synthetic than the original benchmark set:
it combines `PROGMEM` table reads, `map()`/integer math, a small RAM history
buffer, repeated `analogWrite(...)`, and occasional numeric `Serial.print(...)`
formatting from flash strings.

Regenerate artifacts with:

```powershell
C:\Users\hdevlop\Downloads\arduino-ide\resources\app\lib\backend\resources\arduino-cli.exe compile --fqbn arduino:avr:uno --output-dir examples\arduino-sensor-format\build examples\arduino-sensor-format
.\avr-gcc\bin\avr-objdump.exe -d examples\arduino-sensor-format\build\arduino-sensor-format.ino.elf > examples\arduino-sensor-format\arduino-sensor-format.lst
```

`arduino-sensor-format.ino.hex` and `.lst` are committed so tests and benchmarks
do not need Arduino CLI at runtime.
