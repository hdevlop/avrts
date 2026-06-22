# Build Plan — AVR/ATmega328P Simulator in TypeScript

> Read `01-how-it-works.md` first. This plan turns that model into code, in
> small runnable steps. Target chip: **ATmega328P**. Board-specific presets can
> come later; v1 runs ATmega328P-class AVR binaries.
> Stack: Bun + TypeScript. Each phase ends with something you can run/test.
>
> After Phase 9, continue with `05-core-improvements.md` for snapshot/restore,
> debugger support, browser simulator needs, timing precision, and peripheral
> fidelity.

---

## Guiding principles

- **One chip, done right.** ATmega328P only. No abstraction for other chips yet.
- **Always runnable.** Every phase produces a green test or a visible result.
- **Datasheet-driven.** Implement each instruction by reading its spec; write a
  unit test asserting the exact result before moving on.
- **Core first, compiler last.** We can run hand-written opcodes and pasted
  `.hex` long before we automate compiling `.ino` files.

---

## Target file structure

> Conventions in `03-coding-style.md`: every module folder has one `types.ts`
> (shared/public types) + one `index.ts` (barrel); classes use decorators for dispatch.

```
avrts/
├─ docs/
│  ├─ 01-how-it-works.md
│  ├─ 02-build-plan.md
│  ├─ 03-coding-style.md
│  └─ 04-consumer-dx.md
├─ src/
│  ├─ avr.ts               # public AVR(...) factory + facade type
│  ├─ core/                # shared decorators + registry (@Op, @OnWrite)
│  │  ├─ decorators.ts
│  │  ├─ types.ts          # OpEntry, registry types
│  │  └─ index.ts          # barrel
│  ├─ cpu/
│  │  ├─ cpu.ts            # CPU class: flash, data, PC, cycles, helpers
│  │  ├─ instructions.ts   # @Op-decorated handlers + Decoder
│  │  ├─ sreg.ts           # flag get/set helpers
│  │  ├─ types.ts          # shared/public CPU types/interfaces/enums
│  │  └─ index.ts          # barrel (the only public door to cpu/)
│  ├─ peripherals/
│  │  ├─ gpio.ts           # PORTB/C/D, DDR, PIN, pin-change listeners
│  │  ├─ timer.ts          # Timer0/1/2
│  │  ├─ usart.ts          # Serial
│  │  ├─ types.ts          # shared/public peripheral types
│  │  └─ index.ts          # barrel
│  ├─ loader/
│  │  ├─ intel-hex.ts      # parse .hex -> flash
│  │  ├─ types.ts
│  │  └─ index.ts          # barrel
│  └─ index.ts             # top-level public API barrel (re-exports modules)
├─ test/
│  ├─ instructions.test.ts
│  ├─ gpio.test.ts
│  └─ blink.test.ts
└─ examples/
   └─ blink/               # blink.ino + blink.hex + a runner
```

---

## Phase 0 — Scaffolding  *(½ day)*

**Goal:** folders, test runner, constants.

- Create `src/`, `test/`, `examples/` per the tree above.
- Add npm scripts in `package.json`: `test` -> `bun test`, `dev` -> `bun run src/index.ts`.
- Create `src/cpu/constants.ts` with the memory-map addresses
  (`PORTB=0x25`, `DDRB=0x24`, `SREG=0x5F`, `SPL=0x5D`, `SPH=0x5E`,
  `SRAM_START=0x100`, `RAM_END=0x8FF`, `FLASH_WORDS=0x4000`, etc.).
- **Enable decorators:** add `"experimentalDecorators": true` to `tsconfig.json`
  (required by the class+decorator style — see `03-coding-style.md`) *before* any
  decorated class exists, to avoid a first-build surprise. Scaffold `src/core/`
  (the `@Op`/`@OnWrite` decorators + registry) and a `types.ts` + `index.ts`
  barrel in each module folder.
- Scaffold the future consumer facade at `src/avr.ts`: export an `AVR(...)`
  factory function and public `AVR` interface shape, but no simulator behavior yet.
  Internally this can later create an `AVRRuntime` class; consumers should not need
  `new`.

