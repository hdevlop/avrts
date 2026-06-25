# arduino-float-math

Benchmark fixture for soft-float-heavy Arduino code.

Stresses avr-libc floating-point helper routines through `sinf`, `cosf`,
`sqrtf`, multiplication, division, and volatile float state updates. AVR has no
hardware FPU, so this fixture measures large branchy helper loops that the older
synthetic benchmarks did not cover.

Regenerate committed artifacts with:

```powershell
bun run fixtures:arduino
```

`arduino-float-math.ino.hex` and `.lst` are committed so tests and benchmarks do
not need Arduino CLI at runtime.
