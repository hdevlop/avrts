import { describe, expect, test } from "bun:test";
import {
  CPU,
  DATA_SIZE,
  Decoder,
  FLASH_WORDS,
  PORTB,
  RAMEND,
  SPH_ADDR,
  SPL_ADDR,
  SREG_ADDR,
} from "../src/cpu";

describe("CPU shell", () => {
  test("sizes flash and data per the ATmega328P memory map", () => {
    const cpu = new CPU();
    expect(cpu.flash.length).toBe(FLASH_WORDS); // 0x4000 words = 32 KB
    expect(cpu.data.length).toBe(DATA_SIZE); // 0x900 bytes
  });

  test("reset() restores power-on state", () => {
    const cpu = new CPU();
    cpu.pc = 0x123;
    cpu.cycles = 999;
    cpu.writeData(0x100, 0x42);
    cpu.reset();
    expect(cpu.pc).toBe(0);
    expect(cpu.cycles).toBe(0);
    expect(cpu.readData(0x100)).toBe(0);
    expect(cpu.SP).toBe(RAMEND);
  });

  test("readData/writeData round-trips and masks to 8 bits", () => {
    const cpu = new CPU();
    cpu.writeData(PORTB, 0xab);
    expect(cpu.readData(PORTB)).toBe(0xab);
    cpu.writeData(PORTB, 0x1ff);
    expect(cpu.readData(PORTB)).toBe(0xff);
  });

  test("SP spans SPL/SPH little-endian", () => {
    const cpu = new CPU();
    cpu.SP = 0x08ff;
    expect(cpu.data[SPL_ADDR]).toBe(0xff);
    expect(cpu.data[SPH_ADDR]).toBe(0x08);
    expect(cpu.SP).toBe(0x08ff);
  });

  test("I/O access translates by +0x20 (I/O 0x05 == PORTB == data 0x25)", () => {
    const cpu = new CPU();
    cpu.writeIo(0x05, 0x20);
    expect(cpu.readData(PORTB)).toBe(0x20);
    expect(cpu.readIo(0x05)).toBe(0x20);
  });

  test("onTrace registers and unsubscribes", () => {
    const cpu = new CPU();
    const seen: number[] = [];
    const off = cpu.onTrace((s) => seen.push(s.pc));
    cpu.emitTrace({ pc: 7, opcode: 0, mnemonic: "NOP", cycles: 1 });
    off();
    cpu.emitTrace({ pc: 9, opcode: 0, mnemonic: "NOP", cycles: 2 });
    expect(seen).toEqual([7]);
  });

  test("onCycles unsubscribe during dispatch does not skip snapshot listeners", () => {
    const cpu = new CPU();
    const seen: string[] = [];
    let offSecond = () => {};

    cpu.onCycles(() => {
      seen.push("first");
      offSecond();
    });
    offSecond = cpu.onCycles(() => seen.push("second"));
    cpu.onCycles(() => seen.push("third"));

    cpu.cycles += 1;
    expect(seen).toEqual(["first", "second", "third"]);

    seen.length = 0;
    cpu.cycles += 1;
    expect(seen).toEqual(["first", "third"]);
  });

  test("onCycles listeners added during dispatch wait for the next notification", () => {
    const cpu = new CPU();
    const seen: string[] = [];
    let added = false;

    cpu.onCycles(() => {
      seen.push("first");
      if (!added) {
        added = true;
        cpu.onCycles(() => seen.push("late"));
      }
    });
    cpu.onCycles(() => seen.push("second"));

    cpu.cycles += 1;
    expect(seen).toEqual(["first", "second"]);

    seen.length = 0;
    cpu.cycles += 1;
    expect(seen).toEqual(["first", "second", "late"]);
  });

  test("onCycles removals apply to nested notifications without changing the active one", () => {
    const cpu = new CPU();
    const seen: string[] = [];
    let offSecond = () => {};
    let didNested = false;
    let inNested = false;

    cpu.onCycles(() => {
      seen.push(inNested ? "first-nested" : "first");
      offSecond();
      if (!didNested) {
        didNested = true;
        inNested = true;
        cpu.cycles += 1;
        inNested = false;
      }
    });
    offSecond = cpu.onCycles(() => seen.push(inNested ? "second-nested" : "second"));
    cpu.onCycles(() => seen.push(inNested ? "third-nested" : "third"));

    cpu.cycles += 1;

    expect(seen).toEqual(["first", "first-nested", "third-nested", "second", "third"]);
  });

  test("addClockEvent reschedules the same callback", () => {
    const cpu = new CPU();
    const firedAt: number[] = [];
    const callback = () => firedAt.push(cpu.cycles);

    cpu.addClockEvent(callback, 5);
    cpu.addClockEvent(callback, 10);

    cpu.cycles += 5;
    expect(firedAt).toEqual([]);

    cpu.cycles += 5;
    expect(firedAt).toEqual([10]);

    cpu.cycles += 10;
    expect(firedAt).toEqual([10]);
  });

  test("clock events in cycle-exact mode fire on the exact cycle before cycle listeners", () => {
    const cpu = new CPU();
    cpu.timing = "cycle-exact";
    const seen: string[] = [];

    cpu.addClockEvent(() => seen.push(`event:${cpu.cycles}`), 2);
    cpu.onCycles(() => seen.push(`listener:${cpu.cycles}`));

    cpu.cycles += 3;

    expect(seen).toEqual(["listener:1", "event:2", "listener:2", "listener:3"]);
  });

  test("clock events in fast mode keep coalesced listener ordering", () => {
    const cpu = new CPU();
    const seen: string[] = [];

    cpu.addClockEvent(() => seen.push(`event:${cpu.cycles}`), 2);
    cpu.onCycles((elapsed) => seen.push(`listener:${cpu.cycles}:${elapsed}`));

    cpu.cycles += 3;

    expect(seen).toEqual(["listener:3:3", "event:3"]);
  });

  test("pending interrupts are deduped and serviced by vector priority", () => {
    const cpu = new CPU();
    cpu.setExecutor(new Decoder());
    let lowAck = 0;
    let highAck = 0;

    cpu.requestInterrupt(0x20, () => {
      highAck += 1;
    });
    cpu.requestInterrupt(0x10, () => {
      lowAck += 1;
    });
    cpu.requestInterrupt(0x10, () => {
      lowAck += 100;
    });

    cpu.sreg.I = true;
    cpu.tick();
    expect(cpu.pc).toBe(0x10);
    expect(lowAck).toBe(1);
    expect(highAck).toBe(0);

    cpu.sreg.I = true;
    cpu.tick();
    expect(cpu.pc).toBe(0x20);
    expect(lowAck).toBe(1);
    expect(highAck).toBe(1);
  });
});

