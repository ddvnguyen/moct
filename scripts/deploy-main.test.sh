#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/deploy-main.sh"
SANDBOX="$(mktemp -d "$REPO_ROOT/.deploy-main-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
STUB_BIN="$SANDBOX/bin"
HOME_DIR="$SANDBOX/home"
STACK_DIR="$HOME_DIR/.local/share/multica"
WORKSPACE_ROOT="$SANDBOX/workspace"
CONTAINERS_ROOT="$SANDBOX/containers"
mkdir -p "$STUB_BIN" "$HOME_DIR/.local/bin" "$STACK_DIR" "$WORKSPACE_ROOT" "$CONTAINERS_ROOT"
printf 'MULTICA_IMAGE_TAG=old-tag\nPOSTGRES_DB=multica\nBACKEND_PORT=4802\nFRONTEND_PORT=4180\n' > "$STACK_DIR/.env"
printf 'old daemon binary\n' > "$HOME_DIR/.local/bin/multica"
chmod 755 "$HOME_DIR/.local/bin/multica"

cat > "$STUB_BIN/ps" <<'EOF'
#!/usr/bin/env bash
printf '1 %s\n' "${PARENT_ARGS:-init}"
EOF
cat > "$STUB_BIN/df" <<'EOF'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/fake 20000000 1 20000000 1%% /fake\n'
EOF
cat > "$STUB_BIN/podman" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  'image exists') [[ "${FAIL_IMAGE:-}" != "$3" ]] ;;
  'image inspect')
    case "$4" in
      *revision*) printf '%s\n' "$EXPECTED_COMMIT" ;;
      *version*) printf '%s\n' "$IMAGE_TAG" ;;
      *) exit 2 ;;
    esac
    ;;
  'ps -q') printf 'ps -q:%s\n' "$PWD" >> "$STUB_LOG"; printf 'db-id\n' ;;
  'compose up') printf 'compose up\n' >> "$STUB_LOG" ;;
  'exec db-id') printf 'database dump bytes\n' ;;
  'run --rm') printf 'new daemon binary\n' ;;
  *) printf 'unexpected podman call: %s\n' "$*" >&2; exit 90 ;;
esac
EOF
cat > "$STUB_BIN/multica" <<'EOF'
#!/usr/bin/env bash
version="$IMAGE_TAG"
if [[ "${FAIL_DAEMON_VERSION:-0}" == "1" ]]; then version=wrong-version; fi
if [[ "${ACTIVE_TASK_COUNT:-0}" == "1" ]]; then
  printf '{"active_task_count":1,"cli_version":"%s"}\n' "$version"
else
  printf '{"active_task_count":0,"cli_version":"%s"}\n' "$version"
fi
EOF
cat > "$STUB_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$STUB_LOG"
EOF
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
url="${*: -1}"
printf 'curl %s\n' "$url" >> "$STUB_LOG"
case "$url" in
  */health)
    if [[ "${FAIL_HEALTH:-0}" == "1" ]]; then
      printf '{"status":"ok","commit":"old","version":"old-tag"}\n'
    else
      printf '{"status":"ok","commit":"%s","version":"%s"}\n' "$EXPECTED_COMMIT" "$IMAGE_TAG"
    fi
    ;;
  */healthz) printf '{"status":"ok","checks":{"db":"ok","migrations":"ok"}}\n' ;;
  */) printf '200' ;;
  *) exit 91 ;;
esac
EOF
cat > "$STUB_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
/bin/sleep 0.05
EOF
for command in ps df podman multica systemctl curl sleep; do chmod 755 "$STUB_BIN/$command"; done

