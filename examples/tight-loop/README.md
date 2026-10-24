# Synthetic tight-loop state fixture

The manually encoded HEX contains AVR `RJMP -1` (`0xcfff`, little-endian
`ff cf`) at PC zero. The data record checksum is `0x30`. There is no compiler
or source dependency. The bounded observer runs 10,000 cycles and checks PC
zero, SP `0x08ff`, SREG zero and all 32 general registers zero. Its 36-byte
state result is created by the observer; this firmware has no SRAM marker.

All three engines use 2 KiB SRAM, avoiding an artificial peer stack-pointer
difference. This synthetic bulk-skip benchmark is excluded from practical
application throughput claims.

```powershell
bun run bench:result --case tight-loop
bun run oracle:simavr:result --case tight-loop
```