describe("SREG flags", () => {
  const FLAGS = ["C", "Z", "N", "V", "S", "H", "T", "I"] as const;

  test("set/get each flag independently", () => {
    const cpu = new CPU();
    for (const flag of FLAGS) {
      cpu.sreg.set(flag, true);
      expect(cpu.sreg.get(flag)).toBe(true);
    }
    expect(cpu.data[SREG_ADDR]).toBe(0xff);

    for (const flag of FLAGS) cpu.sreg.set(flag, false);
    expect(cpu.data[SREG_ADDR]).toBe(0x00);
  });

  test("named accessors map to the correct bit positions", () => {
    const cpu = new CPU();
    cpu.sreg.C = true;
    expect(cpu.data[SREG_ADDR]).toBe(0b0000_0001);
    cpu.sreg.I = true;
    expect(cpu.data[SREG_ADDR]).toBe(0b1000_0001);
    cpu.sreg.C = false;
    expect(cpu.data[SREG_ADDR]).toBe(0b1000_0000);
  });

  test("sreg.value mirrors data[0x5F]", () => {
    const cpu = new CPU();
    cpu.sreg.value = 0x2a;
    expect(cpu.data[SREG_ADDR]).toBe(0x2a);
    cpu.data[SREG_ADDR] = 0x55;
    expect(cpu.sreg.value).toBe(0x55);
  });
});

