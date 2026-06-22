# Arduino Analog Write Fixture

Real Arduino AVR core fixture compiled with Arduino CLI for `arduino:avr:uno`.

The sketch configures PWM through normal Arduino APIs:

- `analogWrite(5, 191)`  -> Timer0 / OC0B
- `analogWrite(9, 64)`   -> Timer1 / OC1A
- `analogWrite(10, 192)` -> Timer1 / OC1B
- `analogWrite(11, 51)`  -> Timer2 / OC2A
- `analogWrite(3, 128)`  -> Timer2 / OC2B

Build from the repository root:

```powershell
C:\Users\hdevlop\Downloads\arduino-ide\resources\app\lib\backend\resources\arduino-cli.exe compile --fqbn arduino:avr:uno --output-dir examples\arduino-analog-write\build examples\arduino-analog-write
.\avr-gcc\bin\avr-objdump.exe -d examples\arduino-analog-write\build\arduino-analog-write.ino.elf > examples\arduino-analog-write\arduino-analog-write.lst
```

`arduino-analog-write.ino.hex` and `.lst` are committed so tests do not need
Arduino CLI at runtime.
