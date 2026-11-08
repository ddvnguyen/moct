#!/usr/bin/env bash
# Restore an MMX export into the dedicated PG17 target (M-262).
#
#   restore-pg17.sh <dump-dir> [--recreate] [--dry-run]
#
# Verifies the dump checksums, creates a FRESH database `multica_mmx` in the
# PG17 target (refuses if it exists unless --recreate), pg_restores with
# --no-owner --no-acl, copies the uploads archive into
# /mnt/workspace/clouds/dsh-z-pg17/uploads, and prints per-table row counts
# for source (export-time, or live if counts.tsv is absent) vs target.
#
# Hard guards: refuses target ports of main (3702, pg of the multica compose
# project) and lane-ish ports (5432, 3701, 4390, 8310), the main/lane source
# container names, and main's own DB name. There is no target-DSN override:
# the only writable target is the provisioned loopback container. Writes
# stay under /mnt/workspace. Never prints secrets or DSNs with passwords.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: restore-pg17.sh <dump-dir> [--recreate] [--dry-run]

Restore an export-main.sh backup dir into the MMX PG17 target.

Environment overrides (defaults shown):
  MULTICA_MMX_WORKSPACE_ROOT=/mnt/workspace
  MULTICA_MMX_PG17_DIR=/mnt/workspace/clouds/dsh-z-pg17
  MULTICA_MMX_PG17_CONTAINER=multica-pg17-mmx
  MULTICA_MMX_PG17_PORT=55434
  MULTICA_MMX_PG17_USER=multica
  MULTICA_MMX_STACK_DIR=$HOME/.local/share/multica
  MULTICA_MMX_MAIN_PG_CONTAINER=<auto-detected>
EOF
}

log() { printf '[mmx-restore-pg17 %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

if [ "$#" -lt 1 ]; then usage >&2; exit 2; fi
DUMP_DIR="$1"
shift
RECREATE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --recreate) RECREATE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

WORKSPACE_ROOT="${MULTICA_MMX_WORKSPACE_ROOT:-/mnt/workspace}"
PG17_DIR="${MULTICA_MMX_PG17_DIR:-$WORKSPACE_ROOT/clouds/dsh-z-pg17}"
CONTAINER="${MULTICA_MMX_PG17_CONTAINER:-multica-pg17-mmx}"
PORT="${MULTICA_MMX_PG17_PORT:-55434}"
PG_USER="${MULTICA_MMX_PG17_USER:-multica}"
STACK_DIR="${MULTICA_MMX_STACK_DIR:-$HOME/.local/share/multica}"
TARGET_DB="multica_mmx"

