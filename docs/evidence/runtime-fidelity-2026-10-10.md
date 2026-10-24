# Runtime fidelity - 2026-10-10

This candidate implements EEPROM programming, Timer0/Timer1 external input
clocks and flash erase/write duration. The normative source is the standard
[ATmega328P datasheet DS40002061B](https://ww1.microchip.com/downloads/en/DeviceDoc/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf). The automotive document initially
listed in the roadmap was replaced after checking the standard chip's RWW
geometry and programming tables. Physical hardware was not measured.

## Firmware-visible policy

EEPROM programming latches address, data and mode, keeps EEPE high, and commits
only at completion: 3.4 ms atomic erase/write or 1.8 ms separate erase/write.
Firmware reads stall four CPU clocks; accepted writes stall two. Busy reads,
address changes and re-starts are rejected; staged EEDR changes cannot replace
the latched byte. Mode 3 is reserved and does not program. The existing EEMPE
four-clock eligibility window is distinct from the programming timer. Host
storage helpers remain immediate.

Flash retains a four-clock command window and uses 4.1 ms erase/write duration
(midpoint of the specified 3.7..4.5 ms range). Pending page data is latched.
Writes clear bits; erase restores ones. RWW availability, operation readiness
and lock checks remain separate. The fixed RWW boundary is word 0x3800
(Table 27-14), independent of BOOTSZ: NRWW writes halt the whole CPU, while
RWW writes permit NRWW execution and block RWW fetches until RWWSRE. Invalid
blocked LPM reads use deterministic zero, not a claim about undefined silicon
behavior. Lock programming retains its short command-completion policy.

The shared internal wall-time event primitive preserves remaining duration
through clock changes and CLKPR. CPU stalls advance peripherals and complete
before interrupt acceptance, with no recursive instruction execution in hooks.
Powered reset preserves pending nonvolatile operations, including time spent
in oscillator startup; sleep and PRR do not suspend their RC programming clock.
Supply-loss corruption and wear remain excluded. Optional snapshot fields
preserve compatibility with earlier snapshots; pending flash files without
new millisecond/page-data fields resume from their recorded cycle deadline and
buffer. Completed RWW interlocks also survive snapshot restoration.

T0/PD4 and T1/PD5 use existing effective logical GPIO edges. Integer-phase
sampling occurs on the next I/O clock with two following pipeline clocks.
Same-cycle unsampled pulses are ignored; selecting a source, changing polarity,
PRR, deep sleep and mux changes cancel disabled-domain edges. Pending samples
and deliveries survive snapshots without an artificial restore edge. Counter
updates reuse existing compare/overflow/PWM logic. No per-cycle pin polling is
added. Fractional edge phases and electrical thresholds remain outside scope.

## Reproducible native findings

[Raw results](runtime-fidelity-2026-10-10.json) preserve commands, HEX SHA-256,
fast/cycle-exact outcomes, native bytes and explicit timing differences.

| Probe | avrts policy and outcome | Native outcome |
| --- | --- | --- |
| programming-timing | EEPROM busy `2`, 6801 Timer1 /8 ticks, byte 0x5a; flash busy `1`, 8201 ticks, word 0x5aa5 | Same stored data; busy flags zero and only 1/2 ticks. This native build does not calibrate programming duration. |
| timer-external-clock | Both counters wrap to 2; flags 7/7 in both timing modes | All 21 bytes agree. No native input-delay calibration is inferred. |
| timer1-top | Mode 14 TOV1 observed at counter 1000 in both timing modes | Observed at BOTTOM (zero). Datasheet TOP policy retained without normalization. |

The Timer1 probe sets its stopped WGM before ICR1; ICR1 is writable only in
TOP modes. Enabling the external clock precedes loading its counters, avoiding
a native clock-selection initialization discrepancy. These are valid firmware
setup sequences, not result-field normalizations.

```powershell
bun run oracle:simavr:runtime --output docs/evidence/runtime-fidelity-2026-10-10.json
bun test test/programming-timing.test.ts test/runtime-fidelity-results.test.ts test/timer-external-clock.test.ts test/phase6-chip-level.test.ts test/phase6-self-programming.test.ts test/phase6-optiboot.test.ts
```

A generated run that starts SPM now hands off to the standard interlocked
path before its next fetch; the profiled core follows the same rule. The new
regression arms NRWW programming inside a run rather than before it.
Host program replacement and chip erase explicitly cancel obsolete pending
commits; ordinary powered reset continues them. This keeps a replacement
image or erased EEPROM from being overwritten by an earlier operation.

The final release evidence records full source/browser/package and native
acceptance separately. [Scope decisions](calibration-scope-2026-10-10.md) retain
uncalibrated physical and wire behavior explicitly.
