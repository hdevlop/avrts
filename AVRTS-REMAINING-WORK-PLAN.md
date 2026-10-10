# AVRts remaining work plan

Created: 2026-10-06. Updated: 2026-10-10. Status: all local implementation phases selected below are implemented; source/browser/native/package acceptance passed; final archive preparation is in progress. Physical/wire extensions have explicit retained or deferred scope.

This is the root entry point for all known remaining work. It consolidates the existing plans, behavioral limitations, benchmark gaps, and release obligations. It does not promise that a simulator can be proven free of every unknown bug. Completion means that the selected scope has reproducible evidence and that every remaining limitation has an explicit disposition.

## 1. Verified starting point

Baseline commit: `859b7fef58ac5864618c01d484c6bcf64b077d89` (`Add continuous USART PWM ADC peripheral workload and oracles`). The worktree was clean when this plan was prepared.

| Area | Starting evidence | What that evidence establishes |
| --- | --- | --- |
| Source validation | [Release preparation](docs/evidence/release-0.1.2.md): 2,743 tests, 17,686 assertions, 74 files | Recorded source checks passed; these counts are a dated baseline, not a permanent acceptance target |
| Browser | Same release record: eight Chromium tests | Covered browser workflows passed; no claim about every browser or device |
| Package | Same release record: type declarations, build, and 83-file package smoke | Prepared package imports and exports passed their checks |
| CI | [Run 37527658771](https://github.com/hdevlop/avrts/actions/runs/37527658771), successful for baseline commit | Three package jobs and one browser job passed on that revision |
| Result fidelity | Five avr8js and five native simavr result scenarios | `peripheral-mix`, `isr-heavy`, `string-heavy`, `dsp-fixed`, and `peripheral-bound` have result comparisons |
| Native timing | [Benchmark plan](docs/benchmark-plan.md) and release evidence | Selected USART/SPI/TWI, SPI slave, Timer2 async, and comparator probes; native agreement is not complete silicon calibration |
| Bootloader | [Release preparation](docs/evidence/release-0.1.2.md) | Recorded native Optiboot transcript, programmed page, and application checks passed |
| Publication | Manifest and release preparation identify `0.1.2` | The local record says prepared, unpublished; refresh registry state before any publishing decision |

The register/vector inventory has no unmodeled rows, but [limitations](docs/limitations.md) contains behavioral approximations. Its machine check classifies registers and vectors; it does not verify the behavioral paragraphs.

Existing CPU, USART, SPI, TWI, comparator, timers, watchdog, sleep, snapshot, and bootloader implementations should be extended from this baseline. Completed historical phases are not requests to rebuild them.

## 2. Source documents and precedence

| Document | Role going forward |
| --- | --- |
| [This plan](AVRTS-REMAINING-WORK-PLAN.md) | Consolidated queue, dependencies, and acceptance boundaries |
| [Limitations](docs/limitations.md) | Current public behavioral contract; update with every fidelity change |
| [Benchmark plan](docs/benchmark-plan.md) | Workload definitions, comparison methodology, and oracle coverage |
| [Performance summary](docs/performance-summary.md) | Dated measurements and optimization rationale |
| [Complete ATmega328P plan](docs/complete-atmega328p-plan.md) | Historical implementation phases; status and proof boundaries reconciled in Phase 0 |
| [Real peripheral timing plan](docs/real-peripheral-timing-plan.md) | Completed timing work and its historical evidence |
| [Review fix plan](docs/PLAN.md) | Completed review fixes and historical evidence |
| [Releasing](RELEASING.md) | Publish procedure and owner decisions |

Resolve discrepancies against source and reproducible evidence, then update the relevant document. Preserve old measurements with their dates, host, methodology, and scope. Archive or cross-link superseded plans losslessly; do not delete evidence or overwrite historical test counts with current counts.

## 3. Execution order and boundaries

| Phase | Priority | Dependency | Deliverable |
| --- | --- | --- | --- |
| 0. Reconcile documentation and inventory | Complete, 2026-10-06 | Baseline | Accurate statuses and one tracked queue; [evidence](docs/evidence/documentation-reconciliation-2026-10-06.md) |
| 1. Complete benchmark result fidelity | High | 0 | Result/state coverage for every current workload |
| 2. EEPROM firmware timing | High | 0; use Phase 1 harness where useful | Programming busy time, read/write stalls, persistence and interrupt tests |
| 3. Timer0/Timer1 external clock inputs | High | 0 | Logical T0/T1 pin clocking and timing tests |
| 4. Flash programming timing | Medium | 2 | Distinct command window and erase/write operation timing |
| 5. Timer and wake calibration | Medium | 3; relevant Phase 2/4 clock interactions | Documented timing policies, targeted probes and fixes |
| 6. Remaining model scope decisions | Before claiming broader fidelity | 0 and findings from 5 | Each remaining approximation implemented, retained, or explicitly deferred |
| 7. Measured performance improvements | After relevant correctness gates | 1; rerun after runtime changes | Profile-backed improvements without lost behavior |
| 8. Release acceptance and publication | For each chosen release | Selected phases and current limitations documented | Verified artifact and separate publication evidence |

Phases 0-4 are implemented locally. All twelve external workloads and the shared listener path are covered. Phase 5 retains the datasheet Timer1 TOP rule with a compiled disagreement probe; other uncalibrated models are explicitly dispositioned in Phase 6. Final source, browser, native, performance and package checks passed. Archive preparation and the local handoff are being recorded.

Phases 2-6 are a fidelity roadmap, not an assertion that every item must delay an already prepared release. Define the scope of each release before implementation. A release can retain documented approximations; it must not advertise them as completed fidelity work.

Writing this plan does not authorize npm publication, production deployment, purchasing hardware, or replacing the engine with JIT/WASM. Those are separate decisions. Routine implementation and verification within a subsequently selected phase should proceed without repeated confirmation.

## 4. Phase 0 — reconcile the current project record

Status: complete, 2026-10-06. [Reconciliation evidence](docs/evidence/documentation-reconciliation-2026-10-06.md) records the scope and checks; historical source, browser, native and publication statuses were not promoted by this documentation pass.

Targets: the documents in section 2, [release evidence](docs/evidence/release-0.1.2.md), and [CI workflow](.github/workflows/ci.yml).

- [x] Replace stale `draft roadmap` and present-tense missing-feature wording in the completed ATmega328P roadmap with a dated completion statement and links to the remaining limitations.
- [x] Revise blanket claims that firmware cannot distinguish simulators, or that every behavioral difference is machine-checked. State the actual fixture and register-inventory proof boundaries.
- [x] Keep completed checklists and historical counts as history. Distinguish design rules and non-goals from unfinished implementation tasks.
- [x] Add `bun run oracle:simavr:result` to the release checklist alongside native state, timing, and Optiboot gates.
- [x] Record the twelve internal benchmark labels and twelve external workloads correctly: internal has `serial-print-listener`; external has `peripheral-mix`. Their union has thirteen labels, with the listener sharing serial firmware.
- [x] Track each limitation from section 11 against a phase or explicit retained scope. Record evidence links, unresolved peer disagreements, and the next actionable task.
- [x] Document the usable local fixture compiler and native oracle dependencies. The October rebuild used Arduino AVR 1.8.8 / AVR GCC 7.3.0; the previously bundled Arduino CLI was unavailable. Do not present an older CLI installation as currently verified.

Acceptance: every active obligation is reachable from this plan; no historical evidence is lost; all relative links resolve; `git diff --check` passes. Documentation-only changes do not need a full source test run.

Rollback: revert only the documentation reconciliation commit. Keep this root inventory if it still accurately describes the project.

## 5. Phase 1 — complete benchmark result fidelity

Status: implemented. The arithmetic and sensor slices are joined by serial-print,
analog-write, delay-blink, tight-loop and the shared subscriber check. Both result
matrices cover twelve workloads. See [complete workload evidence](docs/evidence/workload-results-2026-10-10.md)
for current firmware identities and the native phase-correct PWM trace limitation.

Targets: [benchmark results](scripts/benchmark-results.ts), [native oracle](scripts/simavr-oracle.ts), [comparison harness](scripts/benchmark-compare.ts), [internal harness](scripts/benchmark.ts), [revision harness](scripts/benchmark-revision.ts), [result tests](test/benchmark-results.test.ts), [comparison tests](test/benchmark-comparison.test.ts), and the corresponding `examples/` fixture directories.

### Coverage queue

All twelve external workloads have result/state oracles; the listener-specific check shares serial firmware. The synthetic loop has bounded CPU state rather than a firmware SRAM marker.

| Workload | Required result or state oracle | Special handling |
| --- | --- | --- |
| `float-math` | Complete: bounded iteration count, raw AVR float result bytes, relevant state | Identical compiled firmware and seed; pinned peer-validated bytes, without host JavaScript math substitution |
| `bitbang-crc` | Complete: CRC8/CRC16, rounds, received data, MOSI trace and clock edge counts | Deterministic MSB-first MISO at four input patterns; both levels and edge ordering checked |
| `sensor-format` | Complete: final accumulator, full history, index, exact serial text and PWM settings | Five start indices cover counter wrap and PWM endpoints; completion waits for TXC0 |
| `serial-print` | Exact expected startup text, final TX completion and relevant state | Existing firmware prints once; distinguish startup work from steady execution |
| `analog-write` | Timer configuration plus steady waveform periods, duty and endpoints | Empty foreground loop is intentional; timers must remain active during the observation window |
| `delay-blink` | Pin order, intervals, completed periods and timer state | Use a case-specific cycle budget long enough for actual second-scale transitions |
| `tight-loop` | Bounded cycles, PC, registers and instruction behavior | Synthetic state oracle; exclude bulk-skip throughput from practical speed claims |
| `serial-print-listener` | Same serial result plus subscriber byte/text delivery | Reuse the serial fixture, avoiding a duplicate independent workload count |

Implementation requirements:

- [x] Audit whether the timed region measures active work, startup work, or an intentional idle foreground. The one-shot `serial-print` must not be described as sustained UART throughput after its text has already drained during warmup. Retain its example behavior; add a separately named continuous workload only if useful, with fresh baselines.
- [x] Add an opt-in finite result mode or a bounded observation adapter. Preserve ordinary continuous behavior for workloads that are intended to run continuously.
- [x] Specify result layout, completion marker, inputs, budget, and observable outputs independently of emulator implementation. Add fixture README explanations and reproducible build instructions.
- [x] For each scenario, compare avrts against avr8js and native simavr using the same HEX digest. Add explicit expected values or invariants so two peers agreeing on a bug is not sufficient evidence.
- [x] Drain USART through actual transmission completion, rather than stopping when UDR becomes empty. Avoid arbitrary short budgets that cut off valid output.
- [x] Compare selected peripheral registers and output traces alongside SRAM. Document any normalization field by field, with a reason and focused avrts tests for the omitted behavior.
- [x] Extend both CLI `all` selections and their tests. Fail clearly on unknown cases, timeout, absent completion, malformed result, and mismatched output; include useful diagnostics.
- [x] Preserve the five existing result cases, ADC input variants, Timer2 RTC checks, native timing probes, and Optiboot coverage.
- [x] Rebuild tracked HEX/listing fixtures with a documented toolchain; record digests. Require fixture compilation only when regenerating artifacts, not for ordinary package consumers.

Tests must catch an intentionally changed result byte, missing final UART byte, altered GPIO edge, insufficient cycle budget, and failure to enter result mode. Keep controls in fixture/test code rather than adding benchmark-specific runtime behavior to the library.

Acceptance: all current workloads have a suitable result/state/waveform check; the listener path is covered; both peer result suites pass; default performance fixtures still perform their declared activity. Separate same-cycle throughput from transaction counts when the engines complete different amounts of peripheral work.

Rollback: revert the individual fixture/oracle addition and its coverage declaration together. Restore the prior benchmark label and baseline if workload semantics changed; do not retain a new speed claim with old firmware.

## 6. Phase 2 — model EEPROM firmware timing

Targets: [EEPROM](src/peripherals/eeprom.ts), [CPU](src/cpu/cpu.ts), [snapshot format](src/snapshot.ts), [self-programming](src/peripherals/self-programming.ts), [EEPROM fixture tests](test/eeprom-store.test.ts), [peripheral correctness tests](test/peripheral-correctness.test.ts), [snapshot tests](test/phase10-snapshot.test.ts), and [time/snapshot tests](test/time-and-snapshot-format.test.ts). New focused test files may be added.

Status: implemented with deterministic typical programming durations and instruction stalls; [runtime evidence](docs/evidence/runtime-fidelity-2026-10-10.md). Host EEPROM storage helpers retain their immediate contract.

Normative reference: the [standard ATmega328P datasheet](https://ww1.microchip.com/downloads/en/DeviceDoc/ATmega48A-PA-88A-PA-168A-PA-328-P-DS-DS40002061B.pdf),
EEPROM register description and Table 8-1. Reads stall four CPU clocks, accepted
writes two; the selected typical durations are 3.4 ms atomic and 1.8 ms separate
operations. These constants are deterministic policies, not physical guarantees.

- [x] Introduce pending programming state: latched address/data/mode, busy status, deadline and completion event. Keep the existing protected enable-window semantics separate from programming duration.
- [x] Implement legal accesses during busy programming and ready interrupt behavior from the datasheet. Test reserved mode, repeated writes, protected-window expiry, and writes outside the window.
- [x] Add instruction-boundary CPU stalls without running nested instructions from an IO hook. Clocked peripherals must progress during the stall; interrupt acceptance must obey instruction boundaries.
- [x] Preserve programming wall time across effective CPU clock changes, sleep, and clock-domain transitions. Treat EEPROM timing as its specified clock domain rather than blindly scaling a CPU-cycle constant with CLKPR.
- [x] Define EEPROM/SPM exclusion using actual pending operations. Test both directions and ready interrupt transitions; avoid relying solely on a transient control bit.
- [x] Define reset during programming from the normative behavior and test power/reset distinctions. Preserve stored cells across ordinary reset; document any unresolved power-loss behavior.
- [x] Extend snapshots with optional pending fields and remaining time/phase. Old snapshots must remain loadable; snapshot/restore mid-operation must neither duplicate completion nor complete immediately.
- [x] Preserve direct host `load`, `dump`, `write`, and `erase` contracts unless a documented API change is intentionally selected.
- [x] Add a compiled timing/result probe to the native harness. Separate datasheet expectations from native simavr deviations rather than masking them to force equality.

Acceptance: busy flags, data completion, ready IRQ, stalls, reset, snapshot and SPM interactions have boundary tests. Standard and generated execution paths agree. Existing EEPROM examples and relevant clock/sleep tests pass, followed by the source/package gates.

Rollback: revert the complete EEPROM change, including snapshot extensions and its timing claims, in one coherent commit. Do not silently introduce an undocumented legacy instant-write mode to hide a failure.

## 7. Phase 3 — wire Timer0/Timer1 external clock inputs

Targets: [Timer0](src/peripherals/timer.ts), [Timer1](src/peripherals/timer1.ts), [GPIO](src/peripherals/gpio.ts), [pin map](src/peripherals/pin-map.ts), [AVR integration](src/avr.ts), [snapshot format](src/snapshot.ts), and timer/interrupt/sleep tests.

Status: implemented. PD4/T0 and PD5/T1 use next-I/O-clock sampling plus two pipeline clocks at integer edge phase. Counts/flags match the native compiled probe; fractional hardware latency is not claimed. See the runtime evidence.

- [x] Wire logical input transitions through the existing pin-input path for T0/PD4 and T1/PD5. Implement the rising/falling external clock selections without introducing a separate incompatible top-level pin API.
- [x] Define sampling and synchronization latency, including pulses too short to observe. Count eligible sampled transitions, rather than every immediate host toggle irrespective of the IO clock.
- [x] Reuse timer counter advancement for overflow, compare flags, PWM state, buffered registers and output changes. Do not maintain an independent partial counter implementation.
- [x] Cancel internal scheduled ticks when selecting external mode, and restore correct internal prescaler behavior when switching back.
- [x] Cover DDR/PORT/pull-up changes, held input levels, reset, multiple transitions at the same boundary, PRR, sleep and wake, and CLKPR changes.
- [x] Preserve input level and pending synchronization state in snapshots without counting an artificial restore edge. Reconnect subscriptions without duplicate handlers.
- [x] Add a native compiled probe where simavr exposes a suitable input. Compare logical counts and firmware-visible flags; record unsupported or divergent peer behavior explicitly.

Acceptance: rising/falling input scenarios, counter rollover, compare events, mode switches, sleep gates and restore are verified for both timers. Normal internally clocked timer performance must avoid a new per-cycle polling cost.

Rollback: revert timer input wiring and associated snapshot fields together. Restore the limitation entry if support is removed.

## 8. Phase 4 — model flash erase/write operation duration

Targets: [self-programming](src/peripherals/self-programming.ts), [CPU](src/cpu/cpu.ts), [EEPROM](src/peripherals/eeprom.ts), [snapshot format](src/snapshot.ts), [self-programming tests](test/phase6-self-programming.test.ts), [Optiboot tests](test/phase6-optiboot.test.ts), and [native oracle](scripts/simavr-oracle.ts).

Status: implemented. The four-clock command window is separate from deterministic 4.1 ms erase/write operations. RWW/NRWW geometry is fixed at word 0x3800, independently of BOOTSZ. Powered reset/startup, sleep, CLKPR and snapshots retain pending operations. See the runtime evidence.

- [x] Specify erase/write duration and read-while-write behavior from the applicable datasheet. Keep command eligibility, page buffering, operation completion, and interrupt readiness distinct.
- [x] Model blocked instruction fetch/read cases and legal boot-section execution without recursive CPU execution. Preserve boot vectors, page boundaries, RWW enable, and lock/fuse behavior.
- [x] Preserve pending wall time through clock changes, sleep, reset and snapshot restoration; reuse only genuinely shared timing primitives from Phase 2.
- [x] Exercise EEPROM/SPM mutual exclusion and interrupted or repeated commands.
- [x] Re-run native Optiboot transcript, page contents, and application behavior with realistic operation duration. Adjust legitimate time budgets explicitly, rather than normalizing corrupted results.

Acceptance: focused command/busy/readiness boundary tests and full Optiboot acceptance pass. The flash timing limitation is narrowed only as far as the evidence supports; flash wear remains out of scope.

Rollback: revert the programming-duration change and its documentation together, retaining previously proven functional bootloader behavior.

## 9. Phase 5 — targeted timer, interrupt and wake calibration

Status: selected TOP calibration implemented; remaining calibration extensions are explicitly retained/deferred in [scope evidence](docs/evidence/calibration-scope-2026-10-10.md). No physical calibration was run.

Targets: [Timer2](src/peripherals/timer2.ts), [timer prescaler](src/peripherals/timer-prescaler.ts), [timer synchronization](src/peripherals/timer-sync.ts), Timer0/Timer1, [sleep control](src/peripherals/sleep-control.ts), [clock control](src/peripherals/clock-control.ts), comparator/EXTI peripherals, focused tests and native probes.

Each item starts with a small firmware probe and a stated normative rule. A peer discrepancy is a finding to investigate, not an instruction to copy the peer. Mark results as datasheet-based, native-calibrated, or physically measured.

- [x] Resolve and document Timer1 fast-PWM TOV timing: the existing TOP-based policy and native BOTTOM behavior differ. Verify the relevant mode-specific rule; do not globally normalize timer flags.
- [x] Disposition: retain current tested Timer2 transfers/phase/wake model; defer clear/ack and PSRASY physical calibration. Original extension: calibrate Timer2 asynchronous acknowledgement/clear/repeated-sleep behavior within one TOSC period and PSRASY synchronization. Preserve current fractional phase, transfer-busy, wake/read and RTC behavior.
- [x] Disposition: defer a new host clock-source contract until a caller is selected. Original extension: specify a logical external TOSC/EXCLK source and its integration only after defining a useful host input contract. Test source changes, pending transfer disposition, clock gating and snapshot phase.
- [x] Disposition: retain tested digital sleep/startup ordering; defer fractional short-pulse and physical startup calibration. Original extension: probe external interrupt synchronization, short pulses, held low-level wake, and startup boundaries. Preserve currently proven deep-sleep edge masking and asynchronous PCINT behavior.
- [x] Disposition: retain tested ACME/PRADC/ACIC digital behavior; defer settling and physical propagation measurements. Original extension: investigate comparator propagation/synchronization and power-up settling separately from its logical voltage model. Cover ACME with PRADC and ACIC capture ordering if the selected digital model supports it.
- [x] Disposition: retain documented deterministic fuse/startup and wake policy with source regressions; physical startup remains uncalibrated. Original extension: define supported fuse/clock startup delays and sleep wake latency. Keep CKDIV8, watchdog, BOD handshakes and existing wake clock-domain behavior covered.
- [x] Run CLKPR/PRR interaction regressions with pending EEPROM/SPM operations, Timer2 async time, watchdog and serial transfers.
- [x] For reserved timer modes or unsupported oscillator behavior, retain an explicit deterministic approximation rather than inventing a fidelity claim.

Acceptance: each selected calibration has a reproducible probe, boundary tests, a documented policy, and a before/after evidence record. Remaining uncalibrated behavior stays listed. Physical calibration is not claimed without identified hardware and captured measurements.

Rollback: land each calibration separately; revert the individual timing policy and evidence status if it fails other covered modes.

## 10. Phase 6 — decide the scope of remaining wire and physical models

Status: scope decisions complete; [decision record](docs/evidence/calibration-scope-2026-10-10.md) names each retained/deferred contract. No larger wire model is selected.

These are recorded needs or limitations, not automatic requirements for a release. Select a concrete use case and observable contract before implementing a larger model.

- [x] USART: decide whether GPIO XCK, actual wire-bit RX sampling and derived framing/parity errors are needed beyond byte injection. Keep all supported modes, FIFO, error and MPCM tests.
- [x] SPI: decide whether DORD serialization and complete GPIO pin ownership are needed beyond byte-level transfers. Keep SS faults and documented SPIF/WCOL semantics even where native simavr differs.
- [x] TWI: decide whether silicon-oriented START/STOP timing, per-bit sleep clock stretching and real multi-master arbitration are needed. A bit-level implementation requires a shared logical bus contract and simultaneous-driver tests.
- [x] GPIO: define ownership and contention between firmware, host inputs and peripheral outputs before expanding pin serialization. Floating voltage and resistance require a different physical model and remain outside ordinary logical pins.
- [x] OSCCAL/DIDR: either define their supported digital effects or retain storage/mask-only behavior. Do not suggest electrical buffer suppression or oscillator calibration has been simulated without a model.
- [x] Fuse startup/oscillator instability: decide whether a deterministic delay policy is sufficient; physical drift, noise and register loss require separate scope and evidence.
- [x] Document permanent exclusions: debugWIRE, analog noise/leakage/VCC-dependent electrical behavior, power/current figures, and EEPROM/flash wear unless a future project explicitly changes that scope.

Acceptance: every item has an implemented contract or a clearly retained/deferred limitation with a reason. There are no unchecked feature promises concealed in a completed roadmap.

Rollback: introduce any selected wire model behind a compatible API evolution and in separate commits. Keep existing byte-level host workflows functional unless a deliberate versioned API migration is selected.

## 11. Full limitation disposition inventory

Use this table when reconciling [limitations](docs/limitations.md). Closing an entry requires evidence; register-hook existence alone does not close it.

| Known gap or approximation | Planned disposition |
| --- | --- |
| USART byte-frame scheduling, host-injected errors, missing GPIO XCK and bit samples | 6; retain byte-level contract until a wire use case is selected |
| SPI byte transfers/DORD metadata; native SPIF and collision disagreements | 6; retain documented semantics and focused evidence |
| TWI host-injected arbitration, native-oriented START/STOP, abstract sleep stretching | 6; selected timing calibration may precede a full bus model |
| Comparator propagation, settling, synchronized output and ACME/PRADC edge cases | 5, with electrical effects retained under 6 |
| GPIO floating inputs, electrical pull-ups and complete serial pin ownership | 6; logical ownership can be selected independently of electrical simulation |
| External interrupt short pulses, input synchronizers and oscillator wake details | 5 |
| EEPROM busy operations and CPU stalls | Implemented in 2; typical timing policy and powered-reset scope documented |
| CLKPR cross-domain interactions | 2, 4 and 5 regression coverage; retain existing working clock-domain behavior |
| PRR clock gating versus electrical power consumption | 5 regressions; current/power figures excluded under 6 |
| Timer0/Timer1 external pin clocks | Implemented in 3; integer-phase synchronization, fractional electrical phases excluded |
| Shared prescaler/mux startup and asynchronous PSRASY handshake | 5 |
| Reserved Timer1 mode 13 and Timer0/2 modes 4/6 approximations | 5 policy review; keep explicit reserved-mode behavior |
| Timer1 fast-PWM overflow peer disagreement and facade versus measured waveform | 1 waveform tests and 5 calibration |
| Timer2 TOSC/EXCLK, sub-TOSC wake/ack timing, oscillator drift/instability | 5 for selected digital behavior; physical behavior retained under 6 |
| OSCCAL storage-only and DIDR mask-only behavior | 6 |
| SUT/CKSEL startup approximation and fuse-related physical behavior | 5 for deterministic timing; 6 for retained physical scope |
| Flash erase/write duration and wear | 4 implemented deterministic duration/fetch interlock; wear excluded under 6 |
| Exact sleep startup edge and per-bit TWI stretching | 5 and 6 respectively |

## 12. Phase 7 — measured performance work

Status: measured review complete; [profiles, full matrix, repeats and retained tradeoff](docs/evidence/runtime-performance-2026-10-10.md). The bounded stall-helper guard is retained; no new FastBlock or architecture rewrite is selected. Peripheral-bound remains 5-6% slower than baseline on this host, explicitly recorded.

Targets: [opcode profiler](scripts/profile-opcodes.ts), benchmark harnesses, [FastBlocks](src/cpu/fast-blocks.ts), [generated core generator](scripts/generate-fast-core.ts), affected IO hooks, [generated-core tests](test/generated-fast-core.test.ts), and the performance documents.

Current recorded comparisons are host-specific Bun/JavaScriptCore measurements against avr8js 0.21.0. The October ten nontrivial workloads in the older matrix led on seven and trailed on three; the subsequently added peripheral-bound workload was approximately 0.98x. The weak cases include `float-math`, `bitbang-crc`, `delay-blink` and peripheral-bound. Preserve the actual measurement context in [comparison evidence](docs/evidence/benchmark-comparison-2026-10-06.json) and [peripheral-bound evidence](docs/evidence/peripheral-bound-comparison-2026-10-06.json).

- [x] Profile the current revision after relevant fidelity work. Distinguish opcode cost, GPIO hooks, event scheduling, interrupt handling and sleep before choosing an optimization.
- [x] Prioritize bounded soft-float helpers only where their measured hot rows justify it. For bit-banging, investigate hook/read/write overhead while preserving listeners and pin ownership.
- [x] No new FastBlock selected; add FastBlocks only with instruction-state parity, SREG/register/stack checks, event deadline and interrupt-boundary tests. Verify memory and IO effects, not just final benchmark bytes.
- [x] Generate fast-core changes through the generator and require `check:fast-core`; do not hand-edit generated output.
- [x] Compare before/after revisions with identical candidate firmware, inputs and observer configuration. Preserve fixture digest, `fixtureRoot`, actual simulated cycles and raw samples.
- [x] Exclude construction and explicit warmup from steady throughput. Report startup separately. Isolate comparison workloads and run on a quiet machine; vary engine order if order effects are plausible.
- [x] Report serial bytes, pin edges or transaction counts where they explain unequal completed work. Cycles per second alone does not establish equal useful throughput.
- [x] Keep synthetic bulk skips outside practical speed claims. Keep construction-inclusive internal floors separate from steady external comparisons. Do not mix July methodology with October measurements.
- [x] Set regression criteria before each optimization; reject gains that break fidelity or materially regress affected workloads. Store the comparison data and explain the tradeoff.

Optional architecture decisions: region JIT, WASM performance ceiling experiments, and a third simulator speed peer remain separate proposals. They need an explicit goal, toolchain/runtime compatibility plan, correctness guards, maintenance budget and fresh measurements. A rewrite is not a prerequisite for completing this plan.

Acceptance: relevant result oracles and standard/generated parity pass; raw before/after evidence supports the selected improvement; source/package checks pass. Node and browser performance claims need measurements on those runtimes; Bun results alone do not establish them.

Rollback: revert the optimization and regenerate the prior core where necessary. Retain failed experiment evidence as dated history rather than presenting it as a current result.

## 13. Phase 8 — release readiness and publication

Status: selected the still-unpublished 0.1.2 candidate, including all new runtime changes. Registry lookup returned 0.0.0-stage, 0.1.0 and 0.1.1; 0.1.2 remains available. Source/browser/native/package gates passed; archive preparation is in progress. See [local acceptance receipt](docs/evidence/local-acceptance-2026-10-10.json). Git publication, exact-commit CI and npm publication are separate external gates.

Targets: [package manifest](package.json), [changelog](CHANGELOG.md), [README](README.md), release procedure/evidence, package smoke and CI.

- [x] Select a release scope. Decide whether to publish the already prepared `0.1.2` contents or include new runtime changes. Confirm npm registry state and version availability before choosing the final version.
- [ ] Record the intended source commit and changelog. Update limitations and consumer-facing docs for the behavior that actually ships.
- [x] Run the source, browser, package and native gates below. Record individual outcomes and environmental blockers accurately; native dependencies are currently local, not provided by the standard CI matrix.
- [ ] Inspect packed exports, declarations, worker import, package file list and consumer smoke. Verify the artifact is built from the selected clean commit.
- [ ] Repack and record filename, file count, SHA-256, npm SHA-1/integrity and package metadata. The prepared archive identity is reusable only if the packed contents are identical; runtime, README or changelog changes can invalidate it.
- [ ] Verify CI for the exact release commit. A green result for the baseline cannot prove a later revision.
- [ ] Complete `npm.cmd publish --dry-run` and inspect the concrete package before requesting any missing publication authorization.
- [ ] Publish only when explicitly authorized and authentication/ownership are ready. Preserve `prepublishOnly`; never bypass the checks or expose `.npmrc` credentials.
- [ ] After actual publication, verify registry version/integrity, install the published package in a clean consumer, run import/worker smoke, create the matching annotated tag according to the release procedure, and record provenance where available.

Acceptance states must be separate: source validated; browser validated; native probes validated; artifact prepared; Git/CI verified; npm published; published consumer validated. Do not report a dry run, local archive, Git push, or green workflow as npm publication.

Rollback: before publishing, replace the candidate and repeat affected checks. After publishing, use a corrective version and appropriate registry policy; do not attempt to overwrite the same published version or rewrite published Git history.

## 14. Verification commands and change-specific gates

These commands exist today. Run focused meaningful tests during a phase, then the applicable acceptance gates after the final change; do not repeatedly rerun an unchanged full suite without a reason.

```powershell
# Source, generated core, and all Bun tests
bun run verify

# Built package and consumer-facing exports
bun run build:lib
bun run package:smoke

# Current result and native fidelity suites
bun run bench:result
bun run oracle:simavr:compare
bun run oracle:simavr:result
bun run oracle:simavr:timing
bun run oracle:simavr:optiboot
bun run oracle:simavr:runtime

# Browser and release acceptance, including source/build/package gates
bun run release:check

# Package inspection; this does not publish
npm.cmd pack --dry-run
npm.cmd publish --dry-run

# Documentation and patch hygiene
git diff --check
git status --short
```

Use existing benchmark CLI help/options for workload, isolation, warmup, sample count and cycle budget; capture the actual invocation in evidence. New oracle labels and proposed focused tests become runnable only after Phase 1 adds them. Keep fixture rebuild commands (`fixtures:arduino`, `fixtures:avr-gcc`) separate from ordinary source testing and record missing local toolchains honestly.

Consider a reproducible native-oracle CI lane after the toolchain is pinned and installation is demonstrated on the runner. This is an automation improvement, not existing CI coverage. Hardware acceptance likewise requires actual hardware; mark it unrun until measurements exist.

## 15. Completion and handoff checklist

- [x] Each selected phase has a reviewed change, focused regression coverage, evidence links and an updated status here.
- [x] All thirteen current benchmark labels are accounted for, with shared listener firmware identified and workload activity classified.
- [x] Each behavioral limitation in section 11 is implemented with evidence, retained explicitly, or deferred with a concrete scope decision.
- [x] Documentation distinguishes historical completion, current approximations, native disagreement, and physical calibration.
- [x] Any runtime change preserves snapshots and public APIs, or includes a deliberate versioned migration.
- [x] Performance claims identify runtime, host, firmware, methodology, raw samples and useful work where relevant.
- [ ] Final archive preparation records the exact clean source commit and artifact; publication remains separate.
- [x] Unrelated user changes are preserved. Rollbacks use reviewed reversions of the selected changes, not destructive resets.

For each completed batch, report what changed, which meaningful checks passed, what remains, and the next unchecked task. Continue through the selected scope rather than stopping after discovering a single additional bug.

## 16. Current acceptance (2026-10-10)

`bun run release:check` passed: TypeScript/generated checks, 2,845 tests,
18,330 assertions across 80 files, eight Chromium tests and the 85-file packed
consumer smoke. All twelve workload cases pass against both references; native
state, five timing probes, Optiboot and three runtime probes pass their stated
contracts. Native programming-duration and Timer1 TOP differences, unavailable
phase-correct PWM GPIO traces, and the peripheral-bound 5-6% performance cost
remain explicit in the evidence. Remaining wire/physical extensions are retained
or deferred in the scope record, not pending coding promises.
