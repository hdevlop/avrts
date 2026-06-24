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

describe("fast-path opcode parity", () => {
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
  // CALL k is a two-word instruction; low 16 address bits live in the next word.
  const call = (addr: number) =>
    [0x940e | ((addr >>> 16) & 0x01) | (((addr >>> 17) & 0x1f) << 4), addr & 0xffff] as const;

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

  // Subtract/compare group share MOV's register layout for the reg-reg forms.
  const sub = (d: number, r: number) =>
    0x1800 | ((r & 0x10) << 5) | ((d & 0x1f) << 4) | (r & 0x0f);
  const sbc = (d: number, r: number) =>
    0x0800 | ((r & 0x10) << 5) | ((d & 0x1f) << 4) | (r & 0x0f);
  const cp = (d: number, r: number) =>
    0x1400 | ((r & 0x10) << 5) | ((d & 0x1f) << 4) | (r & 0x0f);
  const cpc = (d: number, r: number) =>
    0x0400 | ((r & 0x10) << 5) | ((d & 0x1f) << 4) | (r & 0x0f);
  // Immediate forms target r16..r31; immediate nibbles split like LDI.
  const subi = (d: number, k: number) =>
    0x5000 | (((d - 16) & 0x0f) << 4) | ((k & 0xf0) << 4) | (k & 0x0f);
  const sbci = (d: number, k: number) =>
    0x4000 | (((d - 16) & 0x0f) << 4) | ((k & 0xf0) << 4) | (k & 0x0f);
  const cpi = (d: number, k: number) =>
    0x3000 | (((d - 16) & 0x0f) << 4) | ((k & 0xf0) << 4) | (k & 0x0f);

  // Operand pairs that exercise the flag edges: no-borrow, borrow, half-carry,
  // signed overflow, zero, and negative results.
  const subEdgeCases: Array<{ dv: number; rv: number }> = [
    { dv: 0x50, rv: 0x10 }, // plain, no borrow
    { dv: 0x10, rv: 0x20 }, // borrow / carry
    { dv: 0x10, rv: 0x01 }, // half-carry (low nibble borrow)
    { dv: 0x80, rv: 0x01 }, // signed overflow
    { dv: 0x42, rv: 0x42 }, // zero result
    { dv: 0x00, rv: 0x01 }, // negative result + borrow
    { dv: 0xff, rv: 0xff }, // full-width zero
  ];
  // SREG seeds toggling C (carry-in) and Z (multi-byte preservation).
  const sregSeeds = [0x00, 1 << 0 /* C */, 1 << 1 /* Z */, (1 << 0) | (1 << 1), 0xff];

  // Building a Decoder is expensive, so reuse two CPUs (handler + fast) across the
  // whole flag-edge cross product, resetting state per case instead of
  // reconstructing. reset() clears the decode and fast-block caches.
  function makeSubtractParity() {
    const tickCpu = new CPU();
    tickCpu.setExecutor(new Decoder());
    const fastCpu = new CPU();
    fastCpu.setExecutor(new Decoder());
    const capture = (cpu: CPU, touched: number[]) => ({
      pc: cpu.pc,
      cycles: cpu.cycles,
      sreg: cpu.sreg.value,
      data: touched.map((addr) => cpu.data[addr]),
    });
    return (opcode: number, setup: (cpu: CPU) => void, touched: number[]) => {
      tickCpu.reset();
      tickCpu.flash[0] = opcode;
      setup(tickCpu);
      tickCpu.tick();
      fastCpu.reset();
      fastCpu.flash[0] = opcode;
      setup(fastCpu);
      fastCpu.run(1);
      const fast = capture(fastCpu, touched);
      expect(fast).toEqual(capture(tickCpu, touched));
      return fast;
    };
  }

  test("SUB/CP fast path matches the handler path across flag edges", () => {
    const parity = makeSubtractParity();
    for (const { dv, rv } of subEdgeCases) {
      for (const seed of sregSeeds) {
        parity(
          sub(5, 6),
          (cpu) => {
            cpu.data[5] = dv;
            cpu.data[6] = rv;
            cpu.data[SREG_ADDR] = seed;
          },
          [5, 6, SREG_ADDR],
        );
        // CP must not write its destination.
        const cpResult = parity(
          cp(7, 8),
          (cpu) => {
            cpu.data[7] = dv;
            cpu.data[8] = rv;
            cpu.data[SREG_ADDR] = seed;
          },
          [7, 8, SREG_ADDR],
        );
        expect(cpResult.data[0]).toBe(dv);
      }
    }
  });

  test("SBC/CPC fast path matches the handler path (carry-in + multi-byte Z)", () => {
    const parity = makeSubtractParity();
    for (const { dv, rv } of subEdgeCases) {
      for (const seed of sregSeeds) {
        parity(
          sbc(5, 6),
          (cpu) => {
            cpu.data[5] = dv;
            cpu.data[6] = rv;
            cpu.data[SREG_ADDR] = seed;
          },
          [5, 6, SREG_ADDR],
        );
        const cpcResult = parity(
          cpc(7, 8),
          (cpu) => {
            cpu.data[7] = dv;
            cpu.data[8] = rv;
            cpu.data[SREG_ADDR] = seed;
          },
          [7, 8, SREG_ADDR],
        );
        expect(cpcResult.data[0]).toBe(dv);
      }
    }
  });

  test("SUBI/SBCI/CPI fast path matches the handler path", () => {
    const parity = makeSubtractParity();
    const immCases: Array<{ dv: number; k: number }> = [
      { dv: 0x50, k: 0x10 },
      { dv: 0x10, k: 0x20 },
      { dv: 0x10, k: 0x01 },
      { dv: 0x80, k: 0x01 },
      { dv: 0x42, k: 0x42 },
      { dv: 0x00, k: 0xff },
    ];
    for (const { dv, k } of immCases) {
      for (const seed of sregSeeds) {
        parity(
          subi(20, k),
          (cpu) => {
            cpu.data[20] = dv;
            cpu.data[SREG_ADDR] = seed;
          },
          [20, SREG_ADDR],
        );
        parity(
          sbci(21, k),
          (cpu) => {
            cpu.data[21] = dv;
            cpu.data[SREG_ADDR] = seed;
          },
          [21, SREG_ADDR],
        );
        const cpiResult = parity(
          cpi(22, k),
          (cpu) => {
            cpu.data[22] = dv;
            cpu.data[SREG_ADDR] = seed;
          },
          [22, SREG_ADDR],
        );
        expect(cpiResult.data[0]).toBe(dv);
      }
    }
  });

  test("ADD/ADC fast path matches the handler path across flag edges", () => {
    const parity = makeSubtractParity();
    const addCases: Array<{ dv: number; rv: number }> = [
      { dv: 0x10, rv: 0x20 }, // plain
      { dv: 0xf0, rv: 0x20 }, // carry out
      { dv: 0x08, rv: 0x08 }, // half-carry
      { dv: 0x40, rv: 0x40 }, // signed overflow
      { dv: 0x00, rv: 0x00 }, // zero
      { dv: 0x80, rv: 0x80 }, // overflow + carry, zero result
      { dv: 0xff, rv: 0x01 }, // wrap to zero with carry
    ];
    for (const { dv, rv } of addCases) {
      for (const seed of sregSeeds) {
        const setup = (cpu: CPU) => {
          cpu.data[5] = dv;
          cpu.data[6] = rv;
          cpu.data[SREG_ADDR] = seed;
        };
        parity(add(5, 6), setup, [5, 6, SREG_ADDR]);
        parity(adc(5, 6), setup, [5, 6, SREG_ADDR]);
      }
    }
  });

  test("ADIW fast path matches the handler path", () => {
    const parity = makeSubtractParity();
    const adiw = (d: 24 | 26 | 28 | 30, k: number) =>
      0x9600 | ((((d - 24) / 2) & 0x03) << 4) | ((k & 0x30) << 2) | (k & 0x0f);
    const cases: Array<{ d: 24 | 26 | 28 | 30; before: number; k: number }> = [
      { d: 24, before: 0x0000, k: 0 },
      { d: 26, before: 0x00ff, k: 1 }, // low->high carry
      { d: 28, before: 0x7fff, k: 1 }, // signed overflow
      { d: 30, before: 0xffff, k: 1 }, // wrap to zero + carry
      { d: 24, before: 0x1234, k: 0x3f }, // max immediate
    ];
    for (const { d, before, k } of cases) {
      for (const seed of sregSeeds) {
        parity(
          adiw(d, k),
          (cpu) => {
            setWord(cpu, d, before);
            cpu.data[SREG_ADDR] = seed;
          },
          [d, d + 1, SREG_ADDR],
        );
      }
    }
  });

  test("MOVW fast path matches the handler path", () => {
    const parity = makeSubtractParity();
    const movw = (d: number, r: number) => 0x0100 | (((d >> 1) & 0x0f) << 4) | ((r >> 1) & 0x0f);
    const cases: Array<{ d: number; r: number }> = [
      { d: 24, r: 2 },
      { d: 4, r: 30 },
      { d: 0, r: 16 },
    ];
    for (const { d, r } of cases) {
      parity(
        movw(d, r),
        (cpu) => {
          cpu.data[r] = 0xbe;
          cpu.data[r + 1] = 0xef;
          cpu.data[d] = 0x00;
          cpu.data[d + 1] = 0x00;
          cpu.data[SREG_ADDR] = 0xa5;
        },
        [d, d + 1, r, r + 1, SREG_ADDR],
      );
    }
  });

  test("PUSH fast path matches the handler path (SP + stack byte)", () => {
    const parity = makeSubtractParity();
    const push = (r: number) => 0x920f | ((r & 0x1f) << 4);
    for (const r of [0, 17, 31]) {
      parity(
        push(r),
        (cpu) => {
          cpu.data[r] = 0x3c;
          cpu.data[SREG_ADDR] = 0xa5;
        },
        [r, RAMEND, SPL_ADDR, SPH_ADDR, SREG_ADDR],
      );
    }
  });

  test("POP fast path matches the handler path (SP + dest reg)", () => {
    const parity = makeSubtractParity();
    const pop = (r: number) => 0x900f | ((r & 0x1f) << 4);
    for (const r of [0, 17, 31]) {
      parity(
        pop(r),
        (cpu) => {
          cpu.SP = RAMEND - 1;
          cpu.data[RAMEND] = 0x5a;
          cpu.data[SREG_ADDR] = 0xa5;
        },
        [r, RAMEND, SPL_ADDR, SPH_ADDR, SREG_ADDR],
      );
    }
  });

  test("LD indirect fast path matches the handler path (X/Y/Z, all modes)", () => {
    const parity = makeSubtractParity();
    const d = 5;
    const variants: Array<{ op: number; ptr: number }> = [
      { op: 0x900c, ptr: 26 }, // LD X
      { op: 0x900d, ptr: 26 }, // LD X+
      { op: 0x900e, ptr: 26 }, // LD -X
      { op: 0x9009, ptr: 28 }, // LD Y+
      { op: 0x900a, ptr: 28 }, // LD -Y
      { op: 0x9001, ptr: 30 }, // LD Z+
      { op: 0x9002, ptr: 30 }, // LD -Z
    ];
    for (const { op, ptr } of variants) {
      parity(
        op | (d << 4),
        (cpu) => {
          cpu.data[ptr] = 0x00;
          cpu.data[ptr + 1] = 0x02; // pointer = 0x0200
          cpu.data[0x200] = 0x77; // post-inc / no-change read target
          cpu.data[0x1ff] = 0x66; // pre-dec read target
          cpu.data[SREG_ADDR] = 0xa5;
        },
        [d, ptr, ptr + 1, 0x1ff, 0x200, SREG_ADDR],
      );
    }
  });

  test("ST indirect fast path matches the handler path (X/Y/Z, all modes)", () => {
    const parity = makeSubtractParity();
    const variants: Array<{ op: number; ptr: number; r: number }> = [
      { op: 0x920c, ptr: 26, r: 5 }, // ST X
      { op: 0x920d, ptr: 26, r: 5 }, // ST X+
      { op: 0x920e, ptr: 26, r: 5 }, // ST -X
      { op: 0x9209, ptr: 28, r: 5 }, // ST Y+
      { op: 0x920a, ptr: 28, r: 5 }, // ST -Y
      { op: 0x9201, ptr: 30, r: 5 }, // ST Z+
      { op: 0x9202, ptr: 30, r: 5 }, // ST -Z
      { op: 0x920d, ptr: 26, r: 26 }, // ST X+ storing the pointer reg itself (edge)
    ];
    for (const { op, ptr, r } of variants) {
      parity(
        op | (r << 4),
        (cpu) => {
          cpu.data[ptr] = 0x00;
          cpu.data[ptr + 1] = 0x02; // pointer = 0x0200
          if (r !== ptr && r !== ptr + 1) cpu.data[r] = 0x3c;
          cpu.data[SREG_ADDR] = 0xa5;
        },
        [r, ptr, ptr + 1, 0x1ff, 0x200, SREG_ADDR],
      );
    }
  });

  test("ST to an IO register fires the same write hook on both paths", () => {
    const make = () => {
      const cpu = new CPU();
      cpu.setExecutor(new Decoder());
      return cpu;
    };
    const setup = (cpu: CPU) => {
      cpu.data[26] = PORTB & 0xff; // X -> PORTB
      cpu.data[27] = (PORTB >> 8) & 0xff;
      cpu.data[5] = 0xff;
    };
    const opcode = 0x920c | (5 << 4); // ST X, r5
    const tickCpu = make();
    tickCpu.flash[0] = opcode;
    setup(tickCpu);
    tickCpu.tick();
    const fastCpu = make();
    fastCpu.flash[0] = opcode;
    setup(fastCpu);
    fastCpu.run(1);
    // Whole-data comparison: any hook-driven side effect must match byte-for-byte.
    expect(Array.from(fastCpu.data)).toEqual(Array.from(tickCpu.data));
  });

  test("LPM fast path matches the handler path", () => {
    const parity = makeSubtractParity();
    const seed = (z: number) => (cpu: CPU) => {
      cpu.flash[0x100] = 0xbeef; // byte 0x200 -> 0xef, byte 0x201 -> 0xbe
      cpu.data[30] = z & 0xff;
      cpu.data[31] = (z >> 8) & 0xff;
      cpu.data[SREG_ADDR] = 0xa5;
    };
    parity(0x95c8, seed(0x200), [0, 30, 31, SREG_ADDR]); // LPM R0
    parity(0x9004 | (5 << 4), seed(0x200), [5, 30, 31, SREG_ADDR]); // LPM r5, Z
    parity(0x9005 | (5 << 4), seed(0x200), [5, 30, 31, SREG_ADDR]); // LPM r5, Z+ (even)
    parity(0x9005 | (5 << 4), seed(0x201), [5, 30, 31, SREG_ADDR]); // LPM r5, Z+ (odd byte)
  });

  test("CALL generated fast path matches the handler path", () => {
    const [opcode, nextWord] = call(0x0123);
    const setup = (cpu: CPU) => {
      cpu.flash[1] = nextWord;
      cpu.data[SREG_ADDR] = 0xa5;
    };

    const ticked = runOneViaTick(opcode, setup);
    const fast = runOneViaFastRun(opcode, setup);

    expectSameCoreState(fast, ticked, [SPL_ADDR, SPH_ADDR, RAMEND, RAMEND - 1, SREG_ADDR]);
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

  function createArduinoMicrosBody(): CPU {
    const cpu = new CPU();
    cpu.setExecutor(new Decoder());
    cpu.flash.set([
      0xb73f, 0x94f8, 0x9180, 0x0105, 0x9190, 0x0106, 0x91a0, 0x0107, 0x91b0,
      0x0108, 0xb526, 0x9ba8, 0xc005, 0x3f2f, 0xf019, 0x9601, 0x1da1, 0x1db1,
      0xbf3f, 0x2fba, 0x2fa9, 0x2f98, 0x2788, 0x01bc, 0x01cd, 0x0f62, 0x1d71,
      0x1d81, 0x1d91, 0xe042, 0x0f66, 0x1f77, 0x1f88, 0x1f99, 0x954a, 0xf7d1,
      0x9508,
    ]);
    cpu.pushWord(0x1234);
    return cpu;
  }

  function seedArduinoMicrosBody(
    cpu: CPU,
    options: { overflowCount: number; tcnt0: number; tifr0: number },
  ): void {
    cpu.data[1] = 0;
    cpu.data[SREG_ADDR] = 0xc0;
    cpu.data[0x0105] = options.overflowCount & 0xff;
    cpu.data[0x0106] = (options.overflowCount >>> 8) & 0xff;
    cpu.data[0x0107] = (options.overflowCount >>> 16) & 0xff;
    cpu.data[0x0108] = (options.overflowCount >>> 24) & 0xff;
    cpu.data[0x46] = options.tcnt0 & 0xff;
    cpu.data[0x35] = options.tifr0 & 0xff;
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
    slow.onTrace(() => {}); // disables the fast path, keeping CPU.run() as the slow reference

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

  test("Arduino micros() body fast block matches the handler path", () => {
    const variants = [
      { overflowCount: 0x04030201, tcnt0: 0x05, tifr0: 0x00 },
      { overflowCount: 0x04030201, tcnt0: 0x05, tifr0: 0x01 },
      { overflowCount: 0x04030201, tcnt0: 0xff, tifr0: 0x01 },
    ];
    for (const variant of variants) {
      const slow = createArduinoMicrosBody();
      const fast = createArduinoMicrosBody();
      slow.onTrace(() => {});
      seedArduinoMicrosBody(slow, variant);
      seedArduinoMicrosBody(fast, variant);

      slow.run(48);
      fast.run(48);

      expectSameCoreState(fast, slow, [
        18,
        19,
        20,
        22,
        23,
        24,
        25,
        26,
        27,
        SPL_ADDR,
        SPH_ADDR,
        SREG_ADDR,
      ]);
    }
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

  test("profileRun reports fast blocks without disabling the fast path", () => {
    const cpu = createZeroSbiwBreqLoop(28);
    const events: Array<{ kind: string; blockKind?: string; elapsedCycles: number; pc: number }> = [];

    cpu.profileRun(20, (event) => {
      events.push({
        kind: event.kind,
        blockKind: event.blockKind,
        elapsedCycles: event.elapsedCycles,
        pc: event.pc,
      });
    });

    expect(events).toEqual([
      { kind: "fast-block", blockKind: "zero-sbiw-breq", elapsedCycles: 20, pc: 0 },
    ]);
    expect(cpu.cycles).toBe(20);
  });

});

describe("subcmp-run fast block (Step 4)", () => {
  // Arduino delay()'s 64-bit elapsed compare: SUB; SBC; SBC; SBC; CPI; SBCI; CPC; CPC.
  const delayChain = [0x1968, 0x0979, 0x098a, 0x099b, 0x3e68, 0x4073, 0x0581, 0x0591];

  function loadChain(cpu: CPU, ops: number[], sreg = 0xe2): void {
    cpu.setExecutor(new Decoder());
    cpu.flash.set([...ops, 0x0000]);
    for (let r = 0; r < 32; r += 1) cpu.data[r] = (r * 7 + 3) & 0xff;
    cpu.data[SREG_ADDR] = sreg;
  }

  function expectSame(fast: CPU, slow: CPU): void {
    expect(fast.pc).toBe(slow.pc);
    expect(fast.cycles).toBe(slow.cycles);
    expect(fast.sreg.value).toBe(slow.sreg.value);
    expect(Array.from(fast.data)).toEqual(Array.from(slow.data));
  }

  // Several SREG seeds toggle carry-in and the previous-Z used by SBC/SBCI/CPC.
  for (const sreg of [0x00, 0x01, 0x02, 0x03, 0xe2]) {
    test(`block path matches the handler for the delay chain (SREG=0x${sreg.toString(16)})`, () => {
      const fast = new CPU();
      loadChain(fast, delayChain, sreg);
      const slow = new CPU();
      loadChain(slow, delayChain, sreg);
      fast.run(delayChain.length); // block executes all 8 in one dispatch
      for (let i = 0; i < delayChain.length; i += 1) slow.tick();
      expectSame(fast, slow);
    });
  }

  test("the delay chain is recognized as a subcmp-run fast block", () => {
    const cpu = new CPU();
    loadChain(cpu, delayChain);
    let sawBlock = false;
    cpu.profileRun(delayChain.length, (event) => {
      if (event.blockKind === "subcmp-run") sawBlock = true;
    });
    expect(sawBlock).toBe(true);
  });

  test("a short run (< min length) is not blocked but still correct", () => {
    const twoOps = [0x1968, 0x0979]; // only 2 sub/cmp ops, below SUBCMP_RUN_MIN
    const fast = new CPU();
    loadChain(fast, twoOps);
    const slow = new CPU();
    loadChain(slow, twoOps);
    fast.run(twoOps.length);
    for (let i = 0; i < twoOps.length; i += 1) slow.tick();
    expectSame(fast, slow);
  });

  test("block refuses to cross a scheduled clock event (fires it on time)", () => {
    const bump = (cpu: CPU) => () => {
      cpu.data[0x100] = (cpu.data[0x100]! + 1) & 0xff;
    };
    const fast = new CPU();
    loadChain(fast, delayChain);
    const slow = new CPU();
    loadChain(slow, delayChain);
    fast.addClockEvent(bump(fast), 3); // event mid-block -> block must decline
    slow.addClockEvent(bump(slow), 3);
    fast.run(delayChain.length);
    for (let i = 0; i < delayChain.length; i += 1) slow.tick();
    expectSame(fast, slow);
    expect(fast.data[0x100]).toBe(1); // fired exactly once, at the right cycle
  });

  test("block declines when a cycle listener is installed", () => {
    const fast = new CPU();
    loadChain(fast, delayChain);
    const slow = new CPU();
    loadChain(slow, delayChain);
    const fastCycles: number[] = [];
    const slowCycles: number[] = [];
    fast.onCycles((n) => fastCycles.push(n));
    slow.onCycles((n) => slowCycles.push(n));
    fast.run(delayChain.length);
    for (let i = 0; i < delayChain.length; i += 1) slow.tick();
    expectSame(fast, slow);
    // With a listener the block declines, so cycles are reported per instruction.
    expect(fastCycles).toEqual(slowCycles);
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
