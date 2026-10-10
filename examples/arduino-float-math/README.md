# arduino-float-math

Benchmark fixture for soft-float-heavy Arduino code.

Stresses avr-libc floating-point helper routines through `sinf`, `cosf`,
`sqrtf`, multiplication, division, and volatile float state updates. AVR has no
hardware FPU, so this fixture measures large branchy helper loops that the older
synthetic benchmarks did not cover.

Normal mode stays continuous. Setting SRAM `0x02ff=0x42` before execution
selects a result mode: exactly 32 iterations from seed `0.125f`, disable
interrupts, write 21 bytes at `0x0300`, then halt. The end marker is written
last. The result stores raw little-endian AVR float bytes, not formatted text
or values recomputed with host JavaScript math.

| Offsets | Meaning |
| --- | --- |
| 0, 20 | Start/end markers `a7`, `5c` |
| 1 | Iteration count, 32 |
| 2-5 | Accumulated result, raw IEEE-754 bytes `03 82 80 41` |
| 6-9 | Updated seed, raw bytes `70 c8 8e 3e` |
| 10-13 | Full iteration counter, little-endian |
| 14-15 | PORTB and DDRB |
| 16-17 | Positive result/seed flags |
| 18-19 | Reserved zero, fixture tag `f1` |

```powershell
bun run bench:result --case float-math
bun run oracle:simavr:result --case float-math
```

Both references agree on the compiled AVR-libc result, and the runners also
check a pinned golden block. The tests cover fast/cycle-exact execution,
continuous activity after warmup, snapshot/resume during the calculation,
stable halt results, and corrupted result rejection. See
[result evidence and build details](../../docs/evidence/arithmetic-results-2026-10-06.md).

Regenerate committed artifacts with:

```powershell
bun run fixtures:arduino
```

`arduino-float-math.ino.hex` and `.lst` are committed so tests and benchmarks do
not need Arduino CLI at runtime.

This result-oracle rebuild used the installed Arduino AVR 1.8.8 core and AVR
GCC 7.3.0 (`-Os -flto`) with the cached Uno core because Arduino CLI was
unavailable locally. The added finite-mode check changes the compiled image;
older speed samples retain their original firmware/methodology and do not
measure this rebuilt image.
