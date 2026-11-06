#!/usr/bin/env bash
# Read-only export of multica-main for the MMX data migration (M-262).
#
# Writes a timestamped backup dir under /mnt/workspace/backups/mmx-migrate/
# (mode 700):
#   database.dump   pg_dump -Fc of main's multica DB, same method as
#                   scripts/deploy-main.sh (podman exec ... sh -c pg_dump)
#   uploads.tar     read-only copy of the multica_backend_uploads volume
#                   contents (tar of ".", matching the lane upload layout)
#   counts.tsv      per-table source row counts at export time
#   sha256sums.txt  checksums of the three files above
#
# main is never written to: pg_dump is a plain read and the volume is only
# tar-read. Aborts if < 10 GiB free under /mnt/workspace. Never prints
# secrets or DSNs with passwords. Refuses if the target is main itself.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: export-main.sh [--dry-run]

Read-only snapshot of multica-main for MMX migration.

Environment overrides (defaults shown):
  MULTICA_MMX_STACK_DIR=$HOME/.local/share/multica
  MULTICA_MMX_WORKSPACE_ROOT=/mnt/workspace
  MULTICA_MMX_BACKUP_ROOT=/mnt/workspace/backups/mmx-migrate
  MULTICA_MMX_UPLOADS_DIR=/mnt/containers/volumes/multica_backend_uploads/_data
  MULTICA_MMX_MAIN_PG_CONTAINER=<auto-detected>
  MULTICA_MMX_PG17_CONTAINER=multica-pg17-mmx
  TMPDIR=<must be under /mnt/workspace>
EOF
}

