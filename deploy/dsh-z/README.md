# Lane z — multica-be z, multica_z DB, moct-be z, lane-z daemon

Isolated lane-z topology for the Multica-in-dsh track (M-97 phase 1, child E1
/ M-100). Everything is loopback-only, lives on the workspace disk, and is
provisioned by one idempotent script:

```bash
bash deploy/dsh-z/deploy.sh
```

To re-sync only the lane runtime config (daemon env, `DSH_HOME`, credential refs)
without a full redeploy or a daemon restart:

```bash
bash deploy/dsh-z/sync-runtime-config.sh
```

The script only ever touches its own units and its own database. It never
kills any process by PID (per the lane safety rule, compare with
`multica daemon status` first anyway), never talks to the live control plane
(`multica_backend_1`, `multica-daemon.service`, `dsh-x`, `dsh-z`, `moct-x`,
`moct-backend`), and makes only additive changes on the shared Postgres
cluster (its own role and database, nothing else).

The Go server itself has no loopback default (it listens on `*:PORT` unless
told otherwise), so the deploy writes `MULTICA_BIND_HOST=$MULTICA_BE_Z_BIND_HOST`
into the server env file; with the committed default `127.0.0.1`, multica-be z
ends up bound to `127.0.0.1:$MULTICA_BE_Z_PORT` — verify with
`ss -ltnp | grep 4390` after a rerun.

## Topology

| Piece | What runs | Port | Where |
|---|---|---|---|
| multica-be z | Go server built from `multica-moct` | `4390` | `/mnt/workspace/clouds/dsh-z/multica-be/current` (unit `multica-be-z.service`) |
| Postgres | role + db `multica_z` on the existing `:5432` cluster (infra-postgres container) | `5432` | cluster only, no new instance |
| moct-be z | Paseo fleet backend, own Turso file | `8310` | `/mnt/workspace/clouds/moct-z/current` (unit `moct-backend-z.service`, db `data/fleet.db`) |
| lane-z daemon | multica CLI profile `z` under the lane home, dsh runtime | health port `19637` | unit `multica-daemon-z.service` |
| dsh runtime | `dsh --profile multica --stdio` — **skipped: no bundle source** (see notes) | — | would live in `$LANE_HOME/.dsh/profiles/multica` |

```mermaid
flowchart LR
  D["lane-z daemon<br/>profile z, HOME=/mnt/workspace/clouds/dsh-z/data/home"] -->|claim, status, /api/daemon/ws| MB["multica-be z :4390"]
  MB --- PG[("Postgres :5432<br/>db multica_z")]
  D -->|"dsh --profile multica --stdio"| S[("dsh session store<br/>lane home")]
  D -->|inject + moct-mcp (phase 2 children)| MO["moct-be z :8310"]
  MO --- T[("Turso /mnt/workspace/clouds/moct-z/data/fleet.db")]
```

## Files

| File | Purpose |
|---|---|
| `dsh-z.env` | committed, non-secret lane config: ports, DB DSN (password placeholder), lane home, refs, `LANE_MOCT_BASE_URL` (the MOCT seam switch, `docs/moct-seam.md`) |
| `deploy.sh` | idempotent provisioner (the only file you run) |
| `build-plugin-bundle.sh` | packages the built `@multica/dsh-plugin` as a directory bundle for the lane web profile |
| `pnpm-shim/pnpm` | the `pnpm` dsh forwards to for the web profile: corepack on the version the profile declares |
| `lane-cli.sh` | lane CLI wrapper: strips every `MULTICA_*` env var and sets HOME to the lane home, so calls never leak to the live control plane |
| `units/*.service` | systemd user unit templates; deploy.sh substitutes placeholders and installs them `0600` into `~/.config/systemd/user/` |

Runtime secrets (DB password, JWT secret, dev code, PAT, workspace id) are
generated once and kept in
`/mnt/workspace/clouds/dsh-z/data/multica-z.env` (`0600`, never committed).
The DSN committed in `dsh-z.env` carries a `PASSWORD` placeholder; the
composed DSN for the server lives in `/mnt/workspace/clouds/dsh-z/multica-be/env`
(`0600`) and is consumed by the unit via `EnvironmentFile=`.

## Lane hygiene

The lane owns everything it installs. Two properties keep it that way, both
enforced by `deploy.sh` rather than by convention:

- **No install runs a script.** The web profile's `package.json` has no
  `scripts` block. It used to carry a `postinstall` that ran a dsh-x script
  against dsh-x's `node_modules`, so every install on this lane wrote outside
  `/mnt/workspace/clouds/dsh-z/`; the patch belongs to that profile, not this
  one. `dsh plugin` is never passed `--ignore-scripts`.
- **One pnpm per profile.** The web profile declares
  `"packageManager": "pnpm@12.14.0"` — the version that built its
  `node_modules` — and phase 9c puts `pnpm-shim/` first on PATH for every
  `dsh plugin --profile web` call. Without it dsh resolves the user's global
  pnpm from PATH, pnpm sees a modules directory from another major, wants to
  recreate it, and aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
  because dsh has no TTY. To install by hand, use the same route:

  ```bash
  cd /mnt/workspace/clouds/dsh-z/data/home/profiles/web
  PATH="<multica-x>/deploy/dsh-z/pnpm-shim:$PATH" \
  DSH_HOME=/mnt/workspace/clouds/dsh-z/data/home \
  HOME=/mnt/workspace/clouds/dsh-z/data/home \
    node /mnt/workspace/clouds/dsh-z/current/apps/cli/lib/bin.js plugin --profile web add <bundle>
  ```

  Corepack serves that pnpm from its cache; a host that has never run it
