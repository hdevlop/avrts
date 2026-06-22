# How an AVR Simulator Works (ATmega328P)

> The conceptual model. Read this first. The build plan (`02-build-plan.md`)
> turns every box in these diagrams into code.

---

## 0. The one idea to internalize

You are **not** simulating "Arduino." You are simulating **one chip**: the
ATmega328P. Arduino is just C++ that a compiler turns into numbers, and those
numbers are fed to the chip. Your simulator reads the *same numbers* and pretends
to be the chip.

```
   What a human writes          What the chip actually runs
   ┌───────────────────┐        ┌──────────────────────────────┐
   │ digitalWrite(13,1) │  ───>  │ 1011 1000 ... (machine code) │
   │ (C++ / Wiring)     │        │ a list of 16-bit numbers     │
   └───────────────────┘        └──────────────────────────────┘
            ▲                                  ▲
       avr-gcc compiler                 YOUR SIMULATOR reads these
       (a SEPARATE tool)                and reproduces their effects
```

If your simulator reproduces the effect of every number correctly, then the
**exact binary that runs on real hardware runs in your simulator** and behaves
identically. That is the whole game.

---

## 1. Big-picture data flow: from sketch to blinking LED

```
 ┌──────────────┐  compile (avr-gcc)   ┌───────────────┐
 │  blink.ino   │ ───────────────────> │   blink.hex   │   Intel HEX text file:
 │  C++ source  │   (separate tool,    │  machine code │   ":100000000C9434000C..."
 └──────────────┘    NOT our library)  └───────┬───────┘
                                               │ parse HEX (Phase 4)
                                               ▼
                                     ┌────────────────────┐
                                     │  flash: Uint16Array │  program memory
                                     │  [0x0C94, 0x3400,…] │  (instructions)
                                     └─────────┬──────────┘
                                               │
        ┌──────────────────────────────────────────────────────────────┐
        │                    THE CPU LOOP (our core)                     │
        │                                                                │
        │     ┌────────┐   ┌────────┐   ┌─────────┐   ┌──────────┐       │
        │     │ FETCH  │──>│ DECODE │──>│ EXECUTE │──>│  ACCOUNT │──┐    │
        │     │opcode= │   │which   │   │do it,   │   │cycles +=  │  │    │
        │     │flash[PC]│  │instr?  │   │move PC  │   │ N         │  │    │
        │     └────────┘   └────────┘   └─────────┘   └──────────┘  │    │
        │          ▲                                                 │    │
        │          └─────────────────── repeat forever ─────────────┘    │
        └───────────┬───────────────────────────────────┬──────────────┘
                    │ reads/writes memory                │ advancing cycles
                    ▼                                     │ drives time
        ┌──────────────────────────┐                     ▼
        │  data: Uint8Array(0x900)  │          ┌─────────────────────┐
        │  regs + I/O + SRAM        │◀────────▶│   PERIPHERALS       │
        │  (one flat array)         │  share   │  GPIO, Timers,      │
        └────────────┬─────────────┘  memory   │  USART, ADC ...     │
                     │ write to PORTB           └──────────┬──────────┘
                     ▼ fires event                         │ overflow -> interrupt
              ┌─────────────┐                              │
              │  LED in UI  │◀─────────────────────────────┘
              │  turns on   │
              └─────────────┘
```

---

## 2. The chip's anatomy (what you will model in memory)

The ATmega328P is a **Harvard architecture** machine: program and data live in
**two completely separate address spaces**. This is the first thing to model.

```
   HARVARD ARCHITECTURE — two separate memories

   PROGRAM SPACE (flash)                 DATA SPACE (RAM-ish)
   read by the PC                        read/written by instructions
   ┌────────────────────┐               ┌────────────────────┐
   │ 16-bit words        │               │ 8-bit bytes         │
   │ 32 KB = 16K words   │               │ 0x000 .. 0x8FF      │
   │ Uint16Array(0x4000) │               │ Uint8Array(0x900)   │
   └────────────────────┘               └────────────────────┘
        ▲                                       ▲
        │ PC indexes here                       │ LD/ST/IN/OUT index here
   instructions live here                  registers+IO+variables live here
```

