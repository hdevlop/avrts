# Release Process

## One-time owner decisions

- Replace `UNLICENSED` in `package.json` and add the chosen license file before
  allowing third-party use. Selecting a license is an owner/legal decision.
- Add `repository`, `homepage`, and `bugs` metadata after the canonical hosting
  URL is known.
- Configure the npm package owner and publishing authentication. Prefer npm
  trusted publishing/provenance when the canonical CI repository exists.

## Release checklist

1. Start from a clean worktree on the intended release commit.
2. Update `CHANGELOG.md`, remove `Unreleased`, and confirm the manifest version.
3. Run `bun install --frozen-lockfile`.
4. Run `bun run release:check`.
5. Run the native oracle gates:
   - `bun run oracle:simavr:compare`
   - `bun run oracle:simavr:timing`
   - `bun run oracle:simavr:optiboot`
6. Inspect `npm pack --dry-run` and verify that only `dist` plus release docs are
   included.
7. Run `npm publish --dry-run` from the clean release commit.
8. Publish, create the matching `vX.Y.Z` annotated tag, and record the final
   package integrity/provenance link in the release notes.

Never publish from a dirty worktree or by bypassing `prepublishOnly`.