describe("runFast opcode parity", () => {
  function runOneViaTick(opcode: number, setup?: (cpu: CPU) => void): CPU {
    const cpu = new CPU();
    cpu.setExecutor(new Decoder());
    cpu.flash[0] = opcode;
    setup?.(cpu);
    cpu.tick();
    return cpu;
  }

  function runOneViaFastRun(opcode: number, setup?: (cpu: CPU) => void): CPU {
    const cpu = new CPU();
    cpu.setExecutor(new Decoder());
    cpu.flash[0] = opcode;
    setup?.(cpu);
    cpu.run(1);
    return cpu;
  }

  function expectSameCoreState(actual: CPU, expected: CPU, touched: number[]): void {
    expect(actual.pc).toBe(expected.pc);
    expect(actual.cycles).toBe(expected.cycles);
    expect(actual.sreg.value).toBe(expected.sreg.value);
    for (const addr of touched) expect(actual.data[addr]).toBe(expected.data[addr]);
  }

  // LDI r16, K -> 0xE000 | ((K & 0xF0) << 4) | (K & 0x0F)
  const ldiR16 = (k: number) => 0xe000 | ((k & 0xf0) << 4) | (k & 0x0f);
  // MOV Rd,Rr -> 0x2C00 | ((r & 0x10) << 5) | ((d & 0x1F) << 4) | (r & 0x0F)
  const mov = (d: number, r: number) =>
    0x2c00 | ((r & 0x10) << 5) | ((d & 0x1f) << 4) | (r & 0x0f);
  // ADD/ADC Rd,Rr use the same register field layout as MOV.
  const add = (d: number, r: number) =>
    0x0c00 | ((r & 0x10) << 5) | ((d & 0x1f) << 4) | (r & 0x0f);
  const adc = (d: number, r: number) =>
    0x1c00 | ((r & 0x10) << 5) | ((d & 0x1f) << 4) | (r & 0x0f);
  const dec = (d: number) => 0x940a | ((d & 0x1f) << 4);
  const brne = (k: number) => 0xf401 | ((k & 0x7f) << 3);
  // SBIW Rd+1:Rd,K where Rd is one of r24,r26,r28,r30.
  const sbiw = (d: 24 | 26 | 28 | 30, k: number) =>
    0x9700 | ((((d - 24) / 2) & 0x03) << 4) | ((k & 0x30) << 2) | (k & 0x0f);

  function setWord(cpu: CPU, low: number, value: number): void {
    cpu.data[low] = value & 0xff;
    cpu.data[low + 1] = (value >> 8) & 0xff;
  }

  test("LDI fast path matches the handler path", () => {
    const opcode = ldiR16(0xa5);
    const ticked = runOneViaTick(opcode);
    const fast = runOneViaFastRun(opcode);
    expectSameCoreState(fast, ticked, [16]);
  });

  test("MOV fast path matches the handler path", () => {
    const opcode = mov(3, 18);
    const setup = (cpu: CPU) => {
      cpu.data[3] = 0x11;
      cpu.data[18] = 0xbe;
      cpu.data[SREG_ADDR] = 0xa5;
    };
    const ticked = runOneViaTick(opcode, setup);
    const fast = runOneViaFastRun(opcode, setup);
    expectSameCoreState(fast, ticked, [3, 18, SREG_ADDR]);
  });

  test("SBIW fast path matches the handler path", () => {
    expect(sbiw(28, 0)).toBe(0x9720);
    const cases: Array<{ d: 24 | 26 | 28 | 30; before: number; k: number }> = [
      { d: 28, before: 0x1234, k: 0 }, // profiler-hot opcode 0x9720
      { d: 24, before: 0x0001, k: 1 }, // zero result
      { d: 30, before: 0x0000, k: 1 }, // borrow/carry
      { d: 26, before: 0x8000, k: 1 }, // signed overflow edge
      { d: 28, before: 0x0100, k: 1 }, // high-byte boundary
      { d: 30, before: 0x003f, k: 0x3f }, // max 6-bit immediate
    ];

    for (const testCase of cases) {
      const opcode = sbiw(testCase.d, testCase.k);
      const setup = (cpu: CPU) => {
        setWord(cpu, testCase.d, testCase.before);
        cpu.data[SREG_ADDR] = 0xe0;
      };
      const ticked = runOneViaTick(opcode, setup);
      const fast = runOneViaFastRun(opcode, setup);
      expectSameCoreState(fast, ticked, [testCase.d, testCase.d + 1, SREG_ADDR]);
    }
  });

  function createZeroSbiwBreqLoop(pairLow: 24 | 26 | 28 | 30): CPU {
    const cpu = new CPU();
    cpu.setExecutor(new Decoder());
    cpu.flash[0] = sbiw(pairLow, 0);
    cpu.flash[1] = 0xf3f1; // BREQ -2
    setWord(cpu, pairLow, 0);
    cpu.data[SREG_ADDR] = 0xe0;
    return cpu;
  }

  function createRjmpSelfLoop(): CPU {
    const cpu = new CPU();
    cpu.setExecutor(new Decoder());
    cpu.flash[0] = 0xcfff; // RJMP -1
    cpu.data[SREG_ADDR] = 0xa5;
    return cpu;
  }

  function createShiftLeftDecLoop(count: number, counterReg = 20): CPU {
    const cpu = new CPU();
    cpu.setExecutor(new Decoder());
    cpu.flash.set([
      add(22, 22),
      adc(23, 23),
      adc(24, 24),
      adc(25, 25),
      dec(counterReg),
      brne(-6),
      0x0000,
    ]);
    cpu.data[22] = 0xe1;
    cpu.data[23] = 0x78;
    cpu.data[24] = 0x9a;
    cpu.data[25] = 0xc3;
    cpu.data[counterReg] = count & 0xff;
    cpu.data[SREG_ADDR] = 0xe0;
    return cpu;
  }

  test("RJMP self-loop bulk path matches the handler path", () => {
    const slow = createRjmpSelfLoop();
    const fast = createRjmpSelfLoop();
    slow.onTrace(() => {});

    slow.run(100);
    fast.run(100);

    expectSameCoreState(fast, slow, [SREG_ADDR]);
  });

  test("RJMP self-loop bulk path does not skip over clock events", () => {
    const slow = createRjmpSelfLoop();
    const fast = createRjmpSelfLoop();
    const slowEvents: number[] = [];
    const fastEvents: number[] = [];
    slow.onTrace(() => {});
    slow.addClockEvent(() => slowEvents.push(slow.cycles), 64);
    fast.addClockEvent(() => fastEvents.push(fast.cycles), 64);

    slow.run(100);
    fast.run(100);

    expect(fastEvents).toEqual(slowEvents);
    expect(fastEvents).toEqual([64]);
    expectSameCoreState(fast, slow, [SREG_ADDR]);
  });

  test("RJMP self-loop bulk path preserves per-instruction cycle listeners", () => {
    const cpu = createRjmpSelfLoop();
    const elapsed: number[] = [];
    cpu.onCycles((cycles) => elapsed.push(cycles));

    cpu.run(6);

    expect(elapsed).toEqual([2, 2, 2]);
  });

  test("zero-SBIW/BREQ idle loop bulk path matches the handler path", () => {
    const slow = createZeroSbiwBreqLoop(28);
    const fast = createZeroSbiwBreqLoop(28);
    slow.onTrace(() => {}); // disables runFast, keeping CPU.run() as the slow reference

    slow.run(100);
    fast.run(100);

    expectSameCoreState(fast, slow, [28, 29, SREG_ADDR]);
  });

  test("zero-SBIW/BREQ idle loop does not skip over clock events", () => {
    const slow = createZeroSbiwBreqLoop(28);
    const fast = createZeroSbiwBreqLoop(28);
    const slowEvents: number[] = [];
    const fastEvents: number[] = [];
    slow.onTrace(() => {});
    slow.addClockEvent(() => slowEvents.push(slow.cycles), 64);
    fast.addClockEvent(() => fastEvents.push(fast.cycles), 64);

    slow.run(100);
    fast.run(100);

    expect(fastEvents).toEqual(slowEvents);
    expect(fastEvents).toEqual([64]);
    expectSameCoreState(fast, slow, [28, 29, SREG_ADDR]);
  });

  test("zero-SBIW/BREQ idle loop preserves per-instruction cycle listeners", () => {
    const cpu = createZeroSbiwBreqLoop(28);
    const elapsed: number[] = [];
    cpu.onCycles((cycles) => elapsed.push(cycles));

    cpu.run(12);

    expect(elapsed).toEqual([2, 2, 2, 2, 2, 2]);
  });

  test("shift-left counted loop bulk path matches the handler path", () => {
    const slow = createShiftLeftDecLoop(3);
    const fast = createShiftLeftDecLoop(3);
    slow.onTrace(() => {});

    slow.run(20);
    fast.run(20);

    expectSameCoreState(fast, slow, [20, 22, 23, 24, 25, SREG_ADDR]);
  });

  test("shift-left counted loop refuses overlapping counter registers", () => {
    const slow = createShiftLeftDecLoop(3, 22);
    const fast = createShiftLeftDecLoop(3, 22);
    slow.onTrace(() => {});

    slow.run(20);
    fast.run(20);

    expectSameCoreState(fast, slow, [22, 23, 24, 25, SREG_ADDR]);
  });

  test("shift-left counted loop does not skip when run target lands inside the block", () => {
    const slow = createShiftLeftDecLoop(3);
    const fast = createShiftLeftDecLoop(3);
    slow.onTrace(() => {});

    slow.run(10);
    fast.run(10);

    expectSameCoreState(fast, slow, [20, 22, 23, 24, 25, SREG_ADDR]);
  });

  test("shift-left counted loop does not skip over clock events", () => {
    const slow = createShiftLeftDecLoop(3);
    const fast = createShiftLeftDecLoop(3);
    const slowEvents: number[] = [];
    const fastEvents: number[] = [];
    slow.onTrace(() => {});
    slow.addClockEvent(() => slowEvents.push(slow.cycles), 14);
    fast.addClockEvent(() => fastEvents.push(fast.cycles), 14);

    slow.run(20);
    fast.run(20);

    expect(fastEvents).toEqual(slowEvents);
    expect(fastEvents).toEqual([14]);
    expectSameCoreState(fast, slow, [20, 22, 23, 24, 25, SREG_ADDR]);
  });

  test("shift-left counted loop preserves per-instruction cycle listeners", () => {
    const cpu = createShiftLeftDecLoop(2);
    const elapsed: number[] = [];
    cpu.onCycles((cycles) => elapsed.push(cycles));

    cpu.run(13);

    expect(elapsed).toEqual([1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1]);
  });

  test("fast-block cache is invalidated after direct flash rewrites", () => {
    const cpu = createZeroSbiwBreqLoop(28);

    cpu.run(4); // classifies pc 0 as a zero-SBIW/BREQ block
    cpu.flash[1] = 0x0000; // the block shape no longer exists
    cpu.pc = 0;
    setWord(cpu, 28, 0);
    cpu.invalidateDecodeCache();
    cpu.run(4);

    expect(cpu.pc).toBe(3);
  });

});

