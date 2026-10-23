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
green, and the Lead or the Architect agent reviews it. The stack PR then
carries the whole reviewed set to the released branch.

**One account, so the review is a process rule, not a GitHub gate.** The
human and every agent share the `ddvnguyen` account here, and GitHub refuses
an approving review from the PR's author — `POST /pulls/{n}/reviews` with
`event=APPROVE` answers `422 "Review Can not approve your own pull request"`.
With one account that refusal applies to the human's own PR as well, so a
required-review rule would leave **every** PR unmergeable, with no path to
green. The protection rules therefore require the `ci` check, no direct push,
no force push and no branch deletion, and the review is enforced by process:

- the implementing agent asks for review by mentioning the Lead or the
  Architect agent (an agent mention enqueues the review round; a member
  mention notifies nobody);
- the reviewer posts the verdict as a PR comment and a summary in the Multica
  thread — a comment, not a GitHub approval, because an approval is refused;
- the process rule on top: an implementer never reviews its own PR.

**What a second account changes.** With a second GitHub account (or a GitHub
App token) the review becomes a platform gate again: one `PUT` adds
`required_pull_request_reviews` to the two branches and the reviewer approves
normally, so `approved-by:` in a confirm marker stops being a claim and
becomes a fact. The guard below does not need that to work — it gates on the
marker — but the guarantee it makes does.

