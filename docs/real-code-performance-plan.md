# Real-Code Performance Plan

Active successor to `docs/performance-plan.md` and
`docs/monolithic-generated-core-plan.md` (that experiment concluded: matching
avr8js's monolithic decode did **not** close the real-code gap — decode was never
the bottleneck, and the monolithic core was removed). This plan targets the gap
that is actually real.

## What we know (measured, 2026-06-30)

Production-representative numbers come from `bench:compare --isolate` (one firmware
per process — how the simulator is really used; the single-process default
co-runs 11 firmwares and megamorphically under-reports avrts ~3x, which is a
benchmark artifact, not production).

- **Synthetic / loop-heavy code: avrts already wins big** — tight-loop 1.93x,
  delay-blink 2.26x, peripheral-mix 1.28x; serial-print/analog-write ~parity. This
  is FastBlocks doing their job. Not a problem to solve.
- **Real compiled code: avrts loses ~1.5x** — dsp-fixed 0.62x, string-heavy 0.57x,
  isr-heavy 0.64x, float-math 0.60x, sensor-format 0.69x, bitbang-crc 0.38x.
- **The gap is layer 2 (the simulation framework), not decode.** Isolated-regime
  ablation (fast core):

  | lever skipped | dsp | string | isr |
  | ------------- | ---- | ------ | ---- |
  | baseline | 0.51 | 0.55 | 0.58 |
  | `notifyCycles` | 0.54 | 0.51 | 0.58 (noise) |
  | clock-event dispatch | 0.63 | 0.61 | 0.69 |
  | IO-hook dispatch | 0.58 | 0.67 | 0.68 |

  So the two real levers are **clock-event dispatch** (`runDueClockEvents` →
  `callback()`, plus the `addClockEvent` re-arm) and **IO-hook dispatch**
  (`readData`/`writeData` hook iteration). `notifyCycles` is noise in production:
  the default `AVR(...)` runtime uses clock events for timers/USART/ADC/watchdog
  and attaches EXTI with `cycleListener: false`; EXTI only keeps an opt-in
  `onCycles` bridge for standalone/legacy use. Decode-ladder depth is ~10% at
  most (hotness ceiling) and is not the gap.

## Strategy

Two levers, both on the single fast core (no second core):

- **Lever A — cheapen layer-2 dispatch.** Broad, low-risk, lifts every real
  fixture. Honest ceiling: even with both dispatch costs at zero, the math puts the
  fixtures at ~0.75-0.93x, so **A alone does not beat avr8js.** Worth doing as the
  floor-lift and because it benefits both the per-instruction path and the inside
  of FastBlocks.
- **Lever B — extend FastBlock coverage to real-code hot loops.** This is the only
  path that can cross 1.0x on real code. A FastBlock runs a recognized
  multi-instruction sequence as one optimized native block, amortizing the
  per-instruction layer-2 cost (cycles setter, clock-event check, hook dispatch)
  across the whole block. It is avrts's unique weapon — avr8js has nothing like it,
  and it is why avrts already wins 2x on loops.

Order: A first (broad floor-lift, de-risks measurement), then B (targeted win on
the specific losing fixtures). They compose — A reduces residual cost outside
blocks; B amortizes it inside.

## Goals

- [ ] Real-code fixtures (dsp-fixed, string-heavy, isr-heavy, float-math) clearly
  improve over today's ~0.6x, measured with `--isolate`.
- [ ] At least the loop-dominated real fixtures reach or pass ~1.0x via FastBlocks.
- [ ] No regression to synthetic FastBlock wins (tight-loop, delay-blink) or to the
  IO-bound near-parity fixtures (serial-print, analog-write, peripheral-mix).
- [ ] Zero correctness regression: `bench:result` keeps matching avr8js for the
  result-covered fixtures (`peripheral-mix`, `isr-heavy`, `string-heavy`,
  `dsp-fixed`); any newly targeted fixture outside that set gets its own oracle or
  explicit parity test. The generated fast core keeps matching the tick()/handler
  interpreter.

## Non-Goals

- [ ] No second execution core. The monolithic core is gone and stays gone.
- [ ] No translate-once / JIT compilation in this plan.
- [ ] Do not optimize for the single-process (mixed-fixture) benchmark regime — it
  is a co-tenancy artifact. All speed claims use `--isolate`.
- [ ] Do not expect to beat avr8js on genuinely IO-bound firmware (e.g. bitbang-crc
  is bit-banged GPIO; it is hook-bound by nature and may never cross 1.0x).

## Phase 0 - Production baseline lock