**Done when:** `bun test` runs (even with zero tests) and `bun run src/index.ts` prints something.

---

## Phase 1 — CPU shell (no instructions yet)  *(1 day)*

**Goal:** the data structures and accessors from §2 of the concept doc.

- `cpu/cpu.ts`: a `CPU` class holding
  - `readonly flash: Uint16Array`
  - `readonly data: Uint8Array` (size `0x900`)
  - `pc: number`, `cycles: number`
  - `get SP()/set SP()` mapped to `data[0x5D/0x5E]`
  - `readData(addr)` / `writeData(addr, value)` (writeData is the hook point for
    peripherals later)
- `cpu/sreg.ts`: helpers to get/set the C, Z, N, V, S, H, T, I bits in `data[0x5F]`.
- Initialize `SP = RAMEND (0x8FF)` and `pc = 0` in a `reset()`.

**Done when:** a test can construct a CPU, write/read `data[]`, and set/read each SREG flag.

---

## Phase 2 — First instructions + the execute loop  *(2–3 days)*

**Goal:** the fetch-decode-execute engine running a tiny hand-written program.

- `cpu/instructions.ts`: `executeInstruction(cpu)` that fetches `flash[pc]`,
  matches the bit pattern, executes, advances `pc`, adds cycles.
- Implement this starter set (enough to do arithmetic + a loop + I/O):
  - `NOP`, `LDI Rd,K`, `MOV`, `ADD`, `ADC`, `SUB`, `SUBI`
  - `OUT A,Rr`, `IN Rd,A`  (talk to I/O space)
  - `RJMP k`  (relative jump — makes infinite loops)
- ⚠️ **I/O-address translation:** `A` in `IN`/`OUT` (and later `SBI`/`CBI`) is an
  *I/O address* (0x00–0x3F), not a data address. Access it as `data[A + 0x20]`, so
  `OUT 0x05` writes PORTB at `data[0x25]`. Skip this and all GPIO/SREG I/O is wrong.
- Add `cpu.tick()` = run one instruction; `cpu.run(maxCycles)` = loop.
- 🔎 **Add debugging hooks now, not later:** on an unknown opcode, throw a rich
  error including `pc` (word *and* byte address), the raw `opcode` in hex, and the
  next word (for 32-bit instrs). Add an optional `cpu.onTrace(state => …)` callback
  fired per instruction (pc, opcode, mnemonic, cycles). This makes Phases 3–6 far
  less painful once real binaries run.

**Test:** hand-assemble (write the opcodes as numbers) a 4–5 instruction program
that adds two numbers and `OUT`s the result; assert the destination register,
the SREG flags, the PC, and the cycle count.

**Done when:** a hand-written opcode program produces the exact expected register/flag state.

---

## Phase 3 — Enough instructions to run real compiled code  *(3–5 days)*

**Goal:** branches, the stack, and memory access — so loops, `if`, and function
calls work.

- Compare: `CP`, `CPC`, `CPI`
- Branches (test one SREG bit): `BRNE`, `BREQ`, `BRCS`, `BRCC`, `BRGE`, `BRLT`, `BRPL`, `BRMI`
- Immediate & carry arithmetic: `SBC`, `SBCI`, `ANDI`, `ORI` (avr-gcc leans on
  these constantly — most constant math/logic compiles to the immediate forms)
- Logic & shift: `AND`, `OR`, `EOR`, `COM`, `NEG`, `INC`, `DEC`, `LSL`, `LSR`,
  `ROL`, `ROR`, `ASR`, `SWAP`
