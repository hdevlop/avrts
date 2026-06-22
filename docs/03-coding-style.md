# Coding Style & Conventions

> The house rules for this codebase. Every new file follows these. Read with
> `02-build-plan.md` — the build plan's file tree already reflects these rules.

## The three core rules

1. **Classes with decorators.** Behavior lives in classes; cross-cutting wiring
   (registering an instruction handler, an I/O hook, an interrupt source) is done
   with decorators, not manual `switch`/registration lists.
2. **One `types.ts` + one barrel (`index.ts`) per folder.** Each module folder
   keeps its **shared/public** types/interfaces/enums in a single `types.ts`, and
   exposes its public surface through a single `index.ts` barrel. A private,
   one-off type used by only one file may stay beside that file — don't force
   unrelated types together or create import cycles just to obey the rule. Nothing
   outside a folder imports its inner files directly — only the barrel.
3. **Small methods.** A method does one thing and reads top-to-bottom like a
   sentence. Long procedures are split into named private helpers. If a method
   needs a comment to explain a block, that block becomes a method.

---

## 1. Folder shape (every module folder looks the same)

```
src/<module>/
├─ <feature>.ts     # the class(es) — one primary class per file
├─ types.ts         # ALL types/interfaces/enums for this module, in one file
└─ index.ts         # barrel: the ONLY thing other modules import from
```

### `types.ts` — home for the module's shared/public types

Types used across the folder or exported to other modules live here. A type used
by a single file only may stay in that file (avoids giant type files and cycles).

```ts
// src/cpu/types.ts
export interface TraceState {
  pc: number;
  opcode: number;
  mnemonic: string;
  cycles: number;
}

export type FlagName = "C" | "Z" | "N" | "V" | "S" | "H" | "T" | "I";

export type InstructionHandler = (cpu: CPU, opcode: number) => void;

export const enum Vector {
  Reset = 0x0000,
  Timer0Ovf = 0x0020,
}
```

### `index.ts` — the barrel (the only public door)

```ts
// src/cpu/index.ts
export * from "./cpu";
export * from "./instructions";
export * from "./sreg";
export type * from "./types"; // type-only re-export (see verbatimModuleSyntax note)
```

> ⚠️ **`verbatimModuleSyntax` is on** in `tsconfig.json`. Re-export pure types
> with `export type` / `export type *`, and import them with
> `import type { … }`. Mixing value and type imports of the same symbol will error.

**Import rule:** always import from the barrel, never from inner files.

```ts
import { CPU, type TraceState } from "../cpu";        // ✅ via barrel
import { CPU } from "../cpu/cpu";                      // ❌ reaches inside
```

The top-level `src/index.ts` is the package's public barrel — it re-exports each
module's barrel and nothing private.

---

## 2. Classes with decorators

Decorators turn the two big dispatch problems (which opcode runs which code; which
I/O address triggers which peripheral) into **declarations next to the code**,
instead of a giant hand-maintained `switch`.

### Setup (one-time)

Enable decorators in `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true
    // "emitDecoratorMetadata": true   // only if you later add reflect-metadata DI
  }
}
```

(Bun runs these natively. If you prefer TS 5 *standard* decorators instead, the
patterns below adapt — just keep one style across the repo.)

> ⚠️ The current `tsconfig.json` does **not** have this flag yet. Adding it is a
> **Phase 0 task** (see `02-build-plan.md`) — do it before writing any decorated
> class so the first build doesn't hit a compiler surprise.

### The shared decorator + registry (`src/core/`)

```ts
// src/core/types.ts
export interface OpEntry {
  mnemonic: string;
  mask: number;     // bits that are fixed in the encoding
  pattern: number;  // the value of those fixed bits
  words: 1 | 2;     // 1- or 2-word (32-bit) instruction
  key: string;      // the method name on the InstructionSet class
}
```

```ts
// src/core/decorators.ts
import type { OpEntry } from "./types";

export const opRegistry: OpEntry[] = [];

/** Register a method as the handler for one AVR instruction. */
export function Op(mnemonic: string, mask: number, pattern: number, words: 1 | 2 = 1) {
  return (_target: object, key: string): void => {
    opRegistry.push({ mnemonic, mask, pattern, words, key });
  };
}
```

### Declaring instructions with `@Op` (no central switch)

