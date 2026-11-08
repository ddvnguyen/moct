#!/usr/bin/env bash
# MMX migrate — stubbed-host tests for start-pg17.sh, export-main.sh,
# restore-pg17.sh (M-262).
#
# Style matches scripts/deploy-main.test.sh: every host command is stubbed
# (podman, ss, df), the scripts run against a sandbox under the repo root
# (workspace disk), and no real container, socket, or database is touched.
#
# Coverage:
#   start-pg17.sh    --dry-run plan; blocklisted ports; bad PG17 dir;
#                    adopt when the container already runs.
#   export-main.sh   --dry-run plan; backup-root guard; free-space abort;
#                    real run produces dump+tar+counts+checksums (dir 700);
#                    source/target collision refused.
#   restore-pg17.sh  --dry-run plan; blocklisted port; bad checksums refused;
#                    existing DB refused without --recreate; real run with
#                    --recreate restores and reports export-time matches.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
START="$REPO_ROOT/scripts/mmx-migrate/start-pg17.sh"
EXPORT="$REPO_ROOT/scripts/mmx-migrate/export-main.sh"
RESTORE="$REPO_ROOT/scripts/mmx-migrate/restore-pg17.sh"
SANDBOX="$(mktemp -d "$REPO_ROOT/.mmx-migrate-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
STUB_BIN="$SANDBOX/bin"
WS="$SANDBOX/workspace"
STACK="$SANDBOX/stack"
mkdir -p "$STUB_BIN" "$STACK" "$WS/containers/volumes/multica_backend_uploads/_data/workspaces/w1"
cat > "$STACK/.env" <<'EOF'
POSTGRES_DB=multica
POSTGRES_USER=multica
EOF
printf 'file bytes\n' > "$WS/containers/volumes/multica_backend_uploads/_data/workspaces/w1/a.txt"

cat > "$STUB_BIN/podman" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *SHOW\ server_version*) printf '17.11\n' ;;
  *COLUMNS*) printf '\n' ;;
  *pg_database\ WHERE*) printf '%s\n' "${DB_EXISTS:-}" ;;
  *FROM\ pg_database*) printf '%s\n' "${DB_EXISTS:-}" ;;
  *pg_isready*) exit 0 ;;
  *pg_restore*) exit "${PG_RESTORE_RC:-0}" ;;
  *SELECT\ count*) printf '42\n' ;;
  *CREATE\ DATABASE*) printf 'created\n' ;;
  *DROP\ DATABASE*) printf 'dropped\n' ;;
  *pg_dump*) printf 'pg dump bytes\n' ;;
  *inspect\ multica-pg17-mmx\ --format\ *State.Status*) printf 'running\n' ;;
  *inspect\ multica-pg17-mmx\ --format\ *Config.Image*) printf '%s\n' "${STUB_IMAGE:-pgvector/pgvector:pg17}" ;;
  *inspect\ multica-pg17-mmx\ --format\ *PortBindings*) printf '{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55434"}]}\n' ;;
  *inspect\ multica-pg17-mmx\ --format*) printf '{"Config":{"Image":"%s"}}\n' "${STUB_IMAGE:-pgvector/pgvector:pg17}" ;;
  *inspect\ *State.Status*) printf 'running\n' ;;
  *ps\ -q*) printf 'main-pg-id\n' ;;
  *inspect*) printf '{"State":{"Status":"running"}}\n' ;;
  *start\ multica-pg17-mmx*) printf 'started\n' ;;
  *run\ -d*) printf 'created\n' ;;
  *exec*) printf '42\n' ;;
  *) printf 'unexpected podman call: %s\n' "$*" >&2; exit 90 ;;
esac
EOF
cat > "$STUB_BIN/ss" <<'EOF'
#!/usr/bin/env bash
printf 'LISTEN 0 200 127.0.0.1:55434 0.0.0.0:*\n'
EOF
cat > "$STUB_BIN/df" <<'EOF'
#!/usr/bin/env bash
free="${DF_FREE:-20000000}"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fake 20000000 1 %s 1%% /fake\n' "$free"
EOF
for stub in podman ss df; do chmod 755 "$STUB_BIN/$stub"; done

export PATH="$STUB_BIN:$PATH"
export MULTICA_MMX_WORKSPACE_ROOT="$WS"
export MULTICA_MMX_STACK_DIR="$STACK"
export MULTICA_MMX_BACKUP_ROOT="$WS/backups/mmx-migrate"
export MULTICA_MMX_PG17_DIR="$WS/clouds/dsh-z-pg17"
export MULTICA_MMX_UPLOADS_DIR="$WS/containers/volumes/multica_backend_uploads/_data"
export MULTICA_MMX_MAIN_PG_CONTAINER="main-pg-id"
export MULTICA_MMX_PG17_CONTAINER="multica-pg17-mmx"
export MULTICA_MMX_PG17_PORT="55434"
export HOME="$SANDBOX/home"
mkdir -p "$HOME"
export TMPDIR="$WS/tmp"; mkdir -p "$TMPDIR"

assert() { "$@" || { printf 'assertion failed: %s\n' "$*" >&2; exit 1; }; }
contains() { case "$1" in *"$2"*) ;; *) printf 'expected output to contain %s; got:\n%s\n' "$2" "$1" >&2; exit 1 ;; esac }