- Skip ops: `CPSE`, `SBRC`, `SBRS`, `SBIC`, `SBIS`  (see the skip-rule warning below)
- I/O bit set/clear: `SBI`, `CBI`  (with the `+0x20` translation from Phase 2)
- Stack + calls/jumps: `PUSH`, `POP`, `RCALL`, `CALL`, `RET`, `JMP`
- Memory: `LD`/`ST` (X,Y,Z with +/-), `LDD`/`STD`, `LDS`, `STS`, `LPM`
- 16-bit helpers: `MOVW`, `ADIW`, `SBIW`
- ⚠️ **Two-word (32-bit) instructions:** `CALL`, `JMP`, `LDS`, `STS` occupy two
  flash words — the operand is `flash[pc+1]`, and `pc` advances by **2**, not 1
  (their cycle costs are higher too). Include `JMP` because real avr-gcc binaries
  open with a `JMP`-based interrupt vector table (ATmega328P has >8 KB flash, so
  vectors use `JMP`, not `RJMP`) — without it you can't even reach `main`.
- ⚠️ **Skip-instruction word counting:** `CPSE`, `SBRC`, `SBRS`, `SBIC`, `SBIS`
  skip the *next instruction* when their condition holds. If that next instruction
  is a 32-bit one (`CALL`/`JMP`/`LDS`/`STS`), you must advance `pc` by **2 words,
  not 1** (and charge 3 cycles, not 2). Peek the next opcode to decide. An
  off-by-one here silently desyncs all later execution.
- 🧱 **Define stack helpers before `CALL`/`RET`:** `pushByte(v)` writes `data[SP]`
  then `SP--`; `popByte()` does `SP++` then reads `data[SP]` (the stack grows
  *down*). Build `pushWord`/`popWord` on top. ⚠️ A return address is a **word PC**
  stored as **2 bytes**: `RCALL`/`CALL` push `pc`, `RET`/`RETI` pop it back — get
  the byte order consistent between push and pop. Test these helpers in isolation
  *before* wiring up the call/return instructions.

**Test:** a hand-written subroutine call + loop; verify stack push/pop balance and
final result. Keep one unit test per instruction asserting datasheet results.

**Done when:** loops and `CALL`/`RET` work and the stack stays balanced.

### Shortlist — minimum instruction set for the first real avr-gcc Blink

When you load a real compiled (tight-loop) blink in Phase 5, avr-gcc's output —
*including the C-runtime startup before `main`* — already needs roughly this set
working. Implement these first so bring-up isn't whack-a-mole:

```
JMP RJMP RCALL CALL RET           control flow + the vector-table jumps
LDI MOV MOVW CLR(=EOR Rd,Rd)      register setup (CLR is an EOR alias gcc emits)
IN OUT SBI CBI                    I/O access (remember +0x20)
LD ST LDS STS LPM                 memory + flash→RAM copy in startup
ADD ADC SUB SUBI SBC SBCI         arithmetic
AND ANDI OR ORI EOR COM           logic
CP CPC CPI CPSE                   compare + skip
BRNE BREQ BRCS BRCC               the branches gcc uses most
INC DEC ADIW SBIW                 counters / pointer math
PUSH POP NOP                      stack + filler
```

The startup code zero-fills BSS, copies initialized data from flash to SRAM (a
small `LPM`+`ST` loop), sets `SP = RAMEND`, then jumps to `main`. If any of the
above is missing you'll typically desync *inside that loop* — before `setup()`
ever runs — so get this set green first.

---

## Phase 4 — Load real programs (Intel HEX)  *(1 day)*

**Goal:** stop hand-writing opcodes; load compiled output.

- `loader/intel-hex.ts`: parse Intel HEX text -> fill `flash` (Uint16Array).
  Handle record types 00 (data) and 01 (EOF).
  - **Validate each line's checksum** (the last byte is the two's-complement of
    the sum of all preceding bytes); throw on mismatch to catch corrupt input.
  - **Address mapping (precise rule):** HEX records carry *byte* addresses, but
    `flash` is indexed by *word*. The byte at HEX address `addr` belongs in
    `flash[addr >> 1]`; two consecutive bytes form one **little-endian** word
    (even address = low byte, odd address = high byte).
  - (Optional) support record type 04 (extended linear address) — unneeded for
    32 KB flash but harmless.
- 🥇 **Golden fixtures:** compile one tiny C/Arduino program with the real
  toolchain and commit *both* its `.hex` and the `avr-objdump -d` disassembly
  under `examples/`. Treat the disassembly as ground truth — it catches address,
  endianness, and vector-table bugs that hand-written opcodes never will.