# Hard guards: never write to main or the lane.
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$PORT > 0 && 10#$PORT <= 65535 )) || die "invalid port: $PORT"
case "$PORT" in 5432|3701|3702|4390|8310) die "refusing blocklisted target port $PORT (main pg/3702/backend, lane 4390, Caddy 3701, other 8310)" ;; esac
case "$CONTAINER" in multica_postgres_1|infra-postgres|multica_backend_1|multica_frontend_1) die "refusing main/lane container as restore target: $CONTAINER" ;; esac
case "$PG17_DIR" in "$WORKSPACE_ROOT"/*) ;; *) die "PG17 dir must be under $WORKSPACE_ROOT: $PG17_DIR" ;; esac
case "$PG17_DIR" in /tmp*|/var/tmp*|/home/*) die "PG17 dir must stay on the workspace disk, not /tmp or home: $PG17_DIR" ;; esac
[[ "$PG_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "invalid PG user: $PG_USER"

for cmd in awk cat chmod date mkdir podman sha256sum tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done

[ -d "$DUMP_DIR" ] || die "dump dir not found: $DUMP_DIR"
for f in database.dump uploads.tar sha256sums.txt; do
  [ -f "$DUMP_DIR/$f" ] || die "dump dir is missing $f"
done
DUMP_DIR="$(cd "$DUMP_DIR" && pwd)"

read_main_env_value() { # $1 = key; prints only a simple KEY=value from the stack env
  awk -F= -v key="$1" '
    $1 == key {
      sub(/^[^=]*=/, "")
      print
      found++
    }
    END {if (found > 1) exit 2}
  ' "$STACK_DIR/.env" 2>/dev/null || true
}
SOURCE_DB="$(read_main_env_value POSTGRES_DB)"
SOURCE_DB="${SOURCE_DB:-multica}"
[[ "$SOURCE_DB" =~ ^[A-Za-z0-9_]+$ ]] || die "invalid main POSTGRES_DB in $STACK_DIR/.env"
SOURCE_USER="$(read_main_env_value POSTGRES_USER)"
SOURCE_USER="${SOURCE_USER:-multica}"
[[ "$SOURCE_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "invalid main POSTGRES_USER in $STACK_DIR/.env"
[ "$TARGET_DB" != "$SOURCE_DB" ] || die "refusing: target DB equals main's DB ($SOURCE_DB)"

# Checksums (read-only, so checks run even in --dry-run).
( cd "$DUMP_DIR" && sha256sum -c sha256sums.txt >/dev/null ) || die "checksum verification failed for $DUMP_DIR"
log "checksums verified"

state="$(podman inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null || true)"
[ "$state" = "running" ] || die "target container $CONTAINER is not running (state: $state); run scripts/mmx-migrate/start-pg17.sh first"
version="$(podman exec "$CONTAINER" psql -U "$PG_USER" -d postgres -tAc 'SHOW server_version;' 2>/dev/null || true)"
case "$version" in 17.*) ;; *) die "target $CONTAINER is not PostgreSQL 17 (got: $version)" ;; esac

db_exists="$(podman exec "$CONTAINER" psql -U "$PG_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$TARGET_DB';" 2>/dev/null || true)"
HAS_DB=0
[ "$db_exists" = "1" ] && HAS_DB=1
uploads_members="$(tar -tf "$DUMP_DIR/uploads.tar" 2>/dev/null | wc -l | tr -d ' ' || true)"

if [ "$DRY_RUN" = 1 ]; then
  printf 'MMX restore plan\n'
  printf '  dump dir:   %s\n' "$DUMP_DIR"
  printf '  target:     %s db %s (port 127.0.0.1:%s, PG %s)\n' "$CONTAINER" "$TARGET_DB" "$PORT" "$version"
  printf '  db exists:  %s (recreate: %s)\n' "$([ "$HAS_DB" = 1 ] && printf yes || printf no)" "$([ "$RECREATE" = 1 ] && printf true || printf false)"
  printf '  uploads:    %s members -> %s/uploads\n' "$uploads_members" "$PG17_DIR"
  printf '  counts:     %s\n' "$([ -f "$DUMP_DIR/counts.tsv" ] && printf 'export-time counts.tsv' || printf 'live source counts (no counts.tsv)')"
  log "dry-run complete; nothing changed"
  exit 0
fi

# The recreate decision is made BEFORE any write.
if [ "$HAS_DB" = 1 ] && [ "$RECREATE" != 1 ]; then
  die "database $TARGET_DB already exists in $CONTAINER (refusing; pass --recreate to drop and recreate)"
fi

if [ "$HAS_DB" = 1 ]; then
  podman exec "$CONTAINER" psql -U "$PG_USER" -d postgres -tAc "DROP DATABASE \"$TARGET_DB\";" >/dev/null
  log "dropped existing $TARGET_DB"
fi
podman exec "$CONTAINER" psql -U "$PG_USER" -d postgres -tAc "CREATE DATABASE \"$TARGET_DB\" OWNER \"$PG_USER\";" >/dev/null \
  || die "could not create database $TARGET_DB"
log "created fresh database $TARGET_DB"

START=$SECONDS
podman exec -i "$CONTAINER" pg_restore --no-owner --no-acl -U "$PG_USER" -d "$TARGET_DB" < "$DUMP_DIR/database.dump" \
  || die "pg_restore failed"
log "pg_restore complete: $((SECONDS - START))s"

# Uploads: wipe and extract (archive packs "." or a single top dir, legacy "./").
mkdir -p "$PG17_DIR/uploads"
rm -rf "$PG17_DIR/uploads"
mkdir -p "$PG17_DIR/uploads"
first_entry="$(tar -tf "$DUMP_DIR/uploads.tar" 2>/dev/null | head -1 || true)"
case "$first_entry" in
  ./|./*) tar -xf "$DUMP_DIR/uploads.tar" -C "$PG17_DIR/uploads" ;;
  *)
    # Single top-level dir in the archive: strip it.
    top="$(printf '%s' "$first_entry" | cut -d/ -f1)"
    tar -xf "$DUMP_DIR/uploads.tar" -C "$PG17_DIR/uploads" --strip-components=1 2>/dev/null || \
      tar -xf "$DUMP_DIR/uploads.tar" -C "$PG17_DIR/uploads"
    log "uploads archive top-level dir stripped: $top"
    ;;
esac

# Per-table counts: target vs source (export-time when available, else live).
MAIN_PG_CONTAINER="${MULTICA_MMX_MAIN_PG_CONTAINER:-}"
if [ -z "$MAIN_PG_CONTAINER" ]; then
  MAIN_PG_CONTAINER="$(cd "$STACK_DIR" && podman ps -q --filter "label=com.docker.compose.service=postgres" --filter "label=com.docker.compose.project=multica" 2>/dev/null || true)"
fi
printf '%-18s %10s %10s  %s\n' "table" "source" "target" "status"
mismatches=0
reported=0
live_counts=""
if [ -n "$MAIN_PG_CONTAINER" ] && podman inspect "$MAIN_PG_CONTAINER" --format '{{.State.Status}}' 2>/dev/null | grep -qx running; then
  for table in issue comment attachment agent agent_runtime user workspace schema_migrations; do
    count="$(podman exec "$MAIN_PG_CONTAINER" psql -U "$SOURCE_USER" -d "$SOURCE_DB" -tAc "SELECT count(*) FROM \"$table\";" 2>/dev/null || true)"
    [[ "$count" =~ ^[0-9]+$ ]] || count=""
    live_counts="$live_counts
$table	$count"
  done
fi
for table in issue comment attachment agent agent_runtime user workspace schema_migrations; do
  export_table="$(awk -F'\t' -v t="$table" '$1 == t {print $2}' "$DUMP_DIR/counts.tsv" 2>/dev/null || true)"
  live_table="$(printf '%s' "$live_counts" | awk -F'\t' -v t="$table" '$1 == t {print $2}' || true)"
  source_count="$export_table"
  [ -n "$source_count" ] || source_count="$live_table"
  target_count="$(podman exec "$CONTAINER" psql -U "$PG_USER" -d "$TARGET_DB" -tAc "SELECT count(*) FROM \"$table\";" 2>/dev/null || true)"
  [[ "$target_count" =~ ^[0-9]+$ ]] || die "could not read target count for table $table"
  if [ -z "$source_count" ]; then
    printf '%-18s %10s %10s  %s\n' "$table" "?" "$target_count" "source unavailable (main pg not running?)"
    continue
  fi
  reported=$((reported + 1))
  if [ "$source_count" = "$target_count" ]; then
    printf '%-18s %10s %10s  %s\n' "$table" "$source_count" "$target_count" "match"
  else
    # Online traffic may have moved live source counts; only a counts.tsv
    # (export-time) mismatch is a real failure.
    if [ -n "$export_table" ]; then
      printf '%-18s %10s %10s  %s\n' "$table" "$source_count" "$target_count" "MISMATCH (export-time)"
      mismatches=$((mismatches + 1))
    else
      printf '%-18s %10s %10s  %s\n' "$table" "$source_count" "$target_count" "differs from live source (main changed since export?)"
    fi
  fi
done

if [ "$mismatches" -gt 0 ]; then
  die "row counts mismatch against export-time counts ($mismatches table(s)); inspect $TARGET_DB in $CONTAINER"
fi
log "restore verified: $reported table(s) compared, 0 export-time mismatches; uploads=$uploads_members entries under $PG17_DIR/uploads"
