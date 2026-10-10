# Runtime performance review - 2026-10-10

These are Bun 1.3.14 / Windows 10 i7-7700K host measurements, not Node/browser
or hardware claims. The baseline is commit
`859b7fef58ac5864618c01d484c6bcf64b077d89`. The candidate includes programming
and external-clock fidelity, the pending-stall guard and generated SPM handoff.
Both revisions use the same candidate HEX, ordinary inputs and no serial/pin
subscribers. Raw files include all samples, actual CPU cycles, firmware digests,
fixture root and host. Construction is excluded, with 500,000 explicit warmup
cycles and nine measured 50-million-cycle trials after an untimed first trial.
Each revision/workload is isolated in a fresh process; engine order alternates.
No other tests or benchmarks ran concurrently.

## Profile and bounded change

Five-million-cycle fast profiles are recorded for
[float-math](profile-float-2026-10-10.txt) and
[bitbang-crc](profile-bitbang-2026-10-10.txt). Float work is dispersed across
scalar arithmetic/branches; an existing split helper covers 8.1% of sampled
cycles. Bit-banging repeatedly executes SBI/SBIC/CBI and shift/CRC instructions.
No additional FastBlock, floating-point substitution or wire serialization
shortcut was selected: their observable event/flag effects need a justified
specific shape before changing them.

The initial fidelity implementation added an always-called stall helper to
every instruction boundary. The bounded change guards that call when no stall
is pending, retaining the interrupt boundary and all programming semantics.
The [initial pass](runtime-performance-before-guard-2026-10-10.json) and
[guard experiment](runtime-performance-guard-2026-10-10.json) remain available.
The criterion was set before the experiment: investigate a median loss above
5% and reject an optimization that breaks fidelity or materially regresses
its own before/after comparison. No guard-experiment row lost 5%; its largest
loss was peripheral-bound at 3.7%. Gains ranged up to 5.3%, but small variations
are not a general speed guarantee.

The subsequent generated SPM change fixes a correctness boundary, using the
generator to hand off only when SPM arms a fetch interlock. The
[current full matrix](runtime-performance-2026-10-10.json) follows that fix:

| Workload | Baseline Mcycles/s | Candidate Mcycles/s | Change |
| --- | --- | --- | --- |
| delay-blink | 48.56 | 47.86 | -1.4% |
| serial-print | 319.41 | 311.45 | -2.5% |
| analog-write | 310.64 | 294.35 | -5.2% |
| sensor-format | 70.84 | 67.71 | -4.4% |
| float-math | 30.77 | 29.86 | -3.0% |
| bitbang-crc | 18.86 | 19.07 | +1.1% |
| peripheral-mix | 138.30 | 138.17 | -0.1% |
| isr-heavy | 80.29 | 77.66 | -3.3% |
| string-heavy | 58.89 | 57.30 | -2.7% |
| dsp-fixed | 62.10 | 61.84 | -0.4% |
| timer2-rtc | 47.28 | 48.27 | +2.1% |
| peripheral-bound | 25.09 | 23.47 | -6.5% |

Two baseline-to-candidate rows crossed the review threshold. Both were repeated
with the same method and both raw passes are preserved:

- [Analog repeat](runtime-performance-analog-repeat-2026-10-10.json): +0.3%,
  versus -5.2% initially. The earlier analog loss was not reproducible.
- [Peripheral-bound repeat](runtime-performance-peripheral-repeat-2026-10-10.json):
  -5.4%, versus -6.5% initially. This remains a measured tradeoff of the new
  fidelity/dispatch paths; it is retained rather than hidden or called an
  improvement. On this host its median remains about 24 Mcycles/s. There is
  no universal realtime guarantee and no assertion of equal useful throughput.

These repeats also follow the host erase/reload cancellation fix. Those changes
are outside the timed steady region; the generated/timed CPU core is unchanged.
The recorded full-matrix runtime digest identifies its measured source state,
not a later documentation or package commit. Final source acceptance covers
the full shipping candidate.

`timer2-rtc` is an additional revision-regression probe, not a thirteenth
external result workload. Synthetic tight-loop is intentionally omitted from
this practical matrix. Serial-print measures idle execution after startup;
analog-write has active hardware PWM with an idle foreground. SRAM/serial,
pin traces and transactions are validated separately by
[workload correctness evidence](workload-results-2026-10-10.md); cycles/s does
not establish equal application transactions or sustained UART throughput.
Earlier peer ratios stay dated history and are not replaced by these
baseline-revision measurements.

```powershell
bun run profile:opcodes --case float-math --mode fast --cycles 5000000 --top 15
bun run profile:opcodes --case bitbang-crc --mode fast --cycles 5000000 --top 15
# In an isolated checkout of the baseline; do not modify the main worktree.
bun run bench:revision --baseline BASELINE_PATH --output PERFORMANCE.json
bun run bench:revision --baseline BASELINE_PATH --case analog-write --output ANALOG_REPEAT.json
bun run bench:revision --baseline BASELINE_PATH --case peripheral-bound --output PERIPHERAL_REPEAT.json
```

JIT/WASM/region rewrites remain separate architecture proposals. No large
optimization is justified merely by these profiles. Generated-core parity,
programming/interrupt boundary tests and package/browser gates are recorded
in the final local release evidence.
