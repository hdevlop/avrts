# arduino-bitbang-crc

Benchmark fixture for bit-banged IO plus CRC work.

Stresses common firmware patterns that are not well represented by the older
fixtures: `AND`/`OR`/`EOR`, shifts, direct `IN`/`OUT` port access, PROGMEM reads,
and small branchy CRC loops.

Normal mode stays continuous. SRAM `0x02ff=0x42` selects exactly 32 rounds,
followed by interrupt shutdown, a 21-byte result block at `0x0300` and halt.
The end marker is written last.

The result harness drives a repeated input byte MSB first on D12/PB4 at each
rising D13/PB5 clock edge. It samples D11/PB3 MOSI and counts both clock edges.
The default input is `0x96`; `--bitbang-input` accepts any byte. Zero, `0x96`,
`0xa5` and `0xff` were checked against both reference engines. This tests
logical GPIO transitions and read ordering; it does not model an electrical bus.

| Offsets | Meaning |
| --- | --- |
| 0, 20 | Start/end markers `a7`, `5c` |
| 1 | Round count, 32 |
| 2 | CRC-8, polynomial `07`, seed `5a`, over transmitted XOR received bytes |
| 3-4 | CRC-16, polynomial `1021`, seed `ffff`, little-endian; expected `19 4f` |
| 5-7 | XOR of received bytes, last received byte, last transmitted byte |
| 8-11 | Full round counter, little-endian |
| 12-14 | PORTB, DDRB, masked PB4 input |
| 15-19 | Four reserved zeros, fixture tag `b1` |

Acceptance requires the declared CRC/result block, all 32 expected MOSI bytes,
and exactly 256 rising plus 256 falling edges. Two engines agreeing on a wrong
result or a missing trace still fails the expected-output checks.

```powershell
bun run bench:result --case bitbang-crc --bitbang-input 150
bun run oracle:simavr:result --case bitbang-crc --bitbang-input 150
```

See [result evidence and build details](../../docs/evidence/arithmetic-results-2026-10-06.md)
for the exact byte sequence, native comparisons and regressions.

Regenerate committed artifacts with:

```powershell
bun run fixtures:arduino
```

`arduino-bitbang-crc.ino.hex` and `.lst` are committed so tests and benchmarks do
not need Arduino CLI at runtime.

This result-oracle rebuild used Arduino AVR 1.8.8 / AVR GCC 7.3.0 and cached
Uno core objects (`-Os -flto`) because Arduino CLI was unavailable locally.
The normal loop remains active, but the added mode check changes the firmware
image; older speed samples are not new measurements of this image.
