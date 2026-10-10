# Documentation reconciliation evidence

Date: 2026-10-06. Baseline source revision: `859b7fef58ac5864618c01d484c6bcf64b077d89`.
Scope: Phase 0 of the [root remaining-work plan](../../AVRTS-REMAINING-WORK-PLAN.md).

## Changes

- Marked the completed [ATmega328P roadmap](../complete-atmega328p-plan.md),
  [review fix plan](../PLAN.md) and [peripheral timing plan](../real-peripheral-timing-plan.md)
  as historical implementation records, with links to the active root queue.
- Replaced broad silicon/simulator equivalence claims with the actual boundaries:
  register/vector classification, selected result scenarios, native probes and
  reviewed behavioral limitations. Historical dates, counts and measurements remain.
- Distinguished permanent non-goals and design policies from pending feature
  checkboxes, and clarified subsequently superseded SPI and Timer2 descriptions.
- Linked every known behavioral limitation to the root disposition inventory;
  the unmodeled tables retain their machine-checked format and contents.
- Added the missing native result-suite gate to [RELEASING.md](../../RELEASING.md)
  and documented the native toolchain boundary separately from CI.
- Added explicit result coverage and activity classifications to the
  [benchmark plan](../benchmark-plan.md). Seven external workloads still need
  result/state coverage; `serial-print-listener` shares serial firmware.
- Qualified the [performance summary](../performance-summary.md): one-shot serial
  startup output followed by idle execution cannot establish continuous UART
  throughput, whereas the idle foreground of `analog-write` retains active PWM.
  Ratios and raw benchmark evidence were not changed.

## Verification

`bun test test/register-matrix.test.ts` passed: seven tests, zero failures,
959 assertions. This verifies the documentation table/parser and source-hook
classification contract; it does not test all behavior in the limitation prose.

Across nine changed Markdown files, 107 relative file links and four section
anchors were checked successfully. `git diff --check` passed. The patch scope is documentation only;
no simulator source, firmware, package metadata, CI workflow or runtime API changed.

The vendored AVR compiler, installed Arduino AVR 1.8.8 core/AVR GCC 7.3.0 tools,
MSYS2 compiler/bash and simavr header/static-library files were checked for
presence. No toolchain rebuild or new native run is claimed by this check.
The historical unavailable-Arduino-CLI build record is preserved with its date.

Full source, browser, native result/timing, Optiboot, package and CI gates were
not rerun for this documentation batch. Their prior results remain in
[release preparation](release-0.1.2.md); publication was not attempted or verified.

## Next task at completion

The subsequent [arithmetic oracle slice](arithmetic-results-2026-10-06.md)
implemented the task described below; the remainder of Phase 1 stays open.

Implement the `float-math` and `bitbang-crc` result oracles, preserving ordinary
continuous firmware behavior and comparing identical HEX inputs against both
avr8js and native simavr. Phase 1 acceptance remains open in the root plan.
