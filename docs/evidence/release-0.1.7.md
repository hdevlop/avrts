# 0.1.7 release evidence

Date: 2026-11-20. Package: `@hdevlop/avrts@0.1.7`.

This release makes the generated fast core cheaper per instruction. Its tail calls
`serviceInterrupts()` only when a stall, a deferred interrupt or a pending interrupt
exists, and inline arms add cycles without the `cycles` setter unless a cycle listener
or cycle-exact timing needs it (`plainCycles`). Results are unchanged. See
[the changelog](../../CHANGELOG.md) and the
[performance summary](../performance-summary.md#2026-11-20-the-per-instruction-tail).

## Preparation checks

| Boundary | Result |
| --- | --- |
| Tests | `bun test` passed all 3,044 tests across 89 files (3,031 carried over, 13 new in `test/generated-fast-core.test.ts`); with `plainCycles` forced on, 13 of them fail |
| Release gate | `bun run release:check` passed: typecheck, generated-core freshness, all 3,044 tests, demo build, eight Chromium E2E tests, library/declaration build and package smoke |
| Result fidelity | `bun run bench:result` matched avr8js on all 12 workloads |
| Speed | `bench:compare --isolate --repeats 3`, same session before and after: every workload as fast or faster (0-36%); table in the performance summary |
| Packed archive | `npm pack` produced the 88-file `hdevlop-avrts-0.1.7.tgz` (SHA-1 `55761e161621d920b086fd82c62712682687e89b`) |
| Downstream consumer | KahrabaLab installed the packed archive: its 439 engine tests passed; its arithmetic busy loop ran 4.40x real time against 2.68x on 0.1.6 |
| Native state | `bun run oracle:simavr:compare` passed |
| Native workloads | `bun run oracle:simavr:result` passed |
| Native timing | `bun run oracle:simavr:timing` passed |
| Native runtime | `bun run oracle:simavr:runtime` passed its functional contracts; existing native deviations remain explicit |
| Native Optiboot | `bun run oracle:simavr:optiboot` passed |
| Timer2 handshake | `bun run evidence:digital-models` passed |

Native comparisons retain their stated normalizations and limitations; no
physical-hardware calibration is claimed.

## Final publication receipt

Published on 2026-11-20 as
[`@hdevlop/avrts@0.1.7`](https://www.npmjs.com/package/@hdevlop/avrts/v/0.1.7)
with public access and the `latest` tag, replacing 0.1.6.

The source release commit is
[`8ce88f236ee62e32d1cf674e1c8fc5271f789eb7`](https://github.com/hdevlop/avrts/commit/8ce88f236ee62e32d1cf674e1c8fc5271f789eb7).
This publication receipt was added in a subsequent documentation commit.

| Boundary | Verified result |
| --- | --- |
| Git source | Release commit pushed to `origin/main`; worktree clean at publication |
| Release CI | [Run 44814836460](https://github.com/hdevlop/avrts/actions/runs/44814836460) passed all four jobs: Ubuntu Node 22, Ubuntu Node 24, Windows Node 22 and browser E2E |
| npm upload | `npm publish --access public` from the clean release commit succeeded; npm's `prepublishOnly` lifecycle (the release gate, 3,044 tests and package smoke) ran as part of the command and was not bypassed. npm reported the package as processing; the registry served it about three minutes later |
| Archive identity | The registry tarball, downloaded anonymously, is byte-identical to the `npm pack` archive consumer-tested during preparation |
| Public registry | Anonymous version endpoint returned 0.1.7; `latest` is 0.1.7; registry SHA-1, SHA-512 integrity and 88-file count match the archive |
| Published consumer | KahrabaLab installed 0.1.7 from the registry (lockfile integrity as below) and passed its 439 engine tests, workspace typecheck and the 19 Uno browser specs |
| Tag | Annotated `v0.1.7` pushed and verified on origin to identify release source commit `8ce88f236ee62e32d1cf674e1c8fc5271f789eb7` |

Artifact: `hdevlop-avrts-0.1.7.tgz`, 88 files, 342,900 packed bytes, 1,826,865 unpacked.

- SHA-1: `55761e161621d920b086fd82c62712682687e89b`
- SHA-256: `68c35424f971395d861c921f1691ebf4595dbb5ceeed925e6b310fc34f40053d`
- npm integrity: `sha512-2Aj9YE+Khlg1pQ8gndCw6q67Pt5tKXUfqGFMcSjhoFd1CrHzLHiwFe8cljMC43rxVlQNEkV7j5YGVtouYeDgew==`
- Registry tarball: <https://registry.npmjs.org/@hdevlop/avrts/-/avrts-0.1.7.tgz>

This local CLI publication did not generate an OIDC provenance attestation.
Source identity, successful CI and matching archive digests are recorded above.