```ts
// src/cpu/instructions.ts
import { Op } from "../core";
import type { CPU } from "./cpu";

export class InstructionSet {
  @Op("ADD", 0xfc00, 0x0c00)
  add(cpu: CPU, opcode: number): void {
    const d = destReg(opcode);
    const r = srcReg(opcode);
    const sum = cpu.data[d]! + cpu.data[r]!;
    this.applyAddFlags(cpu, cpu.data[d]!, cpu.data[r]!, sum);
    cpu.data[d] = sum & 0xff;
    cpu.advance(1, 1); // pc += 1, cycles += 1
  }

  @Op("RJMP", 0xf000, 0xc000)
  rjmp(cpu: CPU, opcode: number): void {
    cpu.pc += signed12(opcode) + 1;
    cpu.cycles += 2;
  }

  // ... one small method per instruction ...

  private applyAddFlags(cpu: CPU, a: number, b: number, sum: number): void {
    // set C/Z/N/V/S/H — kept out of add() so add() reads as one thought
  }
}
```

The dispatcher consumes a **decode table built once** from the registry — never a
per-instruction scan:

```ts
// src/cpu/instructions.ts (continued)
export class Decoder {
  // 64K-entry table: opcode -> typed handler. Built ONCE, then frozen.
  private readonly table: ReadonlyArray<InstructionHandler | undefined>;

  constructor(set: InstructionSet = new InstructionSet()) {
    this.table = buildDecodeTable(set); // see "Registry rules" below
  }

  execute(cpu: CPU, opcode: number): void {
    const handler = this.table[opcode];
    if (!handler) throw new UnknownOpcodeError(cpu.pc, opcode);
    handler(cpu, opcode); // O(1) lookup, fully-typed call, no `any`
  }
}
```

### Registry rules (make the decorator pattern robust, not just pretty)

Decorators are convenient but add two hazards — registration order and module
side effects. These rules are mandatory:

1. **Deterministic init via `buildDecoder()`.** Registration is a side effect of
   *importing* a decorated class, so never decode against `opRegistry` directly.
   Provide one `buildDecoder()` that explicitly imports/instantiates every
   instruction-set class, builds the table, and returns the `Decoder`. Decoding
   before the table is built is a bug.
2. **Idempotent / duplicate-safe registration.** Re-importing a module (tests,
   HMR) must not double-register. Guard `@Op` against duplicate `(mask, pattern)`
   keys, or dedupe in `buildDecodeTable`. Building twice yields an identical table.
3. **Priority-sorted, conflict-checked, frozen — built once.** AVR opcode masks
   overlap, so:
   - Sort entries by **mask specificity** (popcount of `mask`); fill the table
     least-specific first so a more-specific instruction overwrites a generic
     pattern it overlaps.
   - If two entries of **equal** specificity claim the same opcode → real
     ambiguity → **throw at build time** (never silently pick one).
   - `Object.freeze` the table; runtime dispatch is just `table[opcode]`.
4. **No `any` on the hot path.** Resolve each method to a typed, bound
   `InstructionHandler` **once**, inside `buildDecodeTable`, behind a runtime
   `typeof === "function"` check. `execute()` then calls a fully-typed handler.

```ts
function buildDecodeTable(set: InstructionSet): ReadonlyArray<InstructionHandler | undefined> {
  const table = new Array<InstructionHandler | undefined>(0x10000);
  const owner = new Array<OpEntry | undefined>(0x10000);
  const entries = [...opRegistry].sort((a, b) => popcount(a.mask) - popcount(b.mask));

  for (const entry of entries) {
    const method = (set as Record<string, unknown>)[entry.key]; // one localized cast...
    if (typeof method !== "function") {
      throw new Error(`@Op handler "${entry.key}" is not a method`);
    }
    const handler = (method as InstructionHandler).bind(set);    // ...validated & bound ONCE
    eachMatchingOpcode(entry.mask, entry.pattern, (op) => {
      const prev = owner[op];
      if (prev && popcount(prev.mask) === popcount(entry.mask)) {
        throw new Error(`Opcode ${hex(op)} ambiguous: ${prev.mnemonic} vs ${entry.mnemonic}`);
      }
      table[op] = handler;
      owner[op] = entry;
    });
  }
  return Object.freeze(table);
}
```

