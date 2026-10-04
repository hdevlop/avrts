import { describe, expect, test } from "bun:test";
import { AVR } from "../src";
import { INTEL_HEX_EOF, record } from "./helpers";

type RuntimeInternals = {
  lastHostFrameMs: number;
};

type IntervalHarness = {
  activeCount(): number;
  tick(): void;
};

type RafCallback = (timestamp: number) => void;

type RafHarness = {
  activeCount(): number;
  tick(timestamp: number): void;
};

const EOF = INTEL_HEX_EOF;
const NOP = 0x0000;
const RJMP_SELF = 0xcfff;
const BREAKPOINT_PROGRAM = `${record([NOP, RJMP_SELF])}\n${EOF}`;

function forceElapsed(avr: unknown): void {
  (avr as RuntimeInternals).lastHostFrameMs = -10;
}

type RafGlobals = {
  requestAnimationFrame?: (callback: RafCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

function withStubbedInterval(run: (harness: IntervalHarness) => void): void {
  const globals = globalThis as unknown as RafGlobals;
  const originalRaf = globals.requestAnimationFrame;
  const originalCancelRaf = globals.cancelAnimationFrame;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;

  globals.requestAnimationFrame = undefined;
  globals.cancelAnimationFrame = undefined;
  globalThis.setInterval = ((callback: () => void) => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, callback);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    callbacks.delete(handle as number);
  }) as typeof clearInterval;

  try {
    run({
      activeCount: () => callbacks.size,
      tick: () => {
        const callback = callbacks.values().next().value;
        if (!callback) throw new Error("no active interval callback");
        callback();
      },
    });
  } finally {
    globals.requestAnimationFrame = originalRaf;
    globals.cancelAnimationFrame = originalCancelRaf;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

function withStubbedRaf(run: (harness: RafHarness) => void): void {
  const globals = globalThis as unknown as RafGlobals;
  const originalRaf = globals.requestAnimationFrame;
  const originalCancelRaf = globals.cancelAnimationFrame;
  const callbacks: Array<{ handle: number; callback: RafCallback }> = [];
  let nextHandle = 1;

  globals.requestAnimationFrame = (callback) => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.push({ handle, callback });
    return handle;
  };
  globals.cancelAnimationFrame = (handle) => {
    const index = callbacks.findIndex((entry) => entry.handle === handle);
    if (index >= 0) callbacks.splice(index, 1);
  };

  try {
    run({
      activeCount: () => callbacks.length,
      tick: (timestamp) => {
        const entry = callbacks.shift();
        if (!entry) throw new Error("no active raf callback");
        entry.callback(timestamp);
      },
    });
  } finally {
    globals.requestAnimationFrame = originalRaf;
    globals.cancelAnimationFrame = originalCancelRaf;
  }
}

describe("AVR host loop lifecycle", () => {
  test("pause cancels the interval loop and resume restarts it", () => {
    withStubbedInterval((interval) => {
      const avr = AVR();

      avr.start();
      expect(interval.activeCount()).toBe(1);

      avr.pause();
      expect(avr.status().paused).toBe(true);
      expect(interval.activeCount()).toBe(0);

      avr.resume();
      expect(avr.status().paused).toBe(false);
      expect(interval.activeCount()).toBe(1);

      avr.stop();
      expect(interval.activeCount()).toBe(0);
    });
  });

  test("breakpoint pause on the interval loop can resume and advance", () => {
    withStubbedInterval((interval) => {
      const avr = AVR(BREAKPOINT_PROGRAM).useClock(1_000);
      avr.breakpoint({ pc: 1 });

      avr.start();
      forceElapsed(avr);
      interval.tick();

      expect(avr.status().running).toBe(true);
      expect(avr.status().paused).toBe(true);
      expect(interval.activeCount()).toBe(0);

      const pausedCycles = avr.status().cycles;
      avr.clearBreakpoint(1);
      avr.resume();
      expect(interval.activeCount()).toBe(1);

      forceElapsed(avr);
      interval.tick();
      expect(avr.status().cycles).toBeGreaterThan(pausedCycles);

      avr.stop();
    });
  });

  test("raf loop stops after a breakpoint pause and resumes explicitly", () => {
    withStubbedRaf((raf) => {
      const avr = AVR(BREAKPOINT_PROGRAM).useClock(1_000);
      avr.breakpoint({ pc: 1 });

      avr.start();
      expect(raf.activeCount()).toBe(1);

      forceElapsed(avr);
      raf.tick(1);
      expect(avr.status().running).toBe(true);
      expect(avr.status().paused).toBe(true);
      expect(raf.activeCount()).toBe(0);

      avr.clearBreakpoint(1);
      avr.resume();
      expect(raf.activeCount()).toBe(1);

      avr.stop();
      expect(raf.activeCount()).toBe(0);
    });
  });

  test("a long host stall replays at most 100 ms in one frame", () => {
    withStubbedRaf((raf) => {
      const avr = AVR(`${record([RJMP_SELF])}\n${EOF}`).useClock(1_000_000);
      avr.start();
      (avr as unknown as RuntimeInternals).lastHostFrameMs = 0;

      raf.tick(60_000); // tab was hidden for a minute
      // 100 ms at 1 MHz, plus at most one instruction of overshoot.
      expect(avr.status().cycles).toBeGreaterThanOrEqual(100_000);
      expect(avr.status().cycles).toBeLessThan(100_000 + 4);

      avr.stop();
    });
  });

  test("paused running snapshots restore without scheduling until resume", () => {
    withStubbedRaf((raf) => {
      const source = AVR();
      source.start();
      source.pause();
      const pausedSnap = source.snapshot();
      expect(pausedSnap.runtime.running).toBe(true);
      expect(pausedSnap.runtime.paused).toBe(true);
      expect(raf.activeCount()).toBe(0);

      const target = AVR();
      target.restore(pausedSnap);
      expect(target.status().running).toBe(true);
      expect(target.status().paused).toBe(true);
      expect(raf.activeCount()).toBe(0);

      target.resume();
      expect(raf.activeCount()).toBe(1);

      target.stop();
    });
  });

  test("running unpaused snapshots restore with one live loop", () => {
    withStubbedRaf((raf) => {
      const source = AVR();
      source.start();
      const runningSnap = source.snapshot();
      source.stop();
      expect(raf.activeCount()).toBe(0);

      const target = AVR();
      target.restore(runningSnap);
      expect(target.status().running).toBe(true);
      expect(target.status().paused).toBe(false);
      expect(raf.activeCount()).toBe(1);

      target.resume();
      target.start();
      expect(raf.activeCount()).toBe(1);

      target.stop();
      expect(raf.activeCount()).toBe(0);
    });
  });
});
