# Timer2 asynchronous signal performance

Date: 2026-10-06. Baseline: `53e977197643f2989fb5d21ebe4af120ee83af92`.
Candidate: the Timer2 asynchronous flag/wake changes prepared for `0.1.2`.

## Method

`scripts/benchmark-revision.ts` compared the clean detached baseline with the
candidate source on the same Windows host using Bun 1.3.14. Each revision ran
in a fresh process, baseline first, with 500,000 warmup cycles before each
50-million-cycle trial. The first of ten trials was discarded; medians use
the remaining nine and exclude emulator construction. The host was
an Intel Core i7-7700K at 4.20 GHz, Windows 10 IoT Enterprise LTSC 10.0.19044.
Release and native checks finished before these sequential focused runs.

The workloads exercise Arduino PWM, mixed peripherals, frequent interrupt
entry, and asynchronous Timer2 counter polling. This is a four-workload source
comparison; the full historical benchmark matrix was not repeated.

## Results

Throughput is millions of simulated CPU cycles per second.

| Workload | Baseline | Candidate | Change | Samples |
| --- | ---: | ---: | ---: | --- |
| Arduino PWM (`analog-write`) | 297.25 | 309.40 | +4.1% | [JSON](timer2-signals-performance-analog-write.json) |
| Peripheral mix | 1,088.99 | 1,107.82 | +1.7% | [JSON](timer2-signals-performance-peripheral-mix.json) |
| ISR-heavy | 79.30 | 79.92 | +0.8% | [JSON](timer2-signals-performance-isr-heavy.json) |
| Timer2 RTC, quiet repeat | 48.28 | 47.26 | -2.1% | [JSON](timer2-signals-performance-timer2-rtc.json) |

The [initial RTC run](timer2-signals-performance-timer2-rtc-initial.json) measured
47.96 to 47.59 million cycles/s (-0.8%). Package compression briefly overlapped
that run, so the table uses a quiet repeat. Both measurements are retained.
The RTC measurements leave a small throughput cost alongside measurement
variation; no general speed improvement is claimed.

The initial implementation scheduled unnecessary synchronizer work on every
counter callback. The final code returns immediately when no flags are pending.
The measurements above use that final implementation.

Correctness boundaries are in [the signal review](timer2-async-signals.md), and
release checks are in [0.1.2 preparation](release-0.1.2.md).
