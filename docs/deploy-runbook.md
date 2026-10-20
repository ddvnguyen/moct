# Release-train deploy and rollback runbook

This repo (`ddvnguyen/moct`) is the **train owner**: it holds the train map
(`deploy/train-repos.json`), the customization manifest
(`deploy/dsh-customizations.json`), the lane deploy workflow and the snapshot
cutter. The sibling repos of the train (`ddvnguyen/deepseek-harness`,
`ddvnguyen/moct-dsh-team-room`) carry the same branch and tag model, but they
do not own the train.

## The branch model

```
feature PR  ->  integration  ->  released branch
                              (stack PR)
```

- One rolling `integration` branch per repo. It is created from the released
  branch by `.github/workflows/integration-branch.yml` (daily, `5 0 * * *`, plus
  manual dispatch) and is **never** force-updated and **never** deleted.
- The released branch is `main` here, `master` in the two sibling repos.
- The stack PR is `integration` -> the released branch. It is maintained by
  `.github/workflows/stack-pr.yml`.
- There are **no per-day branches**. A day is a *point in time*, not a branch:
  the snapshot tag names that point, and one rolling branch keeps the review
  round short. Per-day branches would multiply the review surface, make the
  stack PR unreadable and break the "what is live" question, because nothing
  would ever merge anything.

## The daily snapshot tag

`snapshot/<ddMMyy>` — for example `snapshot/20Oct26` — is an **annotated** tag
cut on the head of `integration` by `.github/workflows/snapshot-tag.yml`
(daily, `5 0 * * *`, plus manual dispatch with an optional `date` input in the
`ddMMyy` shape).

The date token is always computed from UTC; a manually supplied token is
accepted only in that exact shape. If the tag already exists, the workflow
logs it and exits 0 — tags are never moved and never deleted.

What the tag is for:

- **audit** — one name for "what was on `integration` at 00:05 UTC today",
  across all three repos of the train.
- **rollback** — the anchor a deploy is pinned to, so a lane can be put back
  on a known tree.
- **pinning a deploy** — every deploy workflow takes a `ref`; a snapshot tag
  is the reproducible choice ("deploy exactly today's tree").

The tag does not release anything. Releasing is the stack PR.

One GitHub fact that shapes the rollout: a workflow file is **activated** when
it reaches the default branch (a scheduled or dispatchable workflow is only
read from the default branch). A workflow that lives on `integration` alone
is inert — it is listed by `gh workflow list` only once the stack PR merged
it. That is why the first day of the train has no scheduled runs.

## The stack PR and its skip rule

`.github/workflows/stack-pr.yml` runs on a schedule (every 30 minutes) and on
manual dispatch. It:

1. resolves the released branch and `integration`;
2. **skips** when `git rev-list --count main..integration` is 0 — no new
   commit, no PR, no PR edit, exit 0;
3. **refreshes** the open stack PR for the same head/base instead of opening a
   second one;
4. otherwise opens the stack PR with a body that lists the implementation PRs
   of the stack (`gh pr list --base integration`), the commits
   (`git log main..integration`), the diffstat and the deploy evidence line
   for the head sha.

The skip rule is why the workflow is safe to run on a timer: on a quiet day it
does nothing at all.

## The review round and the CI gate

`.github/workflows/ci.yml` is the PR gate. The job is named `ci` — that exact
name is the required status check on `main` and on `integration`. It runs
`pnpm install --frozen-lockfile` -> `pnpm run typecheck` -> `pnpm run build`
-> `pnpm run test` on node 24, with `permissions: contents: read` and a
concurrency group that cancels superseded runs on the same ref.

The review round: a feature PR goes to `integration`, the `ci` check must be
green, one approving review is required, and conversations must be resolved.
The stack PR then carries the whole reviewed set to the released branch.

The **stack guard** in `stack-pr.yml` decides whether the stack PR is
auto-mergeable: every implementation PR in the stack must be merged, or must
carry an approving review **and** a green `ci` check. Otherwise the blocking
PRs are listed in the job output and a human merges. The workflow then asks
for auto-merge with `gh pr merge --auto`; if GitHub refuses (the repository
currently has `allow_auto_merge=false`), the job **fails loudly** with that
reason instead of pretending the merge is queued. The integrator enables
auto-merge in the repository settings.

## The lane map

| lane | unit | root | port | role |
|---|---|---|---|---|
| MOCT-X | `moct-x.service` | `/mnt/workspace/clouds/moct-x` | 8210 | **data of record** (`FLEET_DB_PATH=/mnt/workspace/clouds/moct-x/data/moct.db`) |
| DSH lane x | `dsh-x.service` | `/mnt/workspace/clouds/dsh-x` | 3181 | rotating alpha lane |
| DSH lane z | `dsh-z.service` | `/mnt/workspace/clouds/dsh-z` | 3180 | rotating alpha lane |