### 2a. The data space is ONE array (the elegant trick)

Registers, peripheral control registers, and your variables are **all the same
`Uint8Array`** — only the address range differs. Writing to a CPU register and
writing to a variable use the identical mechanism.

```
   data: Uint8Array(0x900)        byte address
   ┌────────────────────────┐
   │ R0  R1  ...  R31        │     0x0000 .. 0x001F   32 working registers
   ├────────────────────────┤
   │ I/O registers          │     0x0020 .. 0x005F   PORTB, TCCR0, SREG, SP...
   │  (PORTB=0x25, SREG=0x5F)│                        accessed by IN/OUT too
   ├────────────────────────┤
   │ Extended I/O           │     0x0060 .. 0x00FF   TIMSK0, UCSR0A, ...
   ├────────────────────────┤
   │                        │     0x0100             <- SRAM starts here
   │  SRAM (2 KB)           │       ...              your variables
   │  stack grows DOWN ↓    │     0x08FF             <- SP starts here, grows down
   └────────────────────────┘
```

Key landmarks you'll reference constantly (data-space addresses):

| Name  | Addr   | Meaning                                   |
|-------|--------|-------------------------------------------|
| R0–R31| 0x00–0x1F | 32 general registers                   |
| PINB  | 0x23   | read state of port B pins                 |
| DDRB  | 0x24   | data direction B (1 = output)             |
| PORTB | 0x25   | output values for port B (pin 13 = bit 5) |
| PIND/DDRD/PORTD | 0x29/0x2A/0x2B | port D                  |
| SP    | 0x5D (SPL) / 0x5E (SPH) | stack pointer            |
| SREG  | 0x5F   | status register (the flags)               |

> ⚠️ **I/O addresses vs. data addresses.** The table lists *data-space*
> addresses. But the `IN` / `OUT` / `SBI` / `CBI` instructions encode *I/O
> addresses* (0x00–0x3F), which map to data space by **adding 0x20**. So
> `OUT 0x05, r16` writes PORTB at `data[0x25]`, and `SBI 0x05, 5` sets pin 13.
> Your executor must apply this `+0x20` translation, or every GPIO/SREG access
> done through IN/OUT will hit the wrong byte.

### 2b. The CPU's own state (not in the array)

Besides the two memories, the CPU holds a little internal state:

```
   ┌─────────────────────────────────────────────┐
   │ PC      program counter  -> next instruction │  (a number, indexes flash)
   │ cycles  total clock ticks elapsed            │  (drives all timing)
   │ SP*     stack pointer    -> top of stack     │  (*lives in data[] at 0x5D)
   │ SREG*   I T H S V N Z C  -> the flags        │  (*lives in data[] at 0x5F)
   └─────────────────────────────────────────────┘
```

---

## 3. The status register (SREG) — the 8 flags

After arithmetic, the CPU sets flag bits that branches read. Getting these right
is ~half the work of a correct CPU.

```
   SREG  (data[0x5F])    bit:  7   6   5   4   3   2   1   0
                              ┌───┬───┬───┬───┬───┬───┬───┬───┐
                              │ I │ T │ H │ S │ V │ N │ Z │ C │
                              └───┴───┴───┴───┴───┴───┴───┴───┘
     C  Carry        – carry/borrow out of bit 7
     Z  Zero         – result was 0
     N  Negative     – bit 7 of result set
     V  Overflow     – signed overflow
     S  Sign         – N XOR V (true signed sign)
     H  Half-carry   – carry out of bit 3 (BCD math)
     T  Transfer     – scratch bit for BLD/BST
     I  Interrupt    – global interrupt enable (SEI/CLI)
```

> Mental note: **Carry** is for *unsigned* overflow, **V** is for *signed*
> overflow. They are different and both matter.

---

