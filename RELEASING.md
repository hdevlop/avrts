# Release Process

Release scope and remaining obligations are tracked in the
[root remaining-work plan](AVRTS-REMAINING-WORK-PLAN.md). Prepared artifact
evidence, Git/CI success, npm publication and published-consumer acceptance
must be recorded as separate outcomes.

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
6. Inspect `npm pack --dry-run` and verify that only `dist` plus release docs are
   included.
7. Run `npm publish --dry-run` from the clean release commit.
8. Publish, create the matching `vX.Y.Z` annotated tag, and record the final
   package integrity/provenance link in the release notes.

Never publish from a dirty worktree or by bypassing `prepublishOnly`.
Native simavr gates require the local compiler and simavr headers/libraries;
the current GitHub CI jobs do not install or run them. Record a missing native
environment as blocked, rather than inferring native success from CI.