describe("decode cache (Phase 4 predecode)", () => {
  // LDI r16, K → 0xE000 | ((K & 0xF0) << 4) | (K & 0x0F)
  const ldiR16 = (k: number) => 0xe000 | ((k & 0xf0) << 4) | (k & 0x0f);

  test("reuses the cached handler for a hot PC", () => {
    const cpu = new CPU();
    cpu.setExecutor(new Decoder());
    cpu.flash[0] = ldiR16(0xaa);
    cpu.flash[1] = 0xcfff; // rjmp -1 (back to pc 0)

    cpu.tick(); // executes LDI, caches the handler at pc 0
    expect(cpu.data[16]).toBe(0xaa);
  });

  test("stale cache cannot execute old code after invalidateDecodeCache()", () => {
    const cpu = new CPU();
    cpu.setExecutor(new Decoder());
    cpu.flash[0] = ldiR16(0xaa);
    cpu.tick();
    expect(cpu.data[16]).toBe(0xaa); // handler at pc 0 is now cached

    // Rewrite flash[0] in place (the low-level escape hatch) and rerun pc 0.
    cpu.flash[0] = ldiR16(0x55);
    cpu.pc = 0;
    cpu.invalidateDecodeCache();
    cpu.tick();
    expect(cpu.data[16]).toBe(0x55);
  });

  test("reset() invalidates the cache so a reloaded program runs", () => {
    const cpu = new CPU();
    cpu.setExecutor(new Decoder());
    cpu.flash[0] = ldiR16(0xaa);
    cpu.tick();
    expect(cpu.data[16]).toBe(0xaa);

    cpu.flash[0] = ldiR16(0x55); // simulate a reload mutating flash before reset
    cpu.reset();
    cpu.tick();
    expect(cpu.data[16]).toBe(0x55);
  });
});
