import { expect, test } from "bun:test";
import { AVR } from "../src";
import * as R from "../src/cpu";

const bit = (n: number) => 1 << n;
const startWrite = (avr: ReturnType<typeof AVR>, mode = 0, address = 7, value = 0x5a) => {
  avr.cpu.writeData(R.EEARL, address);
  avr.cpu.writeData(R.EEDR, value);
  avr.cpu.writeData(R.EECR, (mode << 4) | bit(R.EEMPE));
  avr.cpu.writeData(R.EECR, (mode << 4) | bit(R.EEPE));
};
const spm = (avr: ReturnType<typeof AVR>, operation: number, address = 0x200) => {
  avr.cpu.data[30] = address & 255; avr.cpu.data[31] = address >> 8;
  avr.cpu.flash[0x3f00] = 0x95e8;
  avr.cpu.pc = 0x3f00;
  avr.cpu.writeData(R.SPMCSR, bit(R.SELFPRGEN) | operation);
  avr.cpu.tick();
};

for (const timing of ["fast", "cycle-exact"] as const) {
  for (const [mode, duration, expected] of [[0, 54400, 0x5a], [1, 28800, 255], [2, 28800, 0x50]] as const) {
    test(`${timing}: EEPROM mode ${mode} commits only at its programming deadline`, () => {
      const avr = AVR({ timing }); avr.eeprom.write(7, 0xf0);
      startWrite(avr, mode);
      expect(avr.eeprom.read(7)).toBe(0xf0);
      expect(avr.cpu.data[R.EECR]! & bit(R.EEPE)).not.toBe(0);
      avr.cpu.cycles += duration - 1;
      expect(avr.eeprom.read(7)).toBe(0xf0);
      avr.cpu.cycles++;
      expect(avr.eeprom.read(7)).toBe(expected);
      expect(avr.cpu.data[R.EECR]! & bit(R.EEPE)).toBe(0);
    });
  }
  test(`${timing}: EEPROM busy state protects address, rejects reads and relatches neither data nor mode`, () => {
    const avr = AVR({ timing }); startWrite(avr);
    avr.cpu.writeData(R.EEARL, 8);
    avr.cpu.writeData(R.EEARH, 3);
    avr.cpu.writeData(R.EEDR, 0xc3);
    avr.cpu.writeData(R.EECR, bit(R.EERE));
    expect(avr.cpu.data[R.EEARL]).toBe(7);
    expect(avr.cpu.data[R.EEARH]).toBe(0);
    expect(avr.cpu.data[R.EEDR]).toBe(0xc3);
    startWrite(avr, 1, 9, 0xff);
    avr.cpu.cycles += 54400;
    expect(avr.eeprom.read(7)).toBe(0x5a);
    expect(avr.eeprom.read(8)).toBe(0);
  });
  test(`${timing}: EEPROM instruction stalls advance timers before accepting interrupts`, () => {
    const avr = AVR({ timing });
    avr.cpu.writeData(R.TCCR0B, 1);
    // OUT EECR,r16: I/O address 0x1f, encoded A5:4=01 and A3:0=1111.
    avr.cpu.flash[0] = 0xbb0f; avr.cpu.data[16] = bit(R.EERE);
    const before = avr.cpu.cycles;
    avr.cpu.tick();
    expect(avr.cpu.cycles - before).toBe(5);
    expect(avr.cpu.pc).toBe(1);
    expect(avr.cpu.readData(R.TCNT0)).toBe(5);
    avr.cpu.flash[1] = 0xbb0f; avr.cpu.flash[2] = 0xbb0f;
    avr.cpu.data[16] = bit(R.EEMPE); avr.cpu.tick();
    avr.cpu.data[16] = bit(R.EEPE); const start = avr.cpu.cycles; avr.cpu.tick();
    expect(avr.cpu.cycles - start).toBe(3);
    expect(avr.cpu.pc).toBe(3);
  });
  test(`${timing}: EEPROM snapshot, divider and reset preserve remaining wall time`, () => {
    const avr = AVR({ timing }); startWrite(avr);
    avr.cpu.cycles += 16000; // 1 ms elapsed.
    const resumed = AVR({ timing }).restore(avr.snapshot());
    for (const runtime of [avr, resumed]) {
      runtime.useClock(8_000_000);
      runtime.cpu.cycles += 8000;
      runtime.resetExternal();
      expect(runtime.eeprom.read(7)).toBe(0);
      expect(runtime.cpu.data[R.EECR]! & bit(R.EEPE)).not.toBe(0);
      runtime.cpu.cycles += 11199;
      expect(runtime.eeprom.read(7)).toBe(0);
      runtime.cpu.cycles += 2;
      expect(runtime.eeprom.read(7)).toBe(0x5a);
    }
  });
  test(`${timing}: flash duration, RWW fetch interlock, snapshot and re-enable are distinct`, () => {
    const avr = AVR({ timing }).useFuses({high: 0xfe});
    avr.cpu.flash[0x100] = 0x1234;
    spm(avr, bit(R.PGERS));
    expect(avr.cpu.flash[0x100]).toBe(0x1234);
    expect(avr.cpu.data[R.SPMCSR]! & bit(R.RWWSB)).not.toBe(0);
    const resumed = AVR({ timing }).restore(avr.snapshot());
    for (const runtime of [avr, resumed]) {
      runtime.cpu.pc = 0;
      const pc = runtime.cpu.pc;
      runtime.runCycles(100);
      expect(runtime.cpu.pc).toBe(pc);
      runtime.cpu.cycles += 65600;
      expect(runtime.cpu.flash[0x100]).toBe(0xffff);
      expect(runtime.cpu.data[R.SPMCSR]! & bit(R.SELFPRGEN)).toBe(0);
      runtime.cpu.tick(); expect(runtime.cpu.pc).toBe(pc); // Still RWW blocked.
      spm(runtime, bit(R.RWWSRE));
      expect(runtime.cpu.data[R.SPMCSR]! & bit(R.RWWSB)).toBe(0);
      runtime.cpu.pc = 0; runtime.cpu.flash[0] = 0;
      runtime.cpu.tick(); expect(runtime.cpu.pc).toBe(1);
    }
  });

  test(`${timing}: restoring and resetting programming keep the exact completion cycle`, () => {
    const avr = AVR({ timing });
    // These offsets used to gain a cycle in the cycles -> ms -> cycles conversion.
    for (const elapsed of [21_523, 52_329]) {
      for (const reset of [false, true]) {
        avr.reset(); avr.eeprom.write(7, 0); startWrite(avr);
        avr.cpu.cycles += elapsed;
        const remaining = 54_400 - elapsed;
        if (reset) avr.resetExternal();
        else avr.restore(avr.snapshot());
        avr.cpu.cycles += remaining - 1;
        expect(avr.eeprom.read(7)).toBe(0);
        expect(avr.cpu.data[R.EECR]! & bit(R.EEPE)).toBe(bit(R.EEPE));
        avr.cpu.cycles++;
        expect(avr.eeprom.read(7)).toBe(0x5a);
        expect(avr.cpu.data[R.EECR]! & bit(R.EEPE)).toBe(0);
      }
    }
    for (const reset of [false, true]) {
      avr.useFuses({ high: 0xfe });
      avr.cpu.flash[0x100] = 0x1234;
      spm(avr, bit(R.PGERS));
      avr.cpu.cycles += 21_523;
      const remaining = avr.snapshot().spm!.pendingRemainingCycles!;
      if (reset) avr.resetExternal();
      else avr.restore(avr.snapshot());
      avr.cpu.cycles += remaining - 1;
      expect(avr.cpu.flash[0x100]).toBe(0x1234);
      avr.cpu.cycles++;
      expect(avr.cpu.flash[0x100]).toBe(0xffff);
    }
  });
}