export PATH="$STUB_BIN:$PATH"
export HOME="$HOME_DIR"
export MULTICA_MAIN_STACK_DIR="$STACK_DIR"
export MULTICA_MAIN_WORKSPACE_ROOT="$WORKSPACE_ROOT"
export MULTICA_MAIN_CONTAINERS_ROOT="$CONTAINERS_ROOT"
export MULTICA_MAIN_BACKUP_ROOT="$WORKSPACE_ROOT/backups"
export MULTICA_MAIN_TMPDIR="$WORKSPACE_ROOT/tmp"
export MULTICA_MAIN_PROC_ROOT="$SANDBOX/proc"
export STUB_LOG="$SANDBOX/commands.log"
export IMAGE_TAG=test-deploy
export EXPECTED_COMMIT=0123456789abcdef0123456789abcdef01234567

assert() { "$@" || { printf 'assertion failed: %s\n' "$*" >&2; exit 1; }; }
run() { bash "$SCRIPT" "$IMAGE_TAG" "$EXPECTED_COMMIT" 1 "$@"; }

# Dry-run performs read-only preflight and does not make temporary or backup dirs.
output="$(run --dry-run)"
[[ "$output" == *"dry-run complete"* ]]
assert test ! -e "$MULTICA_MAIN_TMPDIR"
assert test ! -e "$MULTICA_MAIN_BACKUP_ROOT"

# Missing staged image fails during preflight, before any state changes.
if FAIL_IMAGE="ghcr.io/multica-ai/multica-web:$IMAGE_TAG" run --dry-run >/dev/null 2>&1; then
  echo "expected missing-image preflight failure" >&2; exit 1
fi
assert grep -q '^MULTICA_IMAGE_TAG=old-tag$' "$STACK_DIR/.env"

# The production ancestry guard rejects daemon-managed execution before work.
if PARENT_ARGS='multica daemon start' run --dry-run >/dev/null 2>&1; then
  echo "expected daemon ancestry guard" >&2; exit 1
fi
assert grep -q '^MULTICA_IMAGE_TAG=old-tag$' "$STACK_DIR/.env"

# Drain timeout aborts by default and leaves config and daemon untouched.
if ACTIVE_TASK_COUNT=1 run >/dev/null 2>&1; then
  echo "expected drain timeout" >&2; exit 1
fi
assert grep -q '^MULTICA_IMAGE_TAG=old-tag$' "$STACK_DIR/.env"
assert grep -q 'old daemon binary' "$HOME/.local/bin/multica"

# A post-switch health failure restores .env and daemon binary and brings the
# compose stack and daemon back up. All host commands above are stubbed.
if FAIL_HEALTH=1 run >/dev/null 2>&1; then
  echo "expected health verification failure" >&2; exit 1
fi
assert grep -q '^MULTICA_IMAGE_TAG=old-tag$' "$STACK_DIR/.env"
assert grep -q 'old daemon binary' "$HOME/.local/bin/multica"
assert grep -q 'systemctl --user start multica-daemon.service' "$STUB_LOG"
assert test "$(grep -c '^compose up$' "$STUB_LOG")" -ge 2
assert grep -q "ps -q:$STACK_DIR" "$STUB_LOG"
dump="$(find "$MULTICA_MAIN_BACKUP_ROOT" -name database.dump -type f -print -quit)"
assert test -s "$dump"

# A daemon-version failure happens after start; rollback must stop that daemon
# before restoring the old binary, then bring the old stack and daemon back.
before_stops="$(grep -c 'systemctl --user stop multica-daemon.service' "$STUB_LOG")"
if FAIL_DAEMON_VERSION=1 run >/dev/null 2>&1; then
  echo "expected daemon version verification failure" >&2; exit 1
fi
assert grep -q '^MULTICA_IMAGE_TAG=old-tag$' "$STACK_DIR/.env"
assert grep -q 'old daemon binary' "$HOME/.local/bin/multica"
assert grep -q 'curl http://127.0.0.1:4802/health' "$STUB_LOG"
assert grep -q 'curl http://127.0.0.1:4802/healthz' "$STUB_LOG"
assert grep -q 'curl http://127.0.0.1:4180/' "$STUB_LOG"
after_stops="$(grep -c 'systemctl --user stop multica-daemon.service' "$STUB_LOG")"
assert test "$after_stops" -gt "$before_stops"

printf 'deploy-main stub tests passed\n'
