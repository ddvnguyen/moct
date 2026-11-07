# MMX data migration: multica-main → dedicated PG17 pilot (M-262)

Data-only migration of **multica-main** into a new PostgreSQL 17 database for
the future dsh-z MMX pilot instance. Packaging and scripts only; nothing is
wired into lane-z.

## Invariants

1. **Main stays unaffected.** No change, restart, stop, or reconfigure of the
   main stack (PG container `multica_postgres_1`, backend on 3702, frontend),
   of the multica compose files, or of the lane-z services (`multica-be-z`,
   `multica-daemon-z`, `moct-backend-z`, Caddy, `multica-daemon.service`).
   The export only *reads* from main (plain `pg_dump` + `tar`).
2. **PG17 target only.** The only database the restore can write to is the
   dedicated `multica-pg17-mmx` container on loopback port 55434. Blocklisted
   ports (5432, 3701, 3702, 4390, 8310) and blocklisted container names
   (`multica_postgres_1`, `infra-postgres`, `multica_backend_1`,
   `multica_frontend_1`) are refused even via environment overrides. There is
   no target-DSN override.
3. **Workspace disk only.** PG17 data dir, backups, and scratch live under
   `/mnt/workspace`. `/tmp` writes are refused via the `TMPDIR` guard.
4. **No secrets in logs.** Scripts never print passwords or DSNs; the PG17
   role password lives in a mode-0600 file inside the PG17 dir.

## Layout

```
scripts/mmx-migrate/
  start-pg17.sh            provision or adopt the PG17 container and verify it
  export-main.sh           read-only main snapshot (dump + uploads + counts)
  restore-pg17.sh          checksum verify, fresh-DB restore, count report
  multica-pg17-mmx.service optional systemd unit (starts the container)
  mmx-migrate.test.sh      stubbed-host test (podman/ss/df stubbed)
```

Runtime paths (defaults; override via `MULTICA_MMX_*` env vars):

| Path | Default |
| --- | --- |
| PG17 data dir | `/mnt/workspace/clouds/dsh-z-pg17` |
| PG17 uploads dir | `/mnt/workspace/clouds/dsh-z-pg17/uploads` |
| Backup root | `/mnt/workspace/backups/mmx-migrate` |
| Backup dir | `<backup root>/<UTC timestamp>/` (mode 700) |
| Uploads source | `/mnt/containers/volumes/multica_backend_uploads/_data` |
| Main stack dir | `~/.local/share/multica` |
| PG17 container / port / role | `multica-pg17-mmx` / `127.0.0.1:55434` / `multica` |
| PG17 target DB | `multica_mmx` |

## Run

```bash
# 1. Provision (or adopt) the PG17 target container. Idempotent.
scripts/mmx-migrate/start-pg17.sh
# 2. Snapshot main (read-only).
scripts/mmx-migrate/export-main.sh
# 3. Restore into a fresh multica_mmx (refuses if it exists).
scripts/mmx-migrate/restore-pg17.sh /mnt/workspace/backups/mmx-migrate/<UTC-ts>
# Iterate: drop + recreate.
scripts/mmx-migrate/restore-pg17.sh <dump-dir> --recreate
```

Before any live run, preview with `--dry-run` (checksums are still verified
for restore). The backup dir gets `database.dump` (pg_dump `-Fc`, same method
as `scripts/deploy-main.sh`), `uploads.tar`, `counts.tsv` (per-table row
counts at export time), and `sha256sums.txt`.

## Verify

- `start-pg17.sh` verifies: `pgvector/pgvector:pg17` image, server version
  17.x, port bound to `127.0.0.1:55434`, data dir 0700 with a mode-0600
  password file unless the container pre-existed.
- `restore-pg17.sh` prints per-table counts for `issue`, `comment`,
  `attachment`, `agent`, `agent_runtime`, `user`, `workspace`,
  `schema_migrations` as source vs target. Export-time (`counts.tsv`)
  mismatches are fatal; a drift from *live* source counts (main changed
  since the export) is reported but not fatal.
- `multica-pg17-mmx.service` with `--install-unit` renders the unit file
  into the dump dir for review before installing.

## Delete a pilot dump

The pilot DB lives only in `multica-pg17-mmx`. To remove it:

```bash
podman exec multica-pg17-mmx psql -U multica -d postgres \
  -c 'DROP DATABASE IF EXISTS multica_mmx;'
```

To remove the container itself (after stopping any pilot that used it):

```bash
podman stop multica-pg17-mmx
podman rm multica-pg17-mmx
```

An existing `multica_mmx` database from a previous step blocks a fresh
restore until you pass `--recreate` (drop + create) or drop it by hand.