test("reserved EEPROM mode does not start programming or bill a write stall", () => {
  const avr = AVR(); startWrite(avr, 3);
  avr.cpu.flash[0] = 0; // NOP used to measure the absent write stall.
  expect(avr.snapshot().eeprom.pending).toBeUndefined();
  const before = avr.cpu.cycles; avr.cpu.tick();
  expect(avr.cpu.cycles - before).toBe(1);
});

test("EEPROM and flash programming exclude one another and defer ready interrupts", () => {
  const avr = AVR().useFuses({high: 0xfe});
  startWrite(avr);
  avr.cpu.writeData(R.SPMCSR, bit(R.SPMIE));
  expect(avr.snapshot().cpu.pendingInterrupts).not.toContain(R.SPM_READY_VECTOR);
  spm(avr, bit(R.PGERS));
  expect(avr.snapshot().spm!.pendingOperation).toBeNull();
  avr.cpu.cycles += 54400;
  spm(avr, bit(R.PGERS));
  startWrite(avr);
  expect(avr.snapshot().eeprom.pending).toBeUndefined();
});

test("EEPROM ready becomes pending at completion and is accepted at the next instruction boundary", () => {
  const avr = AVR();
  avr.cpu.flash[0] = 0xcfff;
  avr.cpu.sreg.I = true;
  avr.cpu.writeData(R.EEDR, 0x5a);
  avr.cpu.writeData(R.EECR, bit(R.EERIE) | bit(R.EEMPE));
  avr.cpu.writeData(R.EECR, bit(R.EERIE) | bit(R.EEPE));
  expect(avr.snapshot().cpu.pendingInterrupts).not.toContain(R.EE_READY_VECTOR);
  avr.cpu.tick(); expect(avr.cpu.pc).toBe(0);
  avr.cpu.cycles = 54400;
  expect(avr.snapshot().cpu.pendingInterrupts).toContain(R.EE_READY_VECTOR);
  avr.cpu.tick(); expect(avr.cpu.pc).toBe(R.EE_READY_VECTOR);
  avr.cpu.writeData(R.EECR, 0);
  expect(avr.snapshot().cpu.pendingInterrupts).not.toContain(R.EE_READY_VECTOR);
});