## 4. The fetch–decode–execute cycle (the flowchart)

This loop *is* the CPU. Everything else serves it.

```
            ┌─────────────────────────────┐
            │  opcode = flash[PC]          │   FETCH: read 16-bit word
            └──────────────┬──────────────┘
                           ▼
            ┌─────────────────────────────┐
            │  match opcode bit-pattern    │   DECODE: which instruction?
            │  (is it ADD? LDI? RJMP? ...) │   + extract operand fields
            └──────────────┬──────────────┘
                           ▼
            ┌─────────────────────────────┐
            │  perform the operation:      │   EXECUTE
            │   • change register / memory │
            │   • update SREG flags        │
            │   • advance PC (+1, or jump) │
            └──────────────┬──────────────┘
                           ▼
            ┌─────────────────────────────┐
            │  cycles += instruction cost  │   ACCOUNT (timing)
            │  let peripherals catch up    │
            └──────────────┬──────────────┘
                           ▼
            ┌─────────────────────────────┐
            │  interrupt pending & I set?  │── yes ─▶ push PC, jump to vector
            └──────────────┬──────────────┘
                           │ no
                           └────────────▶ back to FETCH
```

---

## 5. How an instruction is decoded (bit-pattern matching)

Each instruction is a 16-bit number whose bits encode both *what to do* and
*which registers*. Decoding = masking out the fixed bits and reading the operand
bits. Example: **`ADD Rd, Rr`** (add register Rr into Rd).

```
   Encoding of ADD:   0 0 0 0   1 1 r d   d d d d   r r r r
                      └──┬───┘   │ │ │       │         │
                      fixed      │ │ └─ d = 5-bit destination reg number
                      pattern    │ └─── (one d bit is up here)
                                 └───── r = 5-bit source reg number (split!)

   To decode opcode 0x0C01:
     opcode & 0xFC00 == 0x0C00  ?  -> yes, it's ADD
     d = (opcode & 0x01F0) >> 4    -> destination register index
     r = (opcode & 0x000F) | ((opcode & 0x0200) >> 5)  -> source (bits scattered)
```

So the "decoder" is a big dispatch that checks masks from most-specific to
least-specific and routes to the right handler. The ATmega328P has **~131
instructions**, but:

- ~30 instructions are enough to run **Blink**.
- Many share logic (all the ADD/SUB/AND/OR set flags the same way; all the
  branches test one SREG bit).

```
   Rough "instruction families" you'll implement:

   ┌──────────────┬───────────────────────────────────────────────┐
   │ Arithmetic   │ ADD ADC SUB SUBI SBC AND OR EOR INC DEC COM... │
   │ Load constant│ LDI                                            │
   │ Data move    │ MOV MOVW                                       │
   │ Memory       │ LD ST LDS STS LDD STD LPM PUSH POP             │
   │ I/O          │ IN OUT SBI CBI                                 │
   │ Compare      │ CP CPC CPI CPSE                                │
   │ Branch/jump  │ RJMP JMP RCALL CALL RET RETI BRNE BREQ BRGE... │
   │ Bit / misc   │ SBI CBI SBRC SBRS NOP SEI CLI SLEEP WDR        │
   └──────────────┴───────────────────────────────────────────────┘
```

---

## 6. How peripherals work — two directions

A peripheral is just **special memory addresses with side effects**. There is no
magic in the CPU; the *simulator* watches certain addresses.

### Direction A: CPU writes -> the outside world reacts (e.g. an LED)

```
   sketch: digitalWrite(13, HIGH)
        │  compiles to an instruction that writes bit 5 of PORTB (data[0x25])
        ▼
   EXECUTE writes data[0x25] = 0b00100000
        │
        ▼  simulator's writeData() notices addr == PORTB
   fire gpioListeners(portValue)
        │
        ▼
   UI lights the LED on pin 13
```

### Direction B: time advances -> peripheral reacts -> interrupt (e.g. millis)