Both DSH lanes run with `DSH_HOME=<lane-root>/data/home` and
`MOCT_TEAM_URL=http://127.0.0.1:8210` — the lanes talk to MOCT-X, which holds
the data of record.

## The rotation rule

Lane x and lane z rotate between `integration` (alpha) and `stable`
(released). The rotation is **always an explicit dispatch** of
`.github/workflows/dsh-lane-deploy.yml` with a `lane` and a `ref`. It is never
automatic, never time-based, and never triggered by a push: a lane changes
only when a human says so, and the dispatch input is the audit trail.

`ref` takes one of:

- `integration` — the alpha head of the sibling repos;
- `stable` — the released branch of the sibling repos;
- `snapshot` — the `snapshot/<ddMMyy>` tag, with the `date` input.

The workflow resolves every requested ref to a sha with `git ls-remote`
(a branch to its head, a tag to its **peeled** sha) and fails loudly, naming
the repo and the ref, when it is missing.

## The shared DSH state

```
/mnt/workspace/clouds/dsh-shared/
  sessions/     shared
  storages/     shared
  agent-team/   shared
  task-board/   shared
  cache/        shared
```

Each lane symlinks those five directories out of `dsh-shared` into
`<lane-root>/data/home/<name>`. `profiles/` and `logs/` stay **per lane**:
the profile is the lane's own writable plugin tree, the logs are the lane's
own history. Conversation history is `sessions/` + `storages/`.

**One writer per session.** The shared tree is shared *between lanes*, not
between processes: a session is owned by the lane that created it. Two lanes
writing the same session file corrupt it, and there is no lock that makes that
safe. Rotate the lane, do not run both lanes against one session.

The symlink rule for `MOCT-X` also applies here: the unit `ExecStart` points
**through** a symlink (`current -> releases/<sha>`), so anything that resolves
its own path must resolve the symlink too.

## The customization delivery path

The DSH plugins are not part of the harness release: they are installed into
the lane's own profile. The manifest `deploy/dsh-customizations.json` is the
single source of truth:

```json
{
  "repos": [
    { "repo": "ddvnguyen/moct-dsh-team-room",
      "packages": [
        { "name": "@ddvnguyen/moct-dsh-team-room", "dir": "." },
        { "name": "@ddvnguyen/dsh-sidebar", "dir": "packages/sidebar" }
      ] }
  ],
  "patch": { "target": "@michengai/dsh-codex-ui",
             "script": "scripts/codex-ui-sidebar-patch/apply.mjs" }
}
```

One authority per script:

- the **plugins repo** (`ddvnguyen/moct-dsh-team-room`) owns the DSH packages
  **and** the codex-ui patch applier
  (`scripts/codex-ui-sidebar-patch/apply.mjs`); the manifest path is relative
  to the plugins checkout;
- the **fork** (`ddvnguyen/deepseek-harness`) owns the release deploy script
  (`scripts/deploy/dsh-deploy.sh`), which is always run from the reviewed
  fork ref.

The path, in order:

1. `scripts/deploy/dsh-customizations-deploy.sh` builds every package of the
   manifest from the plugins checkout with the repo's own build script and
   packs it with `npm pack` into `<lane-root>/artifacts/`.
2. The lane profile's `package.json` and `pnpm-lock.yaml` are snapshotted into
   `<lane-root>/data/backups/customizations-<UTC timestamp>/`.
3. The profile's `file:` dependency entries for those packages are rewritten
   to the new tarball paths, the **obsolete** `@ddvnguyen/*` entries that the
   manifest does not list (`@ddvnguyen/dsh-side-menu`,
   `@ddvnguyen/dsh-hide-im-assistant`) are **removed**, and `pnpm install`
   runs in the profile so their `node_modules` entries go away with them. A
   `@ddvnguyen/*` package left in the profile that the manifest does not list
   is a deploy failure, not a leftover.
4. The codex-ui patch is applied:
   `node <plugins>/scripts/codex-ui-sidebar-patch/apply.mjs
   <profile>/node_modules/@michengai/dsh-codex-ui`. The applier is
   anchor-based: a moved anchor is a **non-zero exit**, and the script fails
   with that message.
5. Every package of the manifest is verified: present in the profile
   `package.json` **and** resolvable in the profile's `node_modules` at the
   expected version, and no obsolete `@ddvnguyen/*` entry left. The script
   prints the package -> version table.
6. On any failure after step 3, the snapshot is restored, `pnpm install` runs
   again and the script exits non-zero. The rollback is wired to the **EXIT
   trap**, not ERR: `die()` calls `exit 1` and bash never runs an ERR trap for
   `exit`, so an ERR-only rollback would miss every failure after the install
   step. The rollback happens before the script returns.

`DRY_RUN=1` prints the plan and changes nothing on disk.

The patch applier takes the codex-ui package directory as its argument and
also accepts `--check`, which reports and writes nothing.

## Rollback

### Lane rollback

