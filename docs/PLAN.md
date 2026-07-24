# Review Fix Plan

## Implementation status (through 2026-07-13)

- [x] Item 1: host loop lifecycle fixed and covered for interval, raf, and restore paths.
- [x] Item 2: `useHex()` / `reload()` now parse before mutating runtime state.
- [x] Item 3: `useClock()` now rejects non-positive and non-finite clocks, including `use({ clockHz: 0 })`.
- [x] Item 4: serial text path now decodes streaming UTF-8 (2026-07-02); `onByte`
      stays raw, partial sequences are dropped on `clear()`/`reset()`/`restore()`,
      invalid bytes decode to U+FFFD.
- [x] Item 5: `CPU.udivmodsi4RegionMode` now has a per-instance selector defaulting from the static value.
- [x] Item 6: packaging completed (2026-07-13): `0.1.0` ESM/declaration output,
      explicit root/browser/advanced exports, packed Node/Bun/browser consumer
      smoke tests, and CI gates. The cpu.ts split was completed on 2026-07-02.

Findings from the 2026-07-02 library review, ordered by priority. Items 1–3
started as code fixes and items 4–6 as smaller/deferred work; all are now
closed, with packaging completed by the 2026-07-13 production review.

---

## 1. Loop lifecycle: resume after breakpoint freezes the sim (bug)

### Problem

`reportDebugState()` (src/avr.ts) cancels the host loop on a breakpoint/error
but leaves `running = true`, and `resume()` never reschedules the loop:

- **`setInterval` path (Bun/Node):** interval is cleared → after `resume()` the
  status says running-and-not-paused but time never advances. Frozen.
- **`requestAnimationFrame` path (browser):** the executing tick reschedules
  itself anyway (the guard checks only `!this.running`), so the cancel is a
  no-op and the raf loop spins empty frames while "paused". Resume only works
  in the browser by accident.

Also pre-existing and related: user `pause()` leaves the loop running, burning
host frames doing nothing.

### Fix (full): loop exists only while `running && !paused`

Make pausing — user-initiated or debug-initiated — always cancel the loop, and
make `resume()` always reschedule it. One invariant, both drivers consistent,
no wasted frames.

All changes in `src/avr.ts`:

**a. `pause()` — cancel the loop:**

```ts
pause(): this {
  if (!this.running || this.paused) return this;
  this.paused = true;
  this.cancelLoop();
  this.emit("pause");
  return this;
}
```

**b. `resume()` — reschedule the loop:**

```ts
resume(): this {
  if (!this.running) return this.start();
  if (!this.paused) return this;
  this.paused = false;
  this.lastHostFrameMs = this.nowMs();
  this.scheduleLoop();
  this.emit("resume");
  return this;
}
```

**c. `scheduleLoop()` — two changes:**

Guard against double-scheduling at the top:

```ts
private scheduleLoop(): void {
  if (this.loopHandle !== null) return;
  ...
```

Fix the raf reschedule guard at the bottom of `tick` (this is what defeats the
cancel today). Reschedule only while the loop should be live:

```ts
// reportDebugState (called by frame -> runCycles) may have paused on a
// breakpoint or captured error, and pause()/stop() may have cancelled the
// loop. Only reschedule while actively running.
if (!this.running || this.paused) return;
if (this.loopUsesRaf) this.loopHandle = raf!(tick);
```

Note: in the raf path, `cancelLoop()` during the executing tick cancels an
already-fired handle (no-op) — the `paused` check above is what actually stops
the chain. `loopHandle` may then hold a stale fired handle; set it to `null`
explicitly when the tick decides not to reschedule, so the
`scheduleLoop()` double-schedule guard can't be fooled:

```ts
if (!this.running || this.paused) {
  this.loopHandle = null;
  return;
}
```

**d. `reportDebugState()` — unchanged in spirit, now consistent:** it already
does `cancelLoop(); this.paused = true; this.emit("pause")`. With (a)–(c) this
is exactly the same behavior as a user `pause()`, and `resume()` recovers from
it on both drivers.

**e. `restore()` — schedule only when actually running un-paused:**

```ts
if (snap.runtime.running) {
  this.running = true;
  this.paused = snap.runtime.paused;
  this.lastHostFrameMs = this.nowMs();
  if (!this.paused) this.scheduleLoop();   // was: always scheduleLoop()
}
```

A snapshot restored in the paused state gets its loop back from `resume()`.

### Tests (add to test/avr.test.ts or a new test/loop-lifecycle.test.ts)