- Keep `loadHex()` as the loader utility and an advanced export, but the main DX
  should not require consumers to call it. `AVR(hexText)`, `AVR({ hex })`, and
  `.useHex(hexText)` all parse/load internally.

**Test:** parse a small known `.hex`, assert specific flash words, and assert a
line with a deliberately wrong checksum is rejected.

**Done when:** a real `.hex` loads into `flash` correctly.

---

## Phase 5 — GPIO + first (tight-loop) Blink  🎉  *(2 days)*

**Goal:** the milestone — a compiled blink toggles a virtual LED, using a
**busy-wait loop, not `delay()`**.

> ⚠️ **Why not the standard Blink yet?** Arduino's `delay()` waits on `millis()`,
> which only advances from the **Timer0 overflow interrupt**. With no timer (that
> arrives in Phase 6), `millis()` never moves, `delay()` spins forever, and you'd
> never see the second toggle. So Phase 5 uses a custom sketch that toggles PB5
> inside a plain counting loop. The *standard* `delay()`-based Blink starts
> working in Phase 6.

- `peripherals/gpio.ts`: model `PORTB/C/D`, `DDRB/C/D`, `PINB/C/D`. Hook
  `cpu.writeData` so writes to a PORT fire registered `onPortChange(port, value)`
  listeners. Implement `SBI`/`CBI` with the `+0x20` I/O-address translation.
- Wire GPIO through the public facade as it becomes available:
  `AVR({ hex }).pin(13).onChange(handler)` for preset digital-pin convenience, and
  `avr.gpio.port("B")` for raw AVR port access.
- `examples/blink/`: a custom sketch that toggles pin 13 (PB5) inside a tight
  for-loop delay (no `delay()`), compiled to `blink.hex`, + a runner that logs
  each PB5 toggle.

**Test:** load the tight-loop blink, run N cycles, assert PB5 toggles.

**Done when:** running the tight-loop blink prints "LED ON / LED OFF" toggles.

---

## Phase 6 — Timers + interrupts (correct timing)  *(3–5 days)*

**Goal:** `millis()`/`delay()` work, so timing-dependent sketches run right.

- Interrupt machinery in the CPU loop: after each step, if an enabled interrupt
  is pending and `SREG.I` is set -> push the return PC, clear I, jump to the
  vector. When several are pending, **the lowest vector address wins** (highest
  priority).
- Vector constants (program **word** addresses on the ATmega328P; each vector is
  2 words because it holds a `JMP`):
  - `RESET = 0x0000`, `INT0 = 0x0002`, `INT1 = 0x0004`
  - `TIMER0_OVF = 0x0020`  ← the one Arduino uses for `millis()`/`micros()`
  - `USART_RX = 0x0024`, `USART_UDRE = 0x0026`, `USART_TX = 0x0028`, `ADC = 0x002A`
  - (full list in the datasheet "Interrupt Vectors" table — add as you need them)
- Implement `SEI` (set I), `CLI` (clear I), and `RETI` (pop PC + re-enable I).
  ⚠️ Arduino's startup calls `sei()`; without `SEI` the `I` flag is never set, so
  Timer0 overflow never fires, so `millis()`/`delay()` never advance. This is the
  step that makes the **standard `delay()`-based Blink** finally work.
- `peripherals/timer.ts`: Timer0 first. Arduino's `init()` configures it via
  `TCCR0A`/`TCCR0B` (prescaler /64 → `CS01|CS00`) and enables the overflow
  interrupt in `TIMSK0` (`TOIE0`, bit 0). Your `tick(cycles)` advances `TCNT0`;
  on a 0xFF→0x00 wrap, set the `TOV0` flag (bit 0 of `TIFR0`) and request the
  `TIMER0_OVF` interrupt.
  - ⚠️ **Flag-clear semantics:** hardware clears an interrupt flag automatically
    when its vector is taken; *and* software clears these flags by **writing a 1**
    to the bit (write-1-to-clear), not a 0. Model both, or flags get stuck and
    interrupts misfire.
  - Then add Timer1 (16-bit) and Timer2.
