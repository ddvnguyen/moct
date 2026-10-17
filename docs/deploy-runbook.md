# MOCT-X deploy and rollback runbook

Pipeline 1: `ddvnguyen/moct` -> MOCT-X at `/mnt/workspace/clouds/moct-x`, port 8210, user unit
`moct-x.service`. The backend is loopback-only and unauthenticated by human decision, so no
secret is read, printed or logged anywhere in the pipeline.

## Where things live

```
/mnt/workspace/clouds/moct-x/
  current        -> releases/<sha>/      symlink; the unit ExecStart points THROUGH it
  releases/<sha>/ dist/ package.json release.json .complete   (node_modules hardlinked)
  data/          moct.db  moct.db-wal  state/  backups/
  logs/          premig-<sha>.log
  .scratch/<sha>/ rehearsal copy: moct.db, state/, backups/, and its own `current` symlink
```

Two releases are kept (`KEEP_RELEASES=2`), three db backups (`KEEP_BACKUPS=3`); the live
release is never pruned.

## What triggers a deploy

`.github/workflows/moct-x-deploy.yml` runs on a push to `main` touching
`src/**`, `tests/**`, `package.json`, `pnpm-lock.yaml` or `scripts/deploy/**`, or on
`workflow_dispatch` with an explicit `sha`. It runs on the self-hosted clouds runner and
installs from the shared pnpm store at `/mnt/workspace/pnpm-store` (hardlinked, same device).

## What the deploy does, in order

1. **Preflight** - unit file present, `dist/` built, protected ports (3080, 3081, 8099, 8110,
   18081, 18789, 4097) refused.
2. **Package** - `releases/<sha>/` gets `dist/`, `package.json`, a hardlinked `node_modules`,
   and `BUILD_INFO` rewritten to the serving sha so the smoke can prove which sha answers.
3. **Rehearsal** - boot the NEW release against a COPY of the live db on an ephemeral port,
   through a `current` symlink with an absolute path (the unit shape; see the symlink rule
   below), then verify the migrated copy through a daemon-written snapshot:
   `PRAGMA integrity_check` = ok and `schema_version:8` present.
4. **Backup** - only when the service is active; a first deploy takes no backup.
5. **Switch** - `current -> releases/<sha>`. An empty placeholder directory is `rmdir`d; a
   **non-empty** `current` aborts with a FATAL and is never deleted.
6. **Restart** - then fail fast: a 6 x 0.5s `is-active` loop, and if the unit is not active,
   dump `journalctl -n 40` and die. A daemon that exits immediately leaves the unit inactive,
   and waiting out the health budget only produces "did not answer /health" with no evidence.
7. **Smoke** - `/health` identity (version + git_sha), `/schema`, and
   `/team/v1/operations/head?workspaceId=smoke` (the route requires `workspaceId`).
8. **Prune** - old releases and db backups, guarded so an unmatched glob cannot fail a run
   after a green smoke.

## Rollback

Rollback is wired to the **EXIT trap**, not ERR: `die()` calls `exit 1` and bash never runs an
ERR trap for `exit`, so an ERR-only trap misses every post-switch failure (the health timeout,
the `/health` mismatch, `/schema`, `/team/v1/operations/head`). A clean exit 0 skips rollback.

- **A previous release exists** (`current` was a symlink INTO `releases/`): stop the unit,
  point `current` back at it, restore the db from the newest backup, restart.
- **First deploy, no previous release**: stop the unit, undo the switch (`rm` the symlink and
  put the empty placeholder back if there was one), restore the db snapshot, and **leave the
  unit stopped**. Restarting against an empty `current` with `Restart=on-failure` is a crash
  loop: run 39010151404 reached restart counter 89 on
  `Cannot find module '/mnt/workspace/clouds/moct-x/current/dist/daemon.js'` before it was
  stopped by hand.

## The symlink rule

The unit ExecStart is `node /mnt/workspace/clouds/moct-x/current/dist/daemon.js` and `current`
is a symlink to the release directory. Node resolves that symlink when it builds
`import.meta.url`, so `argv[1]` (the link path) and `import.meta.url` (the real path) differ:
a literal comparison is false, the module runs nothing and the process exits 0 silently - no
listener, no log line. `src/entrypoint.ts` (`isEntrypoint`) compares the realpath with a
literal fallback, and both entrypoints (`daemon.ts`, `mcp.ts`) share that one guard.

Corollary for tests, harnesses and rehearsals: boot the daemon through a symlink with an
**absolute** path. `cd <release> && node dist/daemon.js` resolves to the same string on both
sides of the comparison and cannot see this class of bug.

## Verify by hand

```sh
systemctl --user is-active moct-x
systemctl --user show moct-x -p NRestarts --value      # expect 0 on a healthy deploy
readlink /mnt/workspace/clouds/moct-x/current
curl -fsS http://127.0.0.1:8210/health
journalctl --user -u moct-x -n 40 --no-pager
```

## Pipelines

- **Pipeline 1 - MOCT-X (:8210)**: live. See above.
- **Pipeline 2 - fork to DSH-X (:3181)**: separate lane, owned by @DevWorker#03.
- **Pipeline 3 - DSH-Z PROD**: skeleton only, `.github/workflows/moct-prod-deploy.yml`.
  Dispatch-only, and the deploy step needs the typed `PROD_DEPLOY_ACK`. The barriers that
  actually hold: the `prod` runner label is advertised by no runner, so even an armed run
  queues forever and cannot execute on any host; and the PROD script does not exist, so the
  step dies with an explicit message. The `github.actor == 'ddvnguyen'` check is NOT a gate -
  `gh` on this host authenticates as `ddvnguyen`, the same account as the human, so any seat
  here passes it; it only filters other GitHub accounts.

  A true required-reviewer gate is not available on this repo: required-reviewer protection
  rules need a paid plan (`PUT /environments/prod-z` -> 422) and branch protection on `main`
  is refused the same way (403). The `prod-z` environment exists (created 2026-10-17) with no
  protection rule, so deployments are recorded against it and one call adds the human as the
  only required reviewer once the plan allows it. Paying for a plan or making the repo public
  is the human's call.

  Registering a `prod`-labelled runner, or adding `scripts/deploy/moct-prod-deploy.sh`, must
  each be a separate, human-approved change: either one alone turns this skeleton into
  something that can reach a live host.
