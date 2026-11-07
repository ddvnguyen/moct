# Fork upstream sync (multica-x)

How we pull `multica-ai/multica` into our fork every 4–5 days. The script is
`scripts/fork-sync/sync-upstream.sh`; the dsh fork has the same routine.

## When

- The autopilot "Upstream sync check (dsh + multica)" runs Mon and Fri at 09:00
  Asia/Ho_Chi_Minh and opens a card from its `--check` output.
- By hand before a release, and never while a dsh-z deploy is in flight: land the
  sync first, deploy after.

## Prerequisites

- git >= 2.38 (`git merge-tree --write-tree`) and an `upstream` remote:
  `git remote add upstream https://github.com/multica-ai/multica.git`.
- A checkout on `origin/multica-moct` with no uncommitted changes to tracked files.

## Order

1. **Check.** `scripts/fork-sync/sync-upstream.sh --check` reports the newest
   release tag, commits behind, the conflicting files with a fork-owned flag, and
   the migration numbers on both sides. No branch, no `git status` change. Exit:
   `0` clean or up to date, `2` conflicts, `1` usage or environment error.
2. **Sync branch.** Run it again without `--check`: it creates
   `sync/upstream-<version>` from `origin/multica-moct` and merges the newest
   release tag. A conflicted merge is left in the working tree on purpose.
3. **Resolve.** `[fork-owned]` files keep our behaviour, everything else takes
   upstream. Regenerate rather than hand-merge where you can: `make sqlc` for
   `server/pkg/db/generated/**`, both sides' keys in the locale JSON.
4. **Checks.** `pnpm install --frozen-lockfile`, then `pnpm typecheck`,
   `pnpm lint`, `pnpm test`, and `make test` for Go; `make check` runs the
   combined set.
5. **PR** into `multica-moct` (never `master`), title `chore(sync): upstream
   <version>`, body carrying the `--check` report and the migration numbers.
6. **Lane z deploy** after merge: the autodeploy timer takes the merge to dsh-z,
   and the deploy card needs its evidence block (commit, build time, migrations,
   screenshots at least 1300px high). A merged PR is not deployed.

## Fork-owned areas

Computed per run; the table maps where conflicts land, not a substitute for it.

| Area | Paths |
| --- | --- |
| S3 steer/queue, detached runs | `server/internal/daemon/` (`task_supplement*`, `daemon.go`), `server/internal/handler/task_supplement.go` |
| Supplement data layer | `server/pkg/db/queries/supplement.sql`, `server/pkg/db/generated/{supplement,agent}.sql.go` |
| Tab header, sidebar, dsh island | `packages/dsh-plugin/**` |
| Fork UI primitives and copy | `packages/ui/components/ui/*`, `packages/views/locales/*/issues.json` |
| Migrations we own | `server/migrations/617+` (upstream reached 616 on v0.8.1; the v0.8.1 sync moved our 595–614 to 617–636) |
| Decisions rail space (M-253) | `packages/core/paths/spaces.ts` (`decisions` space), `packages/views/layout/app-rail.tsx` (item + pending badge), `packages/views/locales/*/layout.json` (`rail.decisions`) |

## Rules

- The script never pushes and never opens a PR.
- Migration numbers are shared: it warns when an upstream migration reuses a
  number we already spent. Renumber ours; never edit a released upstream
  migration.
- The version key in `schema_migrations` is the full file stem
  (`migrations.ExtractVersion`), not the number. Moving a migration to a new
  stem is therefore two changes: the files, and one entry in
  `forkMigrationRenames` (`server/cmd/migrate/migrate_fork_renumber.go`) so a
  lane that already recorded the old stem renames its row instead of re-running
  the SQL. Gate keys in `server/cmd/migrate/main.go` follow the files.
- The sync runs on the Freebuff Desktop lane via the Orchestrator (Owner
  decision), not from a free-runtime run.
- Do not force-push `multica-moct`; the sync lands as a merge commit.
- The sync must keep MMX working: `--check` prints the `scripts/mmx-version.mjs`
  version string the merged tree would stamp (version from `apps/web/package.json`
  at the tag, stamp at the tag's commit time). After the merge, `node
  scripts/mmx-version.mjs --from-git` must succeed and MMX/bootstrap CI jobs
  stay untouched.