- [x] Record a fresh `bench:compare --repeats 5 --isolate` table (fast core) for all
  11 fixtures; this is THE reference for every later claim. Paste it below.
- [x] Capture production-path profiles with `profile:opcodes -- --mode fast
  --window ...` for dsp-fixed, string-heavy, float-math — the FastBlock candidates
  for Lever B. Findings below.
- [~] `--mode pc` view deferred — the `--mode fast --window 3` output already gives
  the exact recurring sequence + addresses for each hot loop (below); pull a pc view
  later only if a specific block's two-word/displacement accounting needs it.
- [x] Confirm `bun test` (444 pass), `bun run typecheck`, `bun run check:fast-core`,
  `bun test test/benchmark-results.test.ts` all green.

Baseline (`bench:compare --repeats 5 --isolate`, fast core, best-of-5, 16 MHz,
2026-06-30 — THE reference for every later claim):

```
workload            cycles           avrts          avr8js    avrts/avr8js
--------------------------------------------------------------------------
tight-loop      10,000,000   176,803,082/s    92,568,936/s           1.91x
delay-blink     50,000,000   113,637,500/s    51,595,562/s           2.20x
serial-print     5,000,000    83,473,290/s    76,201,391/s           1.10x
analog-write     5,000,000    83,078,697/s    79,098,029/s           1.05x
sensor-format    5,000,000    34,103,620/s    52,972,218/s           0.64x
float-math       5,000,000    25,627,699/s    43,018,376/s           0.60x
bitbang-crc      5,000,000    16,534,063/s    43,650,586/s           0.38x
peripheral-mix   5,000,000    77,377,341/s    58,899,475/s           1.31x
isr-heavy        5,000,000    30,784,993/s    47,323,031/s           0.65x
string-heavy     5,000,000    30,907,143/s    53,962,813/s           0.57x
dsp-fixed        5,000,000    31,004,906/s    55,867,357/s           0.55x
```

Matches the measured "what we know" numbers above (synthetic/IO wins intact; the
six real fixtures sit at 0.38-0.69x). `bun test` (444 pass), `typecheck`, and
`check:fast-core` all green at this baseline.

Hot-loop profiles (`profile:opcodes --mode fast --window 3`, 5M cycles):

- **dsp-fixed.** One loop dominates: an **ADC busy-wait poll** —
  `0x021b LDS r24,[0x007a=ADCSRA]; 0x021d SBRC r24,6 (ADSC); 0x021e RJMP -4` —
  **~44% of cycles** (17.8 + 8.9 + 17.7). This is `while (ADCSRA & _BV(ADSC));`
  from `analogRead`. The only other big share is `0x03c2 MUL` already running as the
  `umulhisi3` FastBlock (~14%). So dsp-fixed is **dominated by a peripheral poll
  spin**, not arithmetic — exactly the intersection of Lever A (the spin pays
  IO-hook read + clock-event-advance per iteration) and Lever B (a poll-skip block).
- **string-heavy.** Same ADC poll loop at `0x0403`, but only **~10%** of cycles;
  the rest is spread across many small loops: a counted `SBIW;BRNE` delay
  (`0x079f`, ~2.6%), a multi-byte `ADD;ADC;DEC;BRNE` accumulate (`0x01f1`), an
  itoa-style `ADD;ADC;ADC;CP;BRCS;…;SUBI;BRNE` divide (`0x0835`), and a **strcpy**
  `LD_Zinc;ST_Xinc;AND;BRNE` (`0x0ab9`). No single dominant block; the strcpy and
  the ADC poll are the cleanest Lever-B candidates.
- **float-math.** No dominant loop; cycles spread thin (top opcode ~1.8%) across
  softfloat kernels — a 32-bit shift-normalize loop `LSR;ROR;ROR;ROR;SBCI;INC;BRNE`
  (`0x0298`, ~7% combined) and add/round kernels (`ADD;ADC;BST;BREQ;CPI;…`). The
  shift-normalize loop is the only obvious block; otherwise float-math is the
  fixture **least amenable to Lever B** and most reliant on Lever A's broad lift.

Takeaway for sequencing: the **ADC poll loop** is the single highest-value target
(dsp 44%, string 10%) and benefits from *both* levers — do Lever A first (it
directly cheapens each spin iteration and de-risks measurement), then a poll-skip
FastBlock in Lever B for the decisive dsp-fixed win.

## Phase 1 - Lever A: cheapen layer-2 dispatch

Each item is an experiment: change, then measure with `--isolate` (NOT
single-process), keep only if it moves the real fixtures without regressing
synthetic/correctness.

