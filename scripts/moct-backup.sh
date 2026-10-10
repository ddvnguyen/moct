#!/usr/bin/env bash
# Daily backup of the MOCT Team Room database (contract v0.3 §1).
# The running daemon takes the copy itself (POST /team/v1/backup, VACUUM INTO on
# its own connection). Turso holds an exclusive lock on fleet.db, so sqlite3
# cannot read the live file. This script checks the copy and prunes old ones.
#   MOCT_URL     daemon base URL (default http://127.0.0.1:8110)
#   BACKUP_DIR   where the daemon writes snapshots (default ~/.moct/backups)
#   KEEP         how many snapshots to keep (default 14)
set -euo pipefail
MOCT_URL="${MOCT_URL:-http://127.0.0.1:8110}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.moct/backups}"
KEEP="${KEEP:-14}"
OUT="$(curl -fsS -X POST "$MOCT_URL/team/v1/backup" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')"
if [ -z "$OUT" ] || [ ! -f "$OUT" ]; then
  echo "moct-backup: daemon did not write a snapshot (got '$OUT')" >&2
  exit 1
fi
CHECK="$(sqlite3 -readonly "$OUT" 'PRAGMA integrity_check;')"
if [ "$CHECK" != "ok" ]; then
  echo "moct-backup: integrity_check failed for $OUT: $CHECK" >&2
  exit 1
fi
# sqlite3 -readonly leaves -wal/-shm beside the copy; the copy itself is self-contained.
rm -f "$OUT-wal" "$OUT-shm"
ls -1t "$BACKUP_DIR"/moct-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm --
echo "moct-backup: wrote and verified $OUT"