test("completed RWW blocking survives snapshot, while reset releases it after the pending programming cycle", () => {
  const avr = AVR().useFuses({high: 0xfe});
  spm(avr, bit(R.PGERS)); avr.cpu.cycles += 65600;
  avr.cpu.pc = 0;
  const resumed = AVR().restore(avr.snapshot());
  resumed.runCycles(10); expect(resumed.cpu.pc).toBe(0);
  spm(avr, bit(R.RWWSRE));
  spm(avr, bit(R.PGERS));
  avr.cpu.cycles += 16000;
  avr.resetExternal();
  avr.cpu.pc = 0; avr.cpu.flash[0] = 0;
  avr.runCycles(100); expect(avr.cpu.pc).toBe(0);
  avr.cpu.cycles += 49600;
  avr.cpu.tick(); expect(avr.cpu.pc).toBe(1);
});

test("NRWW programming halts boot fetches and resumes after clock-rescaled completion", () => {
  const avr = AVR().useFuses({high: 0xfe});
  spm(avr, bit(R.PGERS), 0x7f00);
  const pc = avr.cpu.pc;
  avr.runCycles(100); expect(avr.cpu.pc).toBe(pc);
  avr.useClock(8_000_000);
  avr.cpu.cycles += 33000;
  avr.cpu.flash[pc] = 0;
  avr.cpu.tick(); expect(avr.cpu.pc).toBe(pc + 1);
});

test("RWW geometry is fixed even when BOOTSZ selects a smaller boot section", () => {
  const avr = AVR().useFuses({ high: 0xfe });
  spm(avr, bit(R.PGERS));
  avr.cpu.flash[0x3900] = 0;
  avr.cpu.pc = 0x3900; // NRWW application code below the 256-word boot section.
  avr.cpu.tick(); expect(avr.cpu.pc).toBe(0x3901);
  avr.cpu.cycles += 65600;
  spm(avr, bit(R.RWWSRE));
  spm(avr, bit(R.PGERS), 0x7200); // NRWW target, also outside that boot section.
  const pc = avr.cpu.pc;
  avr.cpu.tick(); expect(avr.cpu.pc).toBe(pc);
  expect(avr.cpu.data[R.SPMCSR]! & bit(R.RWWSB)).toBe(0);
});

for (const timing of ["fast", "cycle-exact"] as const) {
  test(`${timing}: a flash interlock armed inside runCycles stops the next fetch`, () => {
    for (const profile of [false, true]) {
      const avr = AVR({ timing }).useFuses({ high: 0xfe });
      avr.cpu.flash[0x3f00] = 0x95e8;
      avr.cpu.flash[0x3f01] = 0;
      avr.cpu.pc = 0x3f00;
      avr.cpu.data[30] = 0; avr.cpu.data[31] = 0x72; // NRWW outside BOOTSZ.
      avr.cpu.writeData(R.SPMCSR, bit(R.SELFPRGEN) | bit(R.PGERS));
      if (profile) avr.cpu.profileRun(100, () => {});
      else avr.runCycles(100);
      expect(avr.cpu.pc).toBe(0x3f01);
      expect(avr.cpu.cycles).toBe(100);
    }
  });
  test(`${timing}: runCycles honors EEPROM stalls before interrupt entry`, () => {
    const avr = AVR({ timing });
    avr.cpu.flash[0] = 0xbb0f; avr.cpu.data[16] = bit(R.EERE);
    avr.cpu.writeData(R.TCCR0B, 1);
    avr.cpu.sreg.I = true;
    avr.cpu.requestInterrupt(R.TIMER0_OVF_VECTOR);
    avr.runCycles(1);
    expect(avr.cpu.cycles).toBe(9); // OUT + read stall + interrupt entry.
    expect(avr.cpu.pc).toBe(R.TIMER0_OVF_VECTOR);
    expect(avr.cpu.readData(R.TCNT0)).toBe(9);
  });
  test(`${timing}: programming runs through PRR and deep sleep, preserving CLKPR wall time`, () => {
    const avr = AVR({ timing }).useFuses({ high: 0xfe });
    startWrite(avr);
    avr.cpu.cycles += 16000;
    avr.cpu.writeData(R.CLKPR, bit(R.CLKPCE)); avr.cpu.writeData(R.CLKPR, 1);
    avr.cpu.writeData(R.PRR, 0xef);
    avr.cpu.writeData(R.SMCR, bit(R.SE) | (2 << 1)); avr.cpu.sleep();
    const resumed = AVR({ timing }).restore(avr.snapshot());
    resumed.cpu.cycles += 19199;
    expect(resumed.eeprom.read(7)).toBe(0);
    resumed.cpu.cycles++;
    expect(resumed.eeprom.read(7)).toBe(0x5a);
    resumed.cpu.wakeForPeripheral();
    spm(resumed, bit(R.PGERS));
    resumed.cpu.sleep();
    resumed.cpu.cycles += 32800;
    expect(resumed.cpu.flash[0x100]).toBe(0xffff);
    expect(resumed.cpu.data[R.SPMCSR]! & bit(R.SELFPRGEN)).toBe(0);
  });
  test(`${timing}: flash writes latch data and only clear bits until an erase`, () => {
    const avr = AVR({ timing }).useFuses({ high: 0xfe });
    avr.cpu.flash[0x100] = 0xf0f0;
    avr.cpu.data[0] = 0xaa; avr.cpu.data[1] = 0x55;
    spm(avr, 0); spm(avr, bit(R.PGWRT));
    avr.cpu.data[0] = 0xff; avr.cpu.data[1] = 0xff;
    avr.cpu.writeData(R.SPMCSR, bit(R.SELFPRGEN) | bit(R.RWWSRE));
    const resumed = AVR({ timing }).restore(avr.snapshot());
    resumed.cpu.cycles += 65600;
    expect(resumed.cpu.flash[0x100]).toBe(0x50a0);
    expect(resumed.cpu.data[R.SPMCSR]! & bit(R.RWWSB)).not.toBe(0);
  });
}