Bun has no `requestAnimationFrame`, so plain tests exercise the interval path;
stub `globalThis.requestAnimationFrame`/`cancelAnimationFrame` to cover raf.

1. **Breakpoint → resume advances (interval path):** load a program, set a
   breakpoint, `start()`, wait for the `"breakpoint"` event, assert paused;
   `resume()`, wait one host tick (~32 ms), assert `status().cycles` advanced.
   This is the frozen-sim regression test — it fails on current code.
2. **pause() cancels, resume() restarts:** `start(); pause();` assert no cycle
   advance across a host tick; `resume();` assert advance resumes.
3. **raf loop stops while paused:** with a stubbed raf that records scheduled
   callbacks, hit a breakpoint and assert no further callbacks are scheduled
   after the pause; `resume()` schedules again.
4. **restore of a running-paused snapshot:** loop is not scheduled until
   `resume()`; restore of a running-unpaused snapshot resumes advancing.
5. **No double loop:** `start(); resume(); start();` — with the stubbed raf /
   interval spy, assert only one live loop handle.

---

## 2. `useHex()` failure leaves inconsistent state

### Problem

`useHex` (src/avr.ts) sets `programSource = hex` and zeroes flash *before*
parsing. Malformed hex throws, destroying the previous program, skipping
`reset()`, and leaving `status().programLoaded === true` for a program that
never loaded.

### Fix

Parse into a scratch buffer first, commit only on success (the loader already
exports `parseHex` which does exactly this):

```ts
useHex(hex: string): this {
  const parsed = parseHex(hex);        // throws IntelHexError before any mutation
  this.cpu.flash.set(parsed);
  this.programSource = hex;
  this.reset();
  this.emit("load");
  return this;
}
```

Apply the same pattern to `reload()`.

### Tests

- Load program A, then `useHex(garbage)` → throws `IntelHexError`; assert
  program A still runs (`runCycles` advances PC as before) and
  `status().programLoaded` still reflects A.
- `AVR(garbage)` throws and does not emit `"load"`.

---

## 3. `useClock()` accepts invalid values

### Problem

`frame()` and `setSpeed()` validate with helpful messages; `useClock(0)` or a
negative value silently poisons `frame()` cycle math and `status().timeMs`.

### Fix

```ts
useClock(clockHz: number): this {
  if (!Number.isFinite(clockHz) || clockHz <= 0) {
    throw new Error(`useClock(clockHz) expects a positive finite number, got ${clockHz}.`);
  }
  this.clockHz = clockHz;
  this.watchdog.setClock(clockHz);
  return this;
}
```

### Tests

`useClock(0)`, `useClock(-16e6)`, `useClock(NaN)` all throw; valid value still
works via `use({ clockHz })` too.

---

## 4. Serial text is Latin-1 per byte (scope decision)

`emitSerialByte` uses `String.fromCharCode(byte)`, so UTF-8 firmware output
(e.g. `Serial.print("é")`) is mojibake in `getText()`/`onText`. If fixing:
decode through a streaming `TextDecoder("utf-8", { stream: true })` for the
text path while keeping `onByte` raw; reset the decoder in `setSerialText("")`
and on `reset()`. Mirrors the existing `TextEncoder` on the RX side
(src/peripherals/usart.ts). Decide scope before implementing — ASCII-only may
be acceptable for now; document it either way.

## 5. `CPU.udivmodsi4RegionMode` is static mutable state

One benchmark script flipping it affects every CPU instance in the process.
Move to an instance field defaulting from the static (keeps the benchmark
lever), or a constructor option. Low risk, mechanical.

## 6. Packaging / structural

- **Packaging (completed 2026-07-13):** `package.json` now builds ESM plus
  declarations, defines `avrts`, `avrts/browser`, and `avrts/advanced` exports,
  restricts tarball contents, and runs a real `npm pack` -> install -> Node/Bun
  import -> browser bundle smoke test. `prepublishOnly` runs the release gate.
- **Release ownership still required:** licensing and canonical repository/npm
  publishing credentials are owner decisions recorded in `RELEASING.md`.
- **cpu.ts size:** ~2,000 lines and growing one fast block per perf commit.
  Extract the classifier/guard/runner triples into `src/cpu/fast-blocks.ts`
  (or fold more into the generator) before it hits 3,000. Pure move, no
  behavior change; `bun run check:fast-core` and the parity tests gate it.

---

## Validation

After each item:

```
bun test
bunx tsc --noEmit
```

After item 1 also run the browser demo (`bun run demo`) and check
breakpoint → resume manually in the raf path.
