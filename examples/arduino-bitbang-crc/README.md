# arduino-bitbang-crc

Benchmark fixture for bit-banged IO plus CRC work.

Stresses common firmware patterns that are not well represented by the older
fixtures: `AND`/`OR`/`EOR`, shifts, direct `IN`/`OUT` port access, PROGMEM reads,
and small branchy CRC loops.

Regenerate committed artifacts with:

```powershell
bun run fixtures:arduino
```

`arduino-bitbang-crc.ino.hex` and `.lst` are committed so tests and benchmarks do
not need Arduino CLI at runtime.