- [x] **IO-hook fast path. KEPT.** `readData`/`writeData` now take a `length === 1`
  direct-call fast path (the overwhelmingly common case — one hook per hooked
  address) and an indexed `for` loop instead of `for...of` for the rare multi-hook
  case. Measured `--isolate`, two full samples vs baseline (variance ~4%):

  | fixture     | baseline | s1   | s2   | verdict           |
  | ----------- | -------- | ---- | ---- | ----------------- |
  | bitbang-crc | 0.38     | 0.41 | 0.41 | **+8% (kept)**    |
  | dsp-fixed   | 0.55     | 0.63 | 0.62 | **+~10% (kept)**  |
  | isr-heavy   | 0.65     | 0.68 | 0.66 | +2-5%             |
  | sensor-fmt  | 0.64     | 0.64 | 0.68 | flat/up           |
  | string-heavy| 0.57     | 0.60 | 0.56 | flat (noise)      |
  | analog-write| 1.05     | 0.99 | 1.03 | flat (s1 = noise) |
  | peripheral  | 1.31     | 1.25 | 1.32 | flat (s1 = noise) |

  Consistent wins on the hook-bound fixtures (bitbang +8%, dsp +~10% — both 2/2
  samples), small lifts on isr/sensor, no regression on any fixture across both
  samples (the s1 dips on analog-write/peripheral-mix recovered in s2). `bun test`
  444 pass, `typecheck`, `check:fast-core`, result oracles all green. Note:
  string-heavy moved less than expected — its USART hook is hot but its cycles are
  spread thin (Phase-0 profile), so it leans more on Lever B.
- [x] **Clock-event re-arm cost. NOT WORTH IT (measured, no change made).** Option
  (c) first: a throwaway probe wrapped `addClockEvent`/`clearClockEvent` and ran the
  real fixtures for 1M cycles. `addClockEvent` fires **rarely** — 0.13/1k cyc
  (bitbang), 0.25 (string), 0.33 (analog), 1.0 (dsp), 4.9 (isr, the worst) — and the
  queue is **tiny** (avg 2-3 nodes, max 4). So both O(n) scans touch ≤4 nodes a
  handful of times per 1000 instructions: ~tens of pointer compares per 1k cycles,
  far below the ~4% noise floor. Linked-list order maintenance is **not visible** at
  this event count; options (a)/(b) would optimize a non-cost. Left `addClockEvent`
  unchanged. (The clock cost the earlier ablation found is the *per-instruction
  guard* + the megamorphic `callback()` dispatch, not the re-arm — the guard is
  addressed by the next item.)
- [x] **`cycles` setter shape. KEPT.** Reshaped the per-instruction hot path (the
  setter runs on every fast-core instruction via `cpu.cycles += N`): (1) replaced the
  per-instruction `this.timing !== "cycle-exact"` *string* compare with a boolean
  `cycleExact` mirror (set via a `timing` accessor); (2) inlined the empty-listener
  check so the `notifyCycles()` call frame is skipped entirely when no cycle
  listeners are wired (the production case); (3) replaced the queue-head pointer
  deref `nextClockEvent.cycles` with a cached scalar `nextEventAt` (+Infinity when
  idle), kept in sync at the few cold head-mutation sites (`addClockEvent`,
  `clearClockEvent`, `runDueClockEvents`, `reset`, `restore`). Guard is now a single
  numeric compare. Measured `--isolate`, two samples vs the post-item-1 reference:

  | fixture     | item-1 ref | item-3 s1 | item-3 s2 | item-3 effect |
  | ----------- | ---------- | --------- | --------- | ------------- |
  | dsp-fixed   | 0.62       | 0.65      | 0.66      | **+~5% (2/2)**|
  | sensor-fmt  | 0.66       | 0.71      | 0.69      | **+~5% (2/2)**|
  | bitbang-crc | 0.41       | 0.43      | 0.42      | +small (2/2)  |
  | string-heavy| ~0.58      | 0.61      | 0.60      | +small        |
  | isr/float/synthetic | —  | —         | —         | flat, no regress |

  Kept. `bun test` 444 pass, `typecheck`, `check:fast-core`, timing tests
  (`phase12-timing`) all green — the timing accessor + scalar mirror preserve
  cycle-exact behavior and snapshot/restore.

Exit gate (Lever A) — combined item-1 + item-3 vs the **Phase-0 baseline**:

| fixture       | baseline | Lever A  | gain     |
| ------------- | -------- | -------- | -------- |
| dsp-fixed     | 0.55     | 0.65-66  | **+~19%**|
| bitbang-crc   | 0.38     | 0.42-43  | **+~12%**|
| sensor-format | 0.64     | 0.69-71  | **+~9%** |
| string-heavy  | 0.57     | 0.60-61  | **+~6%** |
| isr-heavy     | 0.65     | 0.66-67  | +~3%     |
| float-math    | 0.60     | 0.58-60  | flat (least hookable — leans on Lever B) |
| tight/delay/serial/analog/peripheral | — | — | no regression |

