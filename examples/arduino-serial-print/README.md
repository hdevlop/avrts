# Arduino Serial Print Fixture

Real Arduino AVR core fixture compiled with Arduino CLI for `arduino:avr:uno`.

The sketch uses normal Arduino serial APIs:

- `Serial.begin(9600)`
- `Serial.println("hello avrts")`

Build from the repository root:

```powershell
C:\Users\hdevlop\Downloads\arduino-ide\resources\app\lib\backend\resources\arduino-cli.exe compile --fqbn arduino:avr:uno --output-dir examples\arduino-serial-print\build examples\arduino-serial-print
.\avr-gcc\bin\avr-objdump.exe -d examples\arduino-serial-print\build\arduino-serial-print.ino.elf > examples\arduino-serial-print\arduino-serial-print.lst
```

`arduino-serial-print.ino.hex` and `.lst` are committed so tests do not need
Arduino CLI at runtime.
