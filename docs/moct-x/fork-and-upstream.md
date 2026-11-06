# Fork and upstream

Verified against `multica-moct` at `ac8a04078`.

`packages/dsh-plugin/FORK.md:8-19` records upstream `v0.6.5`, fork base
`cbd75011` and `multica-moct` as the target branch. The current fork has
changes across the daemon, handlers, MOCT client and dsh plugin; inspect the
actual diff before a sync rather than assuming a fixed list of files. The
upstream sync runbook lists fork-owned conflict areas, including daemon,
handler, data layer, plugin and UI (`docs/fork-sync.md`); the seam itself is in
`server/internal/moct/`.

## Sync and record a base

The existing [fork sync runbook](../fork-sync.md) documents prerequisites,
conflict handling, tests and the PR target. Its script supports a read-only
check and a merge branch (`scripts/fork-sync/sync-upstream.sh:5-6,22-32`).
Review the runbook's operational constraints before running it; the check
may fetch unless configured otherwise.

When the rendering base moves, update `packages/dsh-plugin/FORK.md` in the
same change as the island adaptation. Its policy calls for plugin tests,
lint and a workspace build (`packages/dsh-plugin/FORK.md:59-71`). The public
fork entry and stylesheet are governed by the same file
(`packages/dsh-plugin/FORK.md:21-31`).

## Unverified

- The recorded `v0.6.5` label was not independently verified against an upstream tag.
- No upstream sync or conflict resolution was run during this audit.