### Same idea for peripheral I/O hooks

```ts
// src/peripherals/gpio.ts
import { OnWrite } from "../core";
import { PORTB, type CPU } from "../cpu";

export class Gpio {
  // Convention: EVERY I/O hook has the signature (cpu, addr, value, oldValue).
  @OnWrite(PORTB)
  onPortBWrite(cpu: CPU, addr: number, value: number, oldValue: number): void {
    this.firePinChange("B", value, oldValue);
  }
}
```

> ⚠️ **Fix the I/O-hook signature now: `onWrite(cpu, addr, value, oldValue)`.**
> A `value`-only hook can't express what real peripherals need: timers/flags use
> `oldValue` for **write-1-to-clear** semantics, USART needs `cpu`, and one hook
> may cover several addresses (so it needs `addr`). Build the registry around this
> 4-arg shape from the start rather than retrofitting it later.

> Free-function helpers (`destReg`, `signed12`, …) live module-private at the
> bottom of the file or in a small `bits.ts` — they don't need `this`, so they
> aren't methods.

---

## 3. Small, readable methods

**Rule of thumb:** a method fits on one screen, has one job, and its name says
what it does. Decoding-and-executing in one giant function is the thing we are
explicitly avoiding.

### ❌ Before — one long method doing five jobs

```ts
step(cpu: CPU): void {
  const opcode = cpu.flash[cpu.pc]!;
  if ((opcode & 0xfc00) === 0x0c00) {
    const d = (opcode & 0x01f0) >> 4;
    const r = (opcode & 0x000f) | ((opcode & 0x0200) >> 5);
    const sum = cpu.data[d]! + cpu.data[r]!;
    // ...inline flag math, 8 lines...
    cpu.data[d] = sum & 0xff;
    cpu.pc++; cpu.cycles++;
  } else if (/* next opcode ... */) { /* ... */ }
  // ...and so on for 130 more instructions...
}
```

### ✅ After — each concern is its own named unit

```ts
step(cpu: CPU): void {
  const opcode = this.fetch(cpu);
  this.decoder.execute(cpu, opcode);
  this.serviceInterrupts(cpu);
}

private fetch(cpu: CPU): number {
  return cpu.flash[cpu.pc]!;
}
```

Guidelines:
- **Extract operand decoding** (`destReg`, `srcReg`, `immediate`, `signed12`) —
  these repeat across instructions; name them once.
- **Extract flag updates** into helpers like `applyAddFlags`, `applyLogicFlags`,
  `applySubFlags` — many instructions share the exact same flag logic.
- **Extract stack ops** (`pushByte`, `popByte`, `pushWord`, `popWord`) and use
  them from every CALL/RET/PUSH/POP.
- **One primary class per file**; private helpers below it; no method longer than
  it needs a scrollbar.

---

## 4. Naming & misc conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Class | `PascalCase` | `InstructionSet`, `Timer0`, `IntelHexLoader` |
| Method / variable | `camelCase` | `pushWord`, `serviceInterrupts` |
| Hardware constants | `SCREAMING_SNAKE` or chip names | `PORTB`, `SRAM_START`, `RAMEND` |
| Type / interface / enum | `PascalCase`, in `types.ts` | `OpEntry`, `TraceState`, `Vector` |
| Decorator factory | `PascalCase` verb/noun | `@Op(...)`, `@OnWrite(...)` |
| File | `kebab-case.ts` | `intel-hex.ts`, `instruction-set.ts` |

- Prefer `readonly` for fields that never reassign (`flash`, `data`).
- Use `const enum`/`as const` for the memory-map constants (no runtime cost).
- Errors are typed classes (`UnknownOpcodeError`) carrying `pc`/`opcode`, per the
  Phase 2 debugging-hooks rule.
- Keep `index.ts` barrels free of logic — re-exports only.

---

## Checklist for any new file

- [ ] Lives in a module folder with a `types.ts` + `index.ts`.
- [ ] Imports other modules only through their barrel.
- [ ] Types/interfaces/enums declared in the folder's `types.ts`, not inline.
- [ ] Behavior is a class; dispatch/wiring uses a decorator, not a manual switch.
- [ ] Methods are small and single-purpose; shared logic extracted into helpers.
- [ ] Type-only exports/imports use `export type` / `import type`.