log() { printf '[mmx-export-main %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

STACK_DIR="${MULTICA_MMX_STACK_DIR:-$HOME/.local/share/multica}"
ENV_FILE="$STACK_DIR/.env"
WORKSPACE_ROOT="${MULTICA_MMX_WORKSPACE_ROOT:-/mnt/workspace}"
BACKUP_ROOT="${MULTICA_MMX_BACKUP_ROOT:-$WORKSPACE_ROOT/backups/mmx-migrate}"
UPLOAD_DIR="${MULTICA_MMX_UPLOADS_DIR:-/mnt/containers/volumes/multica_backend_uploads/_data}"
PG17_CONTAINER="${MULTICA_MMX_PG17_CONTAINER:-multica-pg17-mmx}"
MIN_FREE_KB=$((10 * 1024 * 1024))

case "$BACKUP_ROOT" in "$WORKSPACE_ROOT"/*) ;; *) die "backup root must be under $WORKSPACE_ROOT: $BACKUP_ROOT" ;; esac
case "$BACKUP_ROOT" in /tmp*|/var/tmp*|/home/*) die "backup root must stay on the workspace disk, not /tmp or home: $BACKUP_ROOT" ;; esac
case "$TMPDIR" in "$WORKSPACE_ROOT"/*) ;; *) die "TMPDIR must be under $WORKSPACE_ROOT (set TMPDIR=/mnt/workspace/tmp/\$MULTICA_TASK_ID)" ;; esac

for cmd in awk cat chmod date df mkdir mktemp podman sha256sum stat tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done

[ -d "$STACK_DIR" ] || die "main stack directory not found: $STACK_DIR (set MULTICA_MMX_STACK_DIR)"
[ -f "$ENV_FILE" ] || die "main stack environment file not found: $ENV_FILE"
[ -d "$UPLOAD_DIR" ] || die "uploads volume not found: $UPLOAD_DIR"

read_env_value() { # $1 = key; prints only a simple KEY=value from the stack env
  awk -F= -v key="$1" '
    $1 == key {
      sub(/^[^=]*=/, "")
      if ((substr($0, 1, 1) == "\047" && substr($0, length($0), 1) == "\047") ||
          (substr($0, 1, 1) == "\042" && substr($0, length($0), 1) == "\042")) {
        $0 = substr($0, 2, length($0) - 2)
      }
      print
      found++
    }
    END {if (found > 1) exit 2}
  ' "$ENV_FILE"
}
free_kb() { df -Pk "$1" | awk 'NR==2 {print $4}'; }

POSTGRES_USER="$(read_env_value POSTGRES_USER || true)"
POSTGRES_DB="$(read_env_value POSTGRES_DB || true)"
POSTGRES_USER="${POSTGRES_USER:-multica}"
POSTGRES_DB="${POSTGRES_DB:-multica}"
[[ "$POSTGRES_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "invalid POSTGRES_USER in $ENV_FILE"
[[ "$POSTGRES_DB" =~ ^[A-Za-z0-9_]+$ ]] || die "invalid POSTGRES_DB in $ENV_FILE"

available="$(free_kb "$WORKSPACE_ROOT")"
[[ "$available" =~ ^[0-9]+$ ]] || die "could not read free space for $WORKSPACE_ROOT"
[ "$available" -ge "$MIN_FREE_KB" ] || die "$WORKSPACE_ROOT has less than 10 GiB free; aborting"

MAIN_PG_CONTAINER="${MULTICA_MMX_MAIN_PG_CONTAINER:-}"
if [ -z "$MAIN_PG_CONTAINER" ]; then
  MAIN_PG_CONTAINER="$(cd "$STACK_DIR" && podman ps -q --filter "label=com.docker.compose.service=postgres" --filter "label=com.docker.compose.project=multica" 2>/dev/null || true)"
fi
[ -n "$MAIN_PG_CONTAINER" ] || die "could not locate main postgres container"
state="$(podman inspect "$MAIN_PG_CONTAINER" --format '{{.State.Status}}' 2>/dev/null || true)"
[ "$state" = "running" ] || die "main postgres container $MAIN_PG_CONTAINER is not running (state: $state)"
# Hard guard: the export source can never be the MMX target.
[ "$MAIN_PG_CONTAINER" != "$PG17_CONTAINER" ] || die "refusing: source and target containers coincide ($MAIN_PG_CONTAINER)"

if [ "$DRY_RUN" = 1 ]; then
  printf 'MMX export plan (read-only)\n'
  printf '  source:   main postgres container %s, db %s (role %s)\n' "$MAIN_PG_CONTAINER" "$POSTGRES_DB" "$POSTGRES_USER"
  printf '  backup:   %s/<UTC-ts>/ (database.dump, uploads.tar, counts.tsv, sha256sums.txt)\n' "$BACKUP_ROOT"
  printf '  uploads:  %s (read via tar)\n' "$UPLOAD_DIR"
  printf '  free:     %s KB under %s (needs >= %s KB)\n' "$available" "$WORKSPACE_ROOT" "$MIN_FREE_KB"
  log "dry-run complete; nothing written"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/${STAMP}.XXXXXX")"
chmod 700 "$BACKUP_DIR"
START=$SECONDS

# Same method as scripts/deploy-main.sh: pg_dump -Fc via podman exec.
podman exec "$MAIN_PG_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$BACKUP_DIR/database.dump" \
  || die "database dump failed"
[ -s "$BACKUP_DIR/database.dump" ] || die "database dump is empty"
chmod 600 "$BACKUP_DIR/database.dump"

# Read-only copy of the uploads volume contents.
tar -cf "$BACKUP_DIR/uploads.tar" -C "$UPLOAD_DIR" . \
  || die "uploads copy failed"
[ -s "$BACKUP_DIR/uploads.tar" ] || die "uploads archive is empty"
chmod 600 "$BACKUP_DIR/uploads.tar"

# Per-table source counts at export time (restore compares against these).
counts_tmp="$BACKUP_DIR/counts.tsv.tmp"
: > "$counts_tmp"
for table in issue comment attachment agent agent_runtime user workspace schema_migrations; do
  count="$(podman exec "$MAIN_PG_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM \"$table\";" 2>/dev/null || true)"
  [[ "$count" =~ ^[0-9]+$ ]] || die "could not read count for table $table"
  printf '%s\t%s\n' "$table" "$count" >> "$counts_tmp"
done
mv "$counts_tmp" "$BACKUP_DIR/counts.tsv"
chmod 600 "$BACKUP_DIR/counts.tsv"

(cd "$BACKUP_DIR" && sha256sum database.dump uploads.tar counts.tsv > sha256sums.txt) || die "checksum failed"
chmod 600 "$BACKUP_DIR/sha256sums.txt"

dump_size="$(stat -c %s "$BACKUP_DIR/database.dump" 2>/dev/null || printf '?')"
uploads_size="$(stat -c %s "$BACKUP_DIR/uploads.tar" 2>/dev/null || printf '?')"
dump_sha="$(awk '{print $1}' "$BACKUP_DIR/sha256sums.txt" | head -1 | cut -c1-16)"
log "export complete: $BACKUP_DIR (dump=${dump_size}B uploads=${uploads_size}B sha256=${dump_sha}... duration=$((SECONDS - START))s)"