The fork's `scripts/deploy/dsh-deploy.sh` rolls back on any failure after the
release switch: the `current` symlink goes back to the previous release, the
live state is restored from the newest snapshot under
`<lane-root>/data/backups/`, the unit is restarted and the run is marked
failed. On a **first** deploy there is no previous release: the switch is
undone, the state snapshot is restored and the unit is left **stopped**.
Restarting against an empty `current` with `Restart=on-failure` is a crash
loop.

To roll back by hand, on the deploy host:

```sh
systemctl --user is-active dsh-x
readlink /mnt/workspace/clouds/dsh-x/current
ls -1t /mnt/workspace/clouds/dsh-x/releases
curl -fsS http://127.0.0.1:3181/
journalctl --user -u dsh-x -n 40 --no-pager
```

Point `current` back at the wanted `releases/<sha>`, restore the state
snapshot if the state changed, restart the unit and read `/` again.

### Snapshot rollback

A snapshot tag is an anchor, not an automatic undo. To roll a lane back onto
a snapshot tree:

1. find the sha: `gh api repos/ddvnguyen/deepseek-harness/git/ref/tags/snapshot/20Oct26`
   (the ref sha is the annotated tag object; the peeled commit sha is in
   `repos/<repo>/git/tags/<tag-sha>.object.sha`);
2. dispatch the lane deploy with `ref=snapshot` and `date=20Oct26` — the
   workflow resolves the tag to the same shas on every run, so the lane lands
   on exactly that tree;
3. for MOCT-X: dispatch `.github/workflows/moct-x-deploy.yml` with
   `ref=snapshot/20Oct26`.

## Verify by hand

MOCT-X:

```sh
systemctl --user is-active moct-x
systemctl --user show moct-x -p NRestarts --value      # expect 0 on a healthy deploy
readlink /mnt/workspace/clouds/moct-x/current
curl -fsS http://127.0.0.1:8210/health
journalctl --user -u moct-x -n 40 --no-pager
```

DSH lane:

```sh
systemctl --user is-active dsh-x
readlink /mnt/workspace/clouds/dsh-x/current
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3181/
node -p "require('/mnt/workspace/clouds/dsh-x/data/home/profiles/web/node_modules/@ddvnguyen/moct-dsh-team-room/package.json').version"
journalctl --user -u dsh-x -n 40 --no-pager
```

## Protected ports

`3080`, `3081`, `8099`, `8110`, `18081`, `18789`, `4097` and `8210` are
refused by every deploy script. `3080` is PROD, `3081`/`8110` are the TEST
fleet, `8210` is MOCT-X (the data of record). `3181` (lane x) and `3180`
(lane z) belong to the DSH lanes and to nothing else.

## MOCT-X specifics

```
/mnt/workspace/clouds/moct-x/
  current        -> releases/<sha>/      symlink; the unit ExecStart points THROUGH it
  releases/<sha>/ dist/ package.json release.json .complete   (node_modules hardlinked)
  data/          moct.db  moct.db-wal  state/  backups/
  logs/          premig-<sha>.log
  .scratch/<sha>/ rehearsal copy: moct.db, state/, backups/, and its own `current` symlink
```

Two releases are kept (`KEEP_RELEASES=2`), three db backups
(`KEEP_BACKUPS=3`); the live release is never pruned. The backend is
loopback-only and unauthenticated by human decision, so no secret is read,
printed or logged anywhere in the pipeline.

The rollback of MOCT-X is wired to the **EXIT trap**, not ERR — the same
reason as the lane script: `die()` calls `exit 1`, and an ERR-only trap misses
every post-switch failure (the health timeout, the `/health` mismatch,
`/schema`, `/team/v1/operations/head`).

## The honest limits

- **PROD is not a pipeline lane.** `dsh-prod.service` on `:3080` is the
  stock upstream harness with a personal profile. It is not deployed by any
  workflow in this train, no script in this repo writes to it, and no deploy
  script accepts it as a target (they refuse a service matching `*prod*` and
  the ports `3080`/`3081`/`8110`/`8210`).
- **The `prod` runner label stays unarmed.** No runner advertises it, so a
  job that asks for it queues forever and never reaches a host. The skeleton
  in `.github/workflows/moct-prod-deploy.yml` stays dispatch-only.
- **The deploy code always comes from a reviewed ref, never from the
  dispatched sha.** In the lane deploy, the product tree is the dispatched
  sha and the deploy scripts are the fork's reviewed `integration` branch. A
  dispatched sha can therefore never run unreviewed deploy code.
- The `github.actor` check is **not** a security gate: `gh` on the deploy host
  authenticates as the same account as the human, so any seat here passes it.
  It only filters other GitHub accounts.
- Required-reviewer protection is available on this repo (the repository is
  public, so a protection `PUT` succeeds) and the integrator applies it: the
  released branch and `integration` require one approving review plus the CI
  check, no direct push, no force push, and conversation resolution.