# ================= start-pg17 =================
out="$(bash "$START" --dry-run)"
contains "$out" "dry-run complete"
assert test ! -e "$MULTICA_MMX_PG17_DIR/pgpassword"

if MULTICA_MMX_PG17_PORT=3702 bash "$START" >/dev/null 2>&1; then echo "expected blocklisted port refusal (3702)" >&2; exit 1; fi
if MULTICA_MMX_PG17_PORT=4390 bash "$START" >/dev/null 2>&1; then echo "expected blocklisted port refusal (4390)" >&2; exit 1; fi
if MULTICA_MMX_PG17_PORT=5432 bash "$START" >/dev/null 2>&1; then echo "expected blocklisted port refusal (5432)" >&2; exit 1; fi
if MULTICA_MMX_PG17_DIR="$HOME/foo" bash "$START" >/dev/null 2>&1; then echo "expected bad PG17 dir refusal" >&2; exit 1; fi
if MULTICA_MMX_PG17_CONTAINER=multica_postgres_1 bash "$START" >/dev/null 2>&1; then echo "expected main container refusal" >&2; exit 1; fi

# adopt path: the stubbed container already runs with the right image/binding
out="$(bash "$START" 2>&1)"
contains "$out" "PG17 target ready"

# ================= export-main =================
out="$(bash "$EXPORT" --dry-run)"
contains "$out" "dry-run complete"
assert test ! -e "$MULTICA_MMX_BACKUP_ROOT"

if MULTICA_MMX_BACKUP_ROOT="$HOME/backups" bash "$EXPORT" >/dev/null 2>&1; then echo "expected bad backup root refusal" >&2; exit 1; fi
if DF_FREE=1 bash "$EXPORT" >/dev/null 2>&1; then echo "expected free-space abort" >&2; exit 1; fi

bash "$EXPORT" >/dev/null
bdir="$(find "$MULTICA_MMX_BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print -quit)"
assert test -n "$bdir"
assert test -s "$bdir/database.dump"
assert test -s "$bdir/uploads.tar"
assert test -s "$bdir/counts.tsv"
assert test -s "$bdir/sha256sums.txt"
( cd "$bdir" && sha256sum -c sha256sums.txt >/dev/null )
assert test "$(stat -c %a "$bdir")" = 700
assert awk -F'\t' '$1 == "issue" && $2 == "42" { n++ } END { exit !(n == 1) }' "$bdir/counts.tsv"

if MULTICA_MMX_MAIN_PG_CONTAINER="multica-pg17-mmx" bash "$EXPORT" >/dev/null 2>&1; then echo "expected source/target collision refusal" >&2; exit 1; fi

# ================= restore-pg17 =================
out="$(bash "$RESTORE" "$bdir" --dry-run)"
contains "$out" "dry-run complete"
contains "$out" "db exists"

if MULTICA_MMX_PG17_PORT=3702 bash "$RESTORE" "$bdir" >/dev/null 2>&1; then echo "expected blocklisted port refusal (3702)" >&2; exit 1; fi
if MULTICA_MMX_PG17_CONTAINER=infra-postgres bash "$RESTORE" "$bdir" >/dev/null 2>&1; then echo "expected lane container refusal" >&2; exit 1; fi

tampered="$SANDBOX/tampered"
cp -a "$bdir" "$tampered"
printf 'x' >> "$tampered/database.dump"
if bash "$RESTORE" "$tampered" >/dev/null 2>&1; then echo "expected tampered dump refusal" >&2; exit 1; fi
if bash "$RESTORE" "$SANDBOX/missing-dir" >/dev/null 2>&1; then echo "expected missing dump dir refusal" >&2; exit 1; fi

if DB_EXISTS=1 bash "$RESTORE" "$bdir" >/dev/null 2>&1; then echo "expected existing-DB refusal" >&2; exit 1; fi
out="$(DB_EXISTS=1 bash "$RESTORE" "$bdir" --recreate 2>&1)"
contains "$out" "dropped existing"

out="$(bash "$RESTORE" "$bdir" 2>&1)"
contains "$out" "restore verified"
contains "$out" "match"
out="$(DB_EXISTS=1 bash "$RESTORE" "$bdir" --recreate 2>&1)"
contains "$out" "restore verified"

# no counts.tsv: counts fall back to live source (stubbed 42), still matches
liveonly="$SANDBOX/liveonly"
cp -a "$bdir" "$liveonly"
rm "$liveonly/counts.tsv"
( cd "$liveonly" && sha256sum database.dump uploads.tar > sha256sums.txt )
out="$(bash "$RESTORE" "$liveonly" 2>&1)"
contains "$out" "restore verified"
contains "$out" "match"

# docker.io-prefixed image reports the same image: adopt, do not refuse
out="$(STUB_IMAGE="docker.io/pgvector/pgvector:pg17" bash "$START" 2>&1)"
contains "$out" "PG17 target ready"
if STUB_IMAGE="postgres:17" bash "$START" >/dev/null 2>&1; then echo "expected foreign-image refusal" >&2; exit 1; fi
printf 'mmx-migrate stub tests passed\n'