The **stack guard** in `stack-pr.yml` decides whether the stack PR is
auto-mergeable. Its only non-blocking condition for an implementation PR is
**merged**: an implementation PR reaches the released branch only through its
merge commit, so an open PR — approved or not — is not in the stack, and
letting one through would ship a partial stack (a released branch without
that PR's changes, and a lane that installs unreviewed code).

The stack PR's own merge is gated on a **confirm marker** posted on the stack
PR, naming the head it is about to merge:

```text
<!-- moct-approve -->
reviewed: <40 lowercase hex>
approved-by: Lead|Architect
```

The marker is posted **before** the merge, names **that head only** (a
rewritten PR needs a new marker), and is the **record** of a review — never a
substitute for one. The review of record is the verdict on the Multica card,
and the marker cites it.

GitHub cannot carry that gate. `reviewDecision` is an enum of `APPROVED |
CHANGES_REQUESTED | REVIEW_REQUIRED`; GitHub refuses an approving review from
a PR's own author (`422 "Review Can not approve your own pull request"`), and
in this workspace the human and every agent share one account, so
`reviewDecision` is never `APPROVED`. **Under a single GitHub identity
`approved-by:` is a claim, not a fact**: the guarantee is *"a review exists,
is recorded on the card, and is named in the PR"*, not *"the PR was reviewed
by someone other than its author"*.

**The rule about markers.** A marker may not be posted on a PR whose verdict
carries an open question — answer it first, then post the marker and merge.
The disclosure inside a marker is the mitigation; the rule stops it becoming
a habit.

Otherwise the blocking PRs are listed in the job output. The workflow then
asks for auto-merge with `gh pr merge --auto`; if GitHub refuses, the job
**fails loudly** with that reason instead of pretending the merge is queued.
`allow_auto_merge` is enabled on the three repositories of the train; the
guard no longer merges stacks unattended — every stack needs a Lead or
Architect marker on the stack PR first.

## The lane map

| lane | unit | root | port | role |
|---|---|---|---|---|
| MOCT-X | `moct-x.service` | `/mnt/workspace/clouds/moct-x` | 8210 | **data of record** (`FLEET_DB_PATH=/mnt/workspace/clouds/moct-x/data/moct.db`) |
| DSH lane x | `dsh-x.service` | `/mnt/workspace/clouds/dsh-x` | 3181 | rotating alpha lane |
| DSH lane z | `dsh-z.service` | `/mnt/workspace/clouds/dsh-z` | 3180 | rotating alpha lane |

Both DSH lanes run with `DSH_HOME=<lane-root>/data/home` and
`MOCT_TEAM_URL=http://127.0.0.1:8210` — the lanes talk to MOCT-X, which holds
the data of record.

## Restoring a lane's lifecycle

The two DSH units live in this repository — `deploy/systemd/dsh-x.service` and
`deploy/systemd/dsh-z.service` — as the **source of record**. The lane's
lifecycle belongs to them: the unit owns the port, the trusted-host list
(including the tunnel peer `10.88.0.1`), the `MOCT_TEAM_*` environment and the
restart. No repo script may take the port or start a host by hand.

```bash
install -m 0644 deploy/systemd/dsh-x.service ~/.config/systemd/user/
install -m 0644 deploy/systemd/dsh-z.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh-x dsh-z
systemctl --user is-active dsh-x dsh-z && ss -ltnp | grep -E '3181|3180'
```

The install command **overwrites** the host's copy, so the repository copy wins
on every restore; drift between the two is repaired by running it again.

### What those files restore — and what they do not

The unit is the lane's **lifecycle**. The lane's **content** comes from three
further steps, each with its own owner:

1. **The release deploy** — the release tree, the `current` switch, the unit
   restart and the smoke — is the **fork's** `scripts/deploy/dsh-deploy.sh`
   (`ddvnguyen/deepseek-harness`). The lane workflow checks the fork out as
   `deploy-scripts/` (its reviewed `integration` branch) and runs
   `bash deploy-scripts/scripts/deploy/dsh-deploy.sh`. It refuses to run without
   the unit, and it requires the unit to carry `--host 0.0.0.0`.
2. **The customizations install** — the lane profile's packages and the codex-ui
   sidebar patch — is **this repository's own**
   `scripts/deploy/dsh-customizations-deploy.sh`. It touches the profile, not
   the unit.
3. **The sidebar bootstrap** — `deploy-dsh-x-sidebar.sh` in
   `ddvnguyen/moct-dsh-team-room` — is the only path that installs the
   lane-local applier copy (`<lane-root>/scripts/codex-ui-sidebar-patch/`), the
   `apply-codex-ui-sidebar-patch.sh` wrapper and the profile's `postinstall`
   hook. Run it once, by hand, from a checkout of that repository **before** the
   customizations install: without that wrapper the next `pnpm install` either
   fails or leaves codex-ui unpatched, i.e. the lane comes up with no Teams tab.

Two facts a rebuilt host has to respect. The units hard-code `/home/ddv` and
`/mnt/workspace/clouds/<lane>`, so a host with a different layout edits those
lines by hand — there is no template step, and the lane tree is a host fact.
And the credentials-bearing `EnvironmentFile=-<lane-root>/data/moct.env` is host
state, deliberately **not** kept in this repository.

### Surviving a reboot

Both units are `enabled`, the user session lingers
(`loginctl show-user <user> -p Linger` → `Linger=yes`) and the
`default.target.wants` symlinks carry them into the user session at boot. That
is not an argument — it has been measured: when the host rebooted on
2026-10-21 at 13:45 (+07) both units were active again at `13:45:47`, with
`NRestarts=0`, and owned their ports.

### One lane fact that is not yet per lane

The applier wrapper and the profile's `postinstall` hook currently point at
**lane x's** paths — lane z's profile runs lane x's wrapper — and lane z has no
copy of the three files in its own tree. A restored lane z needs its own copy;
the bootstrap script does not create one today.

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

**The front door.** Because the two lanes share the conversation state, the
user should keep talking to **one** hostname while the lanes rotate behind
it. Point the public hostname at the active lane's port and move it during a
rotation; the history follows the user because it lives in the shared tree.
The public side of that mapping (DNS and the reverse proxy in front of
`dsh-x.ddvnguyen.com` / `dsh-z.ddvnguyen.com`) is not on the deploy host —
it is the one part of the rotation that this repository cannot change.

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

**One writer per session.** The harness owns that rule, not this runbook. A
session directory holds a `session.lock` that the persistence layer takes as a
non-blocking POSIX `flock(2)` for the whole life of a write handle
(`packages/session/session-persistence-jsonl/src/lease.ts` in the fork). The
lock is taken on the inode, the holder verifies the inode is still the file at
the lock path, and a contender does **not** wait: contention surfaces as
`SessionAlreadyOwnedError` and the second writer is refused. The kernel
releases the lock when the holder's descriptor closes, so a crashed holder
never blocks a successor.

So sharing the state tree is safe in the sense that matters: two lanes can
read the same conversation history, and a write to the same session from both
lanes at once is refused loudly instead of corrupting the log. Rotate the
lane rather than running both lanes against one session.

**One caveat on the shared KV store.** `storages/agent_team.sqlite` is opened
in WAL mode by the fork's storage layer
(`packages/storage/storage-sqlite/src/schema.ts`), which sets
`PRAGMA journal_mode` but **no** `busy_timeout`. WAL is the right journal mode
for two processes on one file, but without a busy timeout a second writer that
arrives during a write transaction gets `SQLITE_BUSY` immediately instead of
waiting. Keep one lane as the active one for the team store, and treat a
busy error on it as a "the other lane was busy" signal, not as data loss.

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
  "patches": [
    { "target": "@michengai/dsh-codex-ui",
      "script": "scripts/codex-ui-sidebar-patch/apply.mjs" },
    { "target": "dshmarket",
      "script": "scripts/dsh-market-trusted-host-patch/apply.mjs" }
  ]
}
```

One authority per script:

- the **plugins repo** (`ddvnguyen/moct-dsh-team-room`) owns the DSH packages
  **and** the patch appliers
  (`scripts/codex-ui-sidebar-patch/apply.mjs`,
  `scripts/dsh-market-trusted-host-patch/apply.mjs`); the manifest path is
  relative to the plugins checkout;
- the **fork** (`ddvnguyen/deepseek-harness`) owns the release deploy script
  (`scripts/deploy/dsh-deploy.sh`), which is always run from the reviewed
  fork ref.

The path, in order:

1. `scripts/deploy/dsh-customizations-deploy.sh` builds every package of the
   manifest from the plugins checkout with the repo's own build script and
   packs it with `npm pack` into `<lane-root>/artifacts/`. The artifact is
   named after the **plugins commit** it was built from
   (`<name>-<version>-<sha7>.tgz`), not after the version alone: a version
   only moves on a release commit, so two different builds would write the
   same path with different content and the profile's lockfile - which pins
   that `file:` spec by integrity - could pin the previous build's bytes.
   The artifact also carries `build-info.json` (the commit, the branch, the
   version, the artifact name), so the installed package says which build it
   is.
   The plugins repo
   compiles against a sibling `deepseek-harness` checkout (its tsconfig
   facades point at that sibling's sources) and that sibling must be a **real
   directory**: a symlink resolves to its real path and the TypeScript
   rootDir check fails with TS6059.
   The lane profile must also carry its own pnpm settings in
   `pnpm-workspace.yaml` (`nodeLinker`, `storeDir`, `autoInstallPeers`,
   `allowBuilds`, `minimumReleaseAgeExclude`). pnpm reads the settings from
   there, so a profile without that file resolves with different settings
   than its lockfile was written with, and the install dies with
   `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` or `ERR_PNPM_IGNORED_BUILDS`. The
   script checks it before it writes anything.
2. The lane profile's `package.json` and `pnpm-lock.yaml` are snapshotted into
   `<lane-root>/data/backups/customizations-<UTC timestamp>/`.
3. The profile's `file:` dependency entries for those packages are rewritten
   to the new tarball paths, the **obsolete** `@ddvnguyen/*` entries that the
   manifest does not list (`@ddvnguyen/dsh-side-menu`,
   `@ddvnguyen/dsh-hide-im-assistant`) are **removed**, and `pnpm install`
   runs in the profile so their `node_modules` entries go away with them. A
   `@ddvnguyen/*` package left in the profile that the manifest does not list
   is a deploy failure, not a leftover.
   The install **replaces** the manifest's packages instead of reusing them:
   their installed directories are removed before the install, the way the
   rollback path does it. pnpm's import of a `file:` tarball is keyed by its
   path, so a package whose path did not move keeps the bytes pnpm imported
   before - the lane would serve the previous build while every version check
   stayed green. The stale `packages:`/`snapshots:` entries of those packages
   are dropped from the profile's lockfile as well, so pnpm resolves them
   again and records the checksum of the tarball that was just built.
4. The installed packages are compared with the artifacts they were installed
   from, **file by file** (`scripts/deploy/package-artifact.mjs verify`). A
   version equality is not evidence of a correct deploy - the version of a
   plugin only moves on a release commit - so the deploy compares the bytes
   and names every file that differs.
5. Every patch of the manifest is applied and then **verified**:
   `node <plugins>/scripts/<patch script> <profile>/node_modules/<target>`,
   followed by the same command with `--verify`. The appliers are
   anchor-based: a moved anchor is a **non-zero exit**, and the script fails
   with that message. The `--verify` pass asserts that the installed package
   carries its patch, so a package left half-patched fails the deploy here
   instead of reaching the lane.
6. Every package of the manifest is verified: present in the profile
   `package.json` **and** resolvable in the profile's `node_modules` at the
   expected version, built from the plugins commit this deploy ships, and no
   obsolete `@ddvnguyen/*` entry left. The script prints the package ->
   version -> build table.
7. On any failure after step 3, the snapshot is restored, `pnpm install` runs
   again and the script exits non-zero. The rollback is wired to the **EXIT
   trap**, not ERR: `die()` calls `exit 1` and bash never runs an ERR trap for
   `exit`, so an ERR-only rollback would miss every failure after the install
   step. The rollback happens before the script returns.

The deploy's **stdout** is its data channel (the manifest and the packed
packages are read back from it) and its **log** goes to stderr. Both streams
show up in the CI log.

`DRY_RUN=1` prints the plan and changes nothing on disk.

The patch appliers take the package directory as their argument and also
accept `--check`, which reports and writes nothing, and `--verify`, which
asserts that the installed package carries its patch.

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

**Which plugins commit is the lane running?** The installed package carries
the build it was installed from (`build-info.json`, written into the
artifact):

```sh
node -p "require('/mnt/workspace/clouds/dsh-x/data/home/profiles/web/node_modules/@ddvnguyen/moct-dsh-team-room/build-info.json').pluginsSha"
```

**Does the lane run the bytes of the artifact it was installed from?** The
same comparison the deploy makes, by hand:

```sh
node scripts/deploy/package-artifact.mjs verify \
  /mnt/workspace/clouds/dsh-x/artifacts/ddvnguyen-moct-dsh-team-room-<version>-<sha7>.tgz \
  /mnt/workspace/clouds/dsh-x/data/home/profiles/web/node_modules/@ddvnguyen/moct-dsh-team-room
```

It prints every file that differs and exits non-zero when the installed
package is not the artifact. A version equality is not evidence of a correct
deploy: the version of a plugin only moves on a release commit, so a stale
install and a good one carry the same version.

Both lanes see the same conversation history:

```sh
for lane in x z; do
  printf 'lane %s sessions: ' "$lane"
  find -L "/mnt/workspace/clouds/dsh-$lane/data/home/sessions" -maxdepth 2 -name 'session-*' -type d | wc -l
done
stat -c '%i %n' /mnt/workspace/clouds/dsh-shared/storages/agent_team.sqlite \
  /mnt/workspace/clouds/dsh-x/data/home/storages/agent_team.sqlite \
  /mnt/workspace/clouds/dsh-z/data/home/storages/agent_team.sqlite
# the same inode in all three paths: both lanes read and write one store
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
  released branch and `integration` require the CI check, and refuse direct
  pushes, force pushes and branch deletions. Two things are **not** enforced
  here and must not be relied on: a required approving review (one shared
  account — GitHub refuses the approval, so the rule would block every PR) and
  conversation resolution (the API accepts
  `required_conversation_resolution_enabled` on this repository and answers
  `200`, but the resulting rule still reports
  `required_conversation_resolution.enabled = false`).
