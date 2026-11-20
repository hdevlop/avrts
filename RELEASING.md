# Release Process

Prepared artifact evidence, Git/CI success, npm publication and published-consumer
acceptance must be recorded as separate outcomes. Each release has a receipt in
[docs/evidence](docs/evidence/) (`release-X.Y.Z.md`).

## One-time owner decisions

- Done: the package is MIT-licensed (`LICENSE`), and `repository`, `homepage`,
  and `bugs` point at https://github.com/hdevlop/avrts.
- Configure the npm package owner and publishing authentication. Prefer npm
  trusted publishing/provenance when the canonical CI repository exists.

## Release checklist

1. Start from a clean worktree on the intended release commit.
2. Update `CHANGELOG.md`, remove `Unreleased`, and confirm the manifest version.
3. Run `bun install --frozen-lockfile`.
4. Run `bun run release:check`.
5. Run the native oracle gates:
   - `bun run oracle:simavr:compare`
   - `bun run oracle:simavr:result`
   - `bun run oracle:simavr:timing`
   - `bun run oracle:simavr:optiboot`
   - `bun run oracle:simavr:runtime` (retain native timing deviations explicitly)
   - `bun run evidence:digital-models` (compiled Timer2 handshake in both execution modes; preserve raw native discrepancies)
6. Inspect `npm pack --dry-run` and verify that only `dist` plus release docs are
   included.
7. Run `npm publish --dry-run` from the clean release commit.
8. Publish, create the matching `vX.Y.Z` annotated tag, and record the final
   package integrity/provenance link in the release notes.

Never publish from a dirty worktree or by bypassing `prepublishOnly`.
Native simavr gates require the local compiler and simavr headers/libraries;
the current GitHub CI jobs do not install or run them. Record a missing native
environment as blocked, rather than inferring native success from CI.

## Acceptance and rollback

Keep the acceptance states separate: source validated; browser validated; native
probes validated; artifact prepared; Git/CI verified; npm published; published
consumer validated. Do not report a dry run, local archive, Git push or green workflow
as npm publication.

Before publishing, replace a bad candidate and repeat the affected checks. After
publishing, use a corrective version and the registry's policies; never overwrite a
published version or rewrite published Git history.

## Everyday verification

Run focused tests while working, then the applicable gates once after the final
change; do not rerun an unchanged full suite without a reason.

- `bun run verify`: source, generated core and all Bun tests.
- `bun run build:lib` and `bun run package:smoke`: built package and consumer exports.
- `bun run bench:result`: result fidelity against avr8js.
- `bun run evidence:digital-models` after changes to Timer2 asynchronous
  source/reset/flag-clear handshakes (it needs the native oracle environment).
- `git diff --check` before committing.

Keep fixture rebuilds (`fixtures:arduino`, `fixtures:avr-gcc`) separate from ordinary
source testing, and record missing local toolchains honestly.