test("powered programming completes during reset oscillator startup", () => {
  const avr = AVR().useFuses({ low: 0xa2, high: 0xfe });
  startWrite(avr); avr.resetExternal();
  expect(avr.eeprom.read(7)).toBe(0x5a);
  spm(avr, bit(R.PGERS)); avr.resetExternal();
  expect(avr.cpu.flash[0x100]).toBe(0xffff);
  expect(avr.cpu.data[R.SPMCSR]! & bit(R.SELFPRGEN)).toBe(0);
});

test("legacy pending-flash snapshots restore cycle deadlines and page-buffer data", () => {
  const avr = AVR().useFuses({ high: 0xfe });
  avr.cpu.flash[0x100] = 0xffff;
  avr.cpu.data[0] = 0x34; avr.cpu.data[1] = 0x12;
  spm(avr, 0); spm(avr, bit(R.PGWRT));
  const legacy = avr.snapshot();
  delete legacy.cpu.pendingStallCycles;
  delete legacy.spm!.pendingRemainingMs;
  delete legacy.spm!.pendingPageData;
  const remaining = legacy.spm!.pendingRemainingCycles!;
  const resumed = AVR().restore(legacy);
  resumed.cpu.cycles += remaining - 1;
  expect(resumed.cpu.flash[0x100]).toBe(0xffff);
  resumed.cpu.cycles++;
  expect(resumed.cpu.flash[0x100]).toBe(0x1234);
});

test("host program replacement cancels a pending flash commit", () => {
  const hex = ":020000000000FE\n:00000001FF\n";
  const actions = [
    (avr: ReturnType<typeof AVR>) => avr.clearProgram(),
    (avr: ReturnType<typeof AVR>) => avr.reset({ clearProgram: true }),
    (avr: ReturnType<typeof AVR>) => avr.useHex(hex),
    (avr: ReturnType<typeof AVR>) => avr.reload(),
    (avr: ReturnType<typeof AVR>) => avr.chipErase(),
  ];
  for (const replace of actions) {
    const avr = AVR(hex).useFuses({ high: 0xfe });
    avr.cpu.flash[0x100] = 0xffff;
    avr.cpu.data[0] = 0x34; avr.cpu.data[1] = 0x12;
    spm(avr, 0); spm(avr, bit(R.PGWRT));
    replace(avr);
    expect(avr.snapshot().spm!.pendingOperation).toBeNull();
    const image = avr.cpu.flash.slice();
    avr.cpu.cycles += 65600;
    expect(avr.cpu.flash).toEqual(image);
  }
});

test("host chip erase cancels programming without defeating EESAVE", () => {
  for (const high of [0xff, 0xf7]) {
    const avr = AVR().useFuses({ high });
    avr.eeprom.write(7, 0xf0); startWrite(avr);
    avr.chipErase(); avr.cpu.cycles += 54400;
    expect(avr.eeprom.read(7)).toBe(high === 0xf7 ? 0xf0 : 0xff);
    expect(avr.snapshot().eeprom.pending).toBeUndefined();
  }
});