Lever A delivered the expected broad floor-lift (real fixtures +6-19%, none regressed;
synthetic wins intact). As predicted it does **not** cross 1.0x on real code — that is
Lever B's job. The standout, dsp-fixed (+19%), still has its 44%-of-cycles ADC poll
spin untouched; the poll-skip FastBlock in Lever B targets exactly that.

Exit gate:

- [x] Real fixtures improve measurably under `--isolate` (dsp +19%, bitbang +12%,
  sensor +9%, string +6%); no synthetic regression.
- [x] `bun test test/benchmark-results.test.ts` still matches avr8js for the
  result-covered fixtures; `bun test` (444 pass) + `check:fast-core` green.
- [x] Recorded before/after `--isolate` deltas per item: item-1 (IO-hook) kept,
  item-2 (re-arm) measured and skipped as a non-cost, item-3 (setter) kept.

## Phase 2 - Lever B: FastBlocks for real-code hot loops

The actual win condition. FastBlocks already exist for synthetic/library loops
and helper shapes (`rjmp-self`, `zero-sbiw-breq`, counted shifts,
`arduino-micros`, `subcmp-run`, `__udivmodsi4`, `__umulhisi3`). Extend the same
machinery to the inner loops of real fixtures.

- [x] From Phase 0's hot-loop profiles, identified the dominant sequence: the
  **ADC busy-wait poll** `LDS rd,addr; SBRC/SBRS rd,b; RJMP -4`, shared by dsp-fixed
  (44% of cycles), isr-heavy, peripheral-mix, and string-heavy. This — not the FIR
  arithmetic — is the single biggest cross-fixture target. (string-heavy's strcpy
  and float-math's softfloat kernels remain as possible later blocks.)
- [x] **Poll-wait FastBlock added.** Triggered from the rjmp arm only for the exact
  poll offset (`k = 0x0ffc`, RJMP -4) so it never taxes ordinary RJMPs; the existing
  rjmp-self trigger (`0x0fff`) is unchanged. Surfaces wired single-source:
  `GENERATED_ARMS` rjmp arm broadened in both `body` and `profiledBody`;
  `classifyFastBlock` + `isPollWaitLoop` detector; `FAST_BLOCK_POLL_WAIT` dispatch →
  `runPollWaitBlock`; `FastBlockProfileKind` gained `"poll-wait"`. The block reuses
  `bulkIdleLoopIterations` to fast-forward whole 5-cycle traversals (RJMP 2 + LDS 2 +
  SBRC/SBRS no-skip 1), keeping `pc` at the RJMP — bit-identical to spinning.
  **Safety:** declines unless the polled address has no read hook (so the LDS is a
  pure data read); the shared guard refuses to cross the target, a clock event, a
  cycle listener, cycle-exact timing, or an enabled pending interrupt.
  - **Correctness bug found + fixed during bring-up:** the first version blindly
    fast-forwarded to the next clock event, but the SBRC/SBRS tests a *stale*
    register loaded *before* the prior event already changed the polled byte — so
    the loop was due to exit on the next LDS, and the block skipped past it (parity
    diverged by thousands of cycles). Fix: `runPollWaitBlock` reads the *current*
    `data[addr]` and declines (lets the normal path exit) when the byte already
    satisfies the skip condition; it only fast-forwards while the byte still keeps
    the loop spinning. A focused divergence probe localized this.
- [x] Added focused parity/guard tests (`test/cpu.test.ts`, 7 new): block === tick()
  on an event-cleared poll (SBRC and SBRS variants), declines+matches on an event
  that leaves the bit set (no skip over the event), the stale-value `willExit`
  decline, per-instruction cycle-listener preservation, cycle-exact decline, and a
  `profileRun` `blockKind === "poll-wait"` assertion.

Exit gate:

- [x] Targeted real fixtures improve clearly under `--isolate` (two samples each, vs
  the post-Lever-A reference): **dsp-fixed 0.65→0.72-0.73 (+~10%), isr-heavy
  0.66→0.72-0.74 (+~9%), peripheral-mix 1.30→1.44-1.46 (+~11%)**, string-heavy
  0.60→0.62-0.63 (+~4%). The loop-dominated dsp/isr did **not** cross 1.0x: the poll
  is only 44% of dsp's *sim cycles* but a smaller share of *host time* (the spin
  instructions are cheap; the FIR/`umulhisi3` arithmetic dominates host cost), so
  collapsing it lifts but does not equalize. Honest result: a clear win, parity not
  reached on the arithmetic-bound fixtures.