```
   every step: cycles += N
        │
        ▼  simulator calls timer0.tick(cycles)
   Timer0 internal counter (TCNT0) counts up with the clock
        │
        ▼  when TCNT0 wraps 0xFF -> 0x00 it OVERFLOWS
   set the overflow flag bit in TIFR0
        │
        ▼  if that interrupt is enabled (TIMSK0) and SREG.I is set:
   queue interrupt  ──▶  CPU pushes PC, jumps to the TIMER0_OVF vector
        │
        ▼
   the Arduino core's ISR increments the millis() counter
```

This single mechanism (timer overflow -> interrupt) is what powers `millis()`,
`delay()`, `analogWrite()` PWM, and `tone()`.

---

## 7. How interrupts work (the detour mechanism)

An interrupt is a hardware-forced function call. Flash starts with a **vector
table**: a list of jumps, one per interrupt source.

```
   FLASH layout
   word 0x0000 ┌─────────────────┐
               │ JMP reset        │  <- power-on lands here
   word 0x0002 │ JMP INT0 handler │
   word 0x0004 │ JMP INT1 handler │
       ...     │   ...            │
               │ JMP TIMER0_OVF   │  <- timer0 overflow comes here
       ...     ├─────────────────┤
               │ your program...  │
               └─────────────────┘

   When an enabled interrupt fires (and SREG.I == 1):
     1. push current PC onto the stack
     2. clear SREG.I (no nested interrupts by default)
     3. PC = the source's vector address
     4. run the ISR ... ending in RETI
     5. RETI pops PC back and re-enables I  -> resume where we left off
```

---

## 8. Timing — why "cycles" is the heartbeat

The chip runs at a clock frequency (Uno/Nano: **16 MHz** = 16,000,000 cycles/sec).
Every instruction has a known cycle cost from the datasheet (NOP=1, most ALU=1,
LDS=2, CALL=4...). The simulator doesn't run in real time; it **counts cycles**:

```
   real time of an event  =  cycles  /  clockFrequencyHz

   e.g. after 16,000,000 cycles, 1 simulated second has passed.
```

Peripherals convert cycles into their own time (timer ticks, baud-rate bit
periods, ADC conversion time). To run "in real time" in a browser you advance a
batch of cycles per animation frame; to run "as fast as possible" you just loop.

---

## 9. How you'll know it's correct (validation strategy)

```
   ┌────────────────────────────────────────────────────────────┐
   │ Per-instruction unit tests:                                 │
   │   set up registers -> execute ONE opcode -> assert exact    │
   │   register, flag, PC, and cycle results from the datasheet. │
   ├────────────────────────────────────────────────────────────┤
   │ Integration test:                                           │
   │   load a REAL compiled blink.hex -> run -> assert PORTB bit  │
   │   5 toggles at the expected cycle counts.                   │
   └────────────────────────────────────────────────────────────┘
```

If a real compiled binary blinks correctly in your sim, your core is sound.

---

## 10. The two reference documents you'll live in

1. **AVR® Instruction Set Manual** (Microchip) — exact bit encoding, operation,
   affected flags, and cycle count of every instruction. Your decode bible.
2. **ATmega328P datasheet** (Microchip) — the memory map and every peripheral
   register (PORTB, TCCR0A, UCSR0A, ADMUX, ...). Your peripheral bible.

You never read them end to end — you look up one instruction / one register at a
time, exactly when you implement it.

---

### Glossary (quick reference)

| Term | Meaning |
|------|---------|
| **opcode** | the 16-bit number encoding one instruction |
| **PC** | program counter — index of the next instruction in flash |
| **SP** | stack pointer — top of the descending stack in SRAM |
| **SREG** | status register holding the 8 flag bits |
| **ISR** | interrupt service routine — the function an interrupt jumps to |
| **GPIO** | general-purpose I/O — the digital pins |
| **USART** | the serial port hardware (`Serial.print`) |
| **Intel HEX** | the text format avr-gcc emits to hold machine code |
| **cycle** | one tick of the 16 MHz clock; the unit of simulated time |
