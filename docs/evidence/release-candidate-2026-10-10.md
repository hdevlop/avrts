# Final local release candidate - 2026-10-10

Historical candidate before the digital extensions. The source and archive below
are superseded by [expanded acceptance](digital-models-2026-10-10.md); their
original identities and results are preserved.

Local implementation and acceptance are complete. Package `@hdevlop/avrts@0.1.2`
is prepared and unpublished. Registry lookup returned 0.0.0-stage, 0.1.0 and
0.1.1, so 0.1.2 remains available; publication was not attempted.

| Boundary | Result |
| --- | --- |
| Source | TypeScript/generated checks passed; 2,845 tests, 18,330 assertions, 80 files, 311.85 seconds |
| Browser | Eight Chromium tests passed (5.1 seconds) |
| Workload results | All twelve cases pass against avr8js and native simavr; shared serial listeners covered separately |
| Native | State comparison, five timing probes and Optiboot pass their documented contracts; 140-byte Optiboot transcript, programmed page and application transitions agree |
| New runtime probes | Three compiled probes; normative avrts checks pass in fast/cycle-exact modes; native programming and Timer1 TOP differences remain explicit |
| Build/package | Clean candidate build/declarations, 85-file consumer smoke and exact-final-archive consumer checks passed |
| npm dry run | Passed against the exact validated tarball; checksum/integrity/file list match |
| Git | Isolated local branch `codex/remaining-work-candidate`; source commit `5a8480a48621f2c4bdad3c0a594c3ce08e4dc9bf`; not pushed |
| Exact-commit CI | Not run for the local candidate; the earlier baseline's green CI does not establish this gate |
| npm publication | Not performed; no published-consumer or tag/provenance claim |
| Physical/wire calibration | Not measured; retained/deferred explicitly in the scope record |

## Artifact identity

- Path: `out/release-2026-10-10/hdevlop-avrts-0.1.2.tgz`
- Package files: 85
- Packed/unpacked bytes: 297042 / 1597493
- SHA-256: `f447f3c751a4bf80b50b9967342fcaedd2ae58c6bb9b9d4365f0e137616e6d3d`
- npm SHA-1: `6270338b0c4373e22023e4c40d6e06b13161f273`
- npm integrity: `sha512-oJ6WElXgEH4TzjVpGiQwYW5Zk6DfzPnE7CpHXTfMbrbCD5o1eSCaOMGuSa8hhbLU15DGu77688vNHKwkTd2BPA==`

[Raw artifact metadata](release-candidate-2026-10-10.json) includes the complete
file list and dry-run receipt. SHA-1 and SHA-512 integrity were recomputed from
the actual archive, rather than copied without checking. The candidate was
clean when built/packed. [Source identity](candidate-source-identity-2026-10-10.json)
compares source, tests, scripts, firmware and configuration with the accepted
workspace; only Windows Git checkout CRLF/LF differences are normalized.
The source commit is the build input; a subsequent local documentation commit
records these receipts without changing packed source, README, changelog or
manifest. The user's main worktree remains available for review.

The dry run publishes nothing and targets the already tested archive. It used
no `--ignore-scripts` flag and does not remove `prepublishOnly` from the manifest.
Source-directory publication still follows `RELEASING.md`. Its release gate
has already passed for the equivalent candidate source; there is no reason to
repeat the unchanged full suite merely to inspect the same tarball.

## Scope and tradeoffs

[Runtime evidence](runtime-fidelity-2026-10-10.md) covers EEPROM busy timing,
CPU access stalls, logical T0/T1 clocks, timed flash operations, RWW geometry,
reset/startup, host image replacement, snapshots and generated-run interlocks.
[Workload evidence](workload-results-2026-10-10.md) completes the twelve result
cases and preserves native phase-correct GPIO observation limits.
[Performance evidence](runtime-performance-2026-10-10.md) keeps raw samples,
profiles, repeats and the remaining peripheral-bound 5-6% baseline regression
on this host. No broad performance improvement or physical timing equivalence
is claimed.

[Scope decisions](calibration-scope-2026-10-10.md) explicitly retain byte-level
serial buses, logical pins and deterministic clock policies, and defer
unselected wire/physical extensions. Local coding is closed for this scope.
Only a separately authorized Git/npm publication or selected hardware/wire
extension needs a further work session; routine continuation is not required.