- Wire timer-driven execution through `avr.runFor(ms)` for friendly simulated
  time, while keeping `avr.runCycles(cycles)` for deterministic tests/debugging.

**Test:** a sketch using `millis()`/`delay(1000)` blinks at the right *cycle*
count (16,000,000 cycles ≈ 1 s).

**Done when:** `delay()`-based timing matches expected cycle counts.

---

## Phase 7 — USART (Serial)  *(2 days)*

**Goal:** see `Serial.println()` output — huge for debugging everything else.

- `peripherals/usart.ts`: model `UCSR0A/B/C`, `UBRR0`, `UDR0`. On a write to
  `UDR0`, emit the byte to an `onByteTransmit` listener; manage the
  data-register-empty / transmit-complete flags so the Arduino core proceeds.
- Expose Serial through the facade as `avr.serial.onByte(cb)` and
  `avr.serial.onText(cb)`.

**Test:** a sketch printing "Hello" produces those bytes on the listener.

**Done when:** `Serial.print` output appears in your console.

---

## Phase 8 — Fill in the rest  *(ongoing)*

Driven by whatever sketches you want to run:

- Remaining instructions until the full ~131 are covered.
- **ADC** (`analogRead`) — `ADMUX`, `ADCSRA`, conversion timing, an input-voltage API.
- **PWM** via timer compare-match output (`analogWrite`).
- **SPI**, **I²C/TWI**, **EEPROM**, watchdog, sleep modes, pin-change interrupts.

**Done when:** your target set of sketches/libraries runs unmodified.

---

## Phase 9 — Polish & API  *(ongoing)*

- **Performance:** no per-instruction allocations; consider a function-table
  dispatch; batch cycles per frame for real-time use.
- **Public API** (`src/index.ts`): export `AVR` as the main factory/facade,
  plus advanced exports (`CPU`, `loadHex`, peripheral classes). `AVR(...)` wires
  CPU + clock + flash loading + peripherals so consumers can start with one call.
  The internal implementation may use a class, but the public DX is function-first:
  `AVR(hexText)`, `AVR({ hex, chip, clockHz })`, or
  `AVR().useChip("atmega328p").useClock(16_000_000).useHex(hexText)`.
- **Consumer DX docs:** add `docs/04-consumer-dx.md` with quick starts for
  `AVR(...)`, GPIO, Serial, browser loops, and low-level escape hatches.
- **UI-simulator helpers:** expose browser-friendly methods so a Wokwi/Tinkercad-
  style app does not need to reach into CPU internals:
  `start/pause/resume/stop`, `frame(deltaMs)`, `setSpeed(1|10|"max")`,
  `loadHex/load/loadFile/reload`, `pin().setInput/read/pulse`, `pins.onChange`,
  `serial.onText/write/clear/getText`, `snapshot/restore`, `status`, and a small
  `connect(component)` adapter contract.
- **Compiler integration (optional, last):** wrap Arduino CLI / avr-gcc, or call
  a hosted compile service, to go straight from `.ino` -> run. Pure tooling — the
  simulator never depends on it.
- Docs + a couple of browser/Node demos.

---

## Suggested order of attack (TL;DR)

```
Phase 0  scaffold
Phase 1  CPU shell  (flash, data, PC, cycles, SREG)
Phase 2  execute loop + ~10 instructions     <- first "it runs!"
Phase 3  branches, stack, memory             <- real programs run
Phase 4  Intel HEX loader
Phase 5  GPIO                                 <- ★ tight-loop Blink works
Phase 6  timers + interrupts + SEI/CLI        <- standard delay() Blink, timing
Phase 7  USART                                <- Serial debugging
Phase 8  ADC/PWM/SPI/I2C/EEPROM/...           <- breadth
Phase 9  perf + public API + (optional) compiler
```

---

## Definition of done for v1

A user can call `AVR({ hex: blinkHex })` (or `AVR(blinkHex)`), observe pin 13
toggling at 1 Hz with correct timing, and read `Serial` output — using the same
unmodified ATmega328P-class AVR binary that runs on compatible physical boards.