downloads the binary once.

The only writes an install still makes outside `dsh-z/` are the two shared,
content-addressed caches (`/home/ddv/.pnpm-store/v11` and corepack's pnpm
cache). Neither holds lane state, and neither can be written by another lane's
profile — but they are outside the lane tree, and removing that needs the
profile re-resolved against a store under `dsh-z/`.

## Notes and known deviations

- **Postgres version.** The `:5432` cluster is PostgreSQL 16.15 (the
  infra-postgres container). Multica's docs state PG17; no migration uses
  17-only SQL, and `healthz` (which counts required migrations) is the gate
  used here. `pgcrypto` and `pg_trgm` are required and available on 16;
  `pg_bigm`/`pg_cron` are optional and skipped by the migrations themselves.
- **multica-be z binds all interfaces.** The Go server has no bind-address
  knob (`:PORT` only), so lane z matches the dsh lanes (0.0.0.0) but is
  JWT-gated and has no public route. If the owner wants literal 127.0.0.1
  binding, re-run the server inside a podman container with
  `-p 127.0.0.1:4390:8080` — the reverse-if-needed escape hatch.
- **Lane auth bootstrap.** The server normally emails magic codes, which a
  lane cannot do. The deploy sets `MULTICA_DEV_VERIFICATION_CODE` (random,
  generated at first run) and drives `/auth/send-code` → `/auth/verify-code`
  with it to mint the admin session, then a PAT for the daemon. Dev-only; the
  unit env file lives on the lane, `0600`.
- **pprof.** The second multica-be on the same host cannot take the fixed
  pprof port `6060`; upstream logs "pprof server disabled after startup
  error" and continues — harmless, visible in the unit journal.
- **Turso exclusivity.** moct-be z owns `/mnt/workspace/clouds/moct-z/data/fleet.db`
  exclusively (one process per file by design), which is why it is a separate
  instance from the `moct-x` / `moct-backend` ones.
- **dsh runtime is not installed.** The daemon registers dsh only when
  `$LANE_HOME/.dsh/profiles/multica` names `@multica-ai/dsh-runtime`
  (`server/internal/daemon/dsh_profile.go`). That bridge package is private
  (multica#6936) — it is on no registry, and its only local copy (a `link:`
  target under `/tmp`) was deleted, so the lane daemon registers its other
  runtimes only. The live dsh-x daemon is in the same state today (same probe
  error, dangling link in `/home/ddv/.dsh/profiles/multica`). When a bundle
  source exists, set `DSH_Z_RUNTIME_BUNDLE` (npm spec, directory or tarball)
  and rerun `deploy.sh`; it installs the profile with
  `dsh plugin --profile multica add` under the lane home, idempotently.

## dsh-z and team-room

dsh-z does not carry `@ddvnguyen/moct-dsh-team-room` (removed per M-201 Option A). That package overrode `storage-domain` to `routes: {agent_team: sqlite}`, and only its own `storage-sqlite` row registered the `sqlite` backend, so toggling it off stranded `storageDomain` and left `workspace`, `workspaceRegistry`, `sessionController` and the michengai endpoints waiting forever (404). The Agent Teams feature is unused on this lane; `agent_team.sqlite` (25 rows) is retained on disk for one week before deletion. `deploy/dsh-z/deploy.sh`, `deploy/dsh-z/dsh-z.env` and `scripts/lane-z/autodeploy.sh` do not re-add the package.

## Operations

```bash
systemctl --user status  multica-be-z moct-backend-z multica-daemon-z
systemctl --user restart multica-be-z            # apply a rebuilt release
journalctl --user -u multica-daemon-z -n 100     # lane daemon logs

# lane CLI — always through lane-cli.sh: it strips every MULTICA_* variable
# (inside a daemon-managed task, MULTICA_SERVER_URL / MULTICA_TOKEN point at
# the LIVE control plane and would silently override the lane profile,
# because server URL resolution order is flag > env > profile config) and
# sets HOME to the lane home.
deploy/dsh-z/lane-cli.sh agent list
deploy/dsh-z/lane-cli.sh issue list
```

Redeploy a newer `multica-moct`: bump nothing — `deploy.sh` re-resolves the
ref, builds a new sha-keyed release, re-runs migrations, and restarts its own
units. Same for `MOCT_REF`.

Each multica-be release carries the MMX build stamp (M-155): `release.json`
holds `sha`, `ref`, `version`, `builtAt`, where `version` is
`x.x.x-yyMMMdd.HH.mm` on the UTC+7 clock, taken from the checked-out commit's
committer time by `scripts/mmx-version.mjs` — the same script the GitHub CI
asserts the plugin bundle against, so one SHA always names one build.
`GET /multica/health` returns that string beside `commit`, the panel's client
`identity.version` sends it to multica-be, and the binaries report it as
`main.version`.

## Layout on disk

```
/mnt/workspace/clouds/dsh-z/
  data/multica-z.env            # runtime secrets (0600)
  data/multica-daemon-z.env     # daemon env (0600)
  data/home/                    # LANE_HOME: .multica/profiles/z, .dsh/profiles/multica
  data/workspaces/              # daemon workspaces root
  multica-be/current -> releases/<sha>/{bin/{server,migrate,multica},migrations,release.json}
  multica-be/env                # server env (0600)
  logs/
  src/{multica-x,moct}/         # build checkouts
/mnt/workspace/clouds/moct-z/
  current -> releases/<sha>/{dist,node_modules,package.json,release.json}
  data/fleet.db                 # dedicated Turso file
  data/{state,backups}/
  env                           # moct env (0600)
```