- [x] Poll-wait block has parity/decline coverage; result oracles
  (`bench:result`-covered dsp-fixed, string-heavy, isr-heavy, peripheral-mix) still
  match avr8js (`test/benchmark-results.test.ts` green).
- [x] No regression to existing FastBlock fixtures or correctness: `bun test` 451
  pass; synthetic wins intact (tight ~1.9x, delay ~3.0x, serial ~1.1x, analog 1.05x).
- [x] Single-source generator contract intact: block defined once in the generator;
  fast + profiled ladders regenerated; `check:fast-core` green.

## Phase 3 - Decision and consolidation

Final `--isolate` table (best-of-5, two samples; ratio vs avr8js) after Lever A
(IO-hook fast path + setter reshape) and Lever B (poll-wait block), vs the Phase-0
baseline:

| fixture        | Phase-0 | final     | gain    | notes |
| -------------- | ------- | --------- | ------- | ----- |
| dsp-fixed      | 0.55    | 0.72-0.73 | **+32%**| poll collapsed; arithmetic-bound below 1.0x |
| isr-heavy      | 0.65    | 0.72-0.74 | **+12%**| poll + IO-hook |
| sensor-format  | 0.64    | 0.69-0.72 | **+~10%**| setter reshape |
| bitbang-crc    | 0.38    | 0.42-0.43 | **+~12%**| IO-hook; structurally GPIO-bound |
| string-heavy   | 0.57    | 0.62-0.63 | **+~10%**| IO-hook + small poll share |
| float-math     | 0.60    | 0.61      | flat    | no dominant loop; softfloat-bound |
| peripheral-mix | 1.31    | 1.44-1.46 | +~11%   | already winning; poll + IO-hook |
| tight-loop     | 1.91    | ~1.9x     | flat    | synthetic win intact |
| delay-blink    | 2.20    | ~3.0x     | up      | synthetic win intact |
| serial-print   | 1.10    | ~1.1x     | flat    | IO-bound near-parity intact |
| analog-write   | 1.05    | 1.05x     | flat    | IO-bound near-parity intact |

- [x] Re-ran the full `--isolate` table; compared to Phase 0. Every real fixture
  improved (+10-32%) except float-math (flat, as predicted — it has no dominant
  loop); no synthetic/IO fixture regressed.
- [x] Plainly: **no real fixture crosses 1.0x** yet. dsp-fixed/isr-heavy got the
  biggest lift but remain arithmetic/ISR-bound; bitbang-crc is structurally
  GPIO-hook-bound (bit-banged IO) and will not reach parity by these levers;
  float-math is softfloat-kernel-bound with no single hot loop. The fixtures that
  beat avr8js are the synthetic/IO ones (tight-loop, delay-blink, serial-print,
  analog-write, peripheral-mix), unchanged. So: real-code gap **narrowed from ~1.5x
  to ~1.3-1.4x**, banked, but not closed.
- [x] **Decision: stop here with the gains banked.** The two levers delivered a
  broad floor-lift (Lever A) plus a targeted win on the one cross-fixture hot loop
  (Lever B), all correctness-preserving. Crossing 1.0x on the arithmetic-bound
  fixtures (dsp FIR, float softfloat) would need either more FastBlocks for those
  specific kernels (diminishing returns — each is fixture-specific) or a
  translate-once JIT (explicitly out of scope). The sim already runs comfortably
  faster than realtime on every fixture. Remaining FastBlock candidates if pursued
  later: string-heavy's strcpy (`LD_Zinc; ST_Xinc; AND; BRNE`) and float-math's
  shift-normalize kernel — both noted in the Phase-0 profiles above.

## Required Verification

```powershell
bun test
bun run typecheck
bun run check:fast-core
bun test test/benchmark-results.test.ts
bun run bench:compare -- --repeats 5 --isolate
```

`--isolate` is mandatory for any real-code speed claim: it measures one firmware
per process (production), where the fast core is monomorphic. The single-process
default co-runs all fixtures and megamorphically under-reports avrts ~3x; use it
only for the synthetic/IO-bound fixtures, which are insensitive to the artifact.

`bench:result` currently has avr8js result oracles for `peripheral-mix`,
`isr-heavy`, `string-heavy`, and `dsp-fixed`; `float-math`, `sensor-format`, and
`bitbang-crc` still rely on generated-core parity unless this plan adds a focused
result oracle for them.
