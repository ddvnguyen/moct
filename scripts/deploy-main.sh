#!/usr/bin/env bash
# Deploy the main Multica stack from an independent host runner.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy-main.sh <image-tag> <expected-commit-sha> <max-drain-seconds> [--force] [--dry-run]

max-drain-seconds 0 (the CI/CD default) does not wait for active tasks: it
cancels them by stopping the daemon and deploys immediately. A positive
value waits that long for tasks to drain; --force stops the daemon and
cancels remaining tasks at the timeout instead of failing.
--dry-run prints the plan.
EOF
}

log() { printf '[deploy-main %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

if [ "$#" -lt 3 ]; then usage >&2; exit 2; fi
IMAGE_TAG="$1"
EXPECTED_COMMIT="$2"
MAX_DRAIN_SECONDS="$3"
shift 3
FORCE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

[[ "$IMAGE_TAG" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid image tag"
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || die "expected commit must be a full 40-character SHA"
[[ "$MAX_DRAIN_SECONDS" =~ ^[0-9]+$ ]] || die "max drain wait must be a non-negative number of seconds (0 = cancel tasks and deploy immediately)"

STACK_DIR="${MULTICA_MAIN_STACK_DIR:-$HOME/.local/share/multica}"
ENV_FILE="$STACK_DIR/.env"
WORKSPACE_ROOT="${MULTICA_MAIN_WORKSPACE_ROOT:-/mnt/workspace}"
CONTAINERS_ROOT="${MULTICA_MAIN_CONTAINERS_ROOT:-/mnt/containers}"
BACKUP_ROOT="${MULTICA_MAIN_BACKUP_ROOT:-$WORKSPACE_ROOT/multica-main-backups}"
PROC_ROOT="${MULTICA_MAIN_PROC_ROOT:-/proc}"
BACKEND_PORT=""
FRONTEND_PORT=""
ENV_TMP=""
MIN_FREE_KB=$((10 * 1024 * 1024))
BACKEND_IMAGE=""
WEB_IMAGE=""
OLD_TAG=""
BACKUP_DIR=""
SWITCH_STARTED=0
ROLLBACK_ACTIVE=0
DAEMON_WAS_STOPPED=0

for cmd in awk cat chmod cp date df grep install jq mkdir mktemp multica mv podman ps rm seq sleep systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done
command -v curl >/dev/null 2>&1 || die "required command not found: curl"

# The deploy runner must be a sibling of the daemon, never one of its tasks.
# Check both process arguments and cgroups so systemd service ancestry is caught
# even when the daemon's executable has a generic process name.
assert_independent_runner() {
  local pid="$PPID" row ppid args cgroup depth=0
  while [ "$pid" -gt 1 ] && [ "$depth" -lt 64 ]; do
    row="$(ps -o ppid=,args= -p "$pid" 2>/dev/null || true)"
    read -r ppid args <<< "$row"
    if [[ "$args" =~ (^|[/[:space:]])multica-daemon([.]service)?([[:space:]]|$) ]] || \
       [[ "$args" =~ multica[[:space:]]+daemon[[:space:]]+(start|run) ]]; then
      die "refusing to deploy from a process descended from multica-daemon (pid $pid)"
    fi
    if [ -r "$PROC_ROOT/$pid/cgroup" ]; then
      cgroup="$(cat "$PROC_ROOT/$pid/cgroup")"
      if [[ "$cgroup" == *multica-daemon.service* ]]; then
        die "refusing to deploy from multica-daemon.service cgroup (pid $pid)"
      fi
    fi
    [[ "$ppid" =~ ^[0-9]+$ ]] || break
    pid="$ppid"
    depth=$((depth + 1))
  done
}
assert_independent_runner

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

[ -d "$STACK_DIR" ] || die "stack directory not found: $STACK_DIR"
[ -f "$ENV_FILE" ] || die "stack environment file not found: $ENV_FILE"
[ -x "$HOME/.local/bin/multica" ] || die "old daemon binary is missing at $HOME/.local/bin/multica"
grep -q '^MULTICA_IMAGE_TAG=' "$ENV_FILE" || die "MULTICA_IMAGE_TAG is missing from $ENV_FILE"
OLD_TAG="$(read_env_value MULTICA_IMAGE_TAG)" || die "could not read current image tag"
[ -n "$OLD_TAG" ] || die "current MULTICA_IMAGE_TAG is empty"
BACKEND_REPO="$(read_env_value MULTICA_BACKEND_IMAGE || true)"
WEB_REPO="$(read_env_value MULTICA_WEB_IMAGE || true)"
BACKEND_REPO="${BACKEND_REPO:-ghcr.io/multica-ai/multica-backend}"
WEB_REPO="${WEB_REPO:-ghcr.io/multica-ai/multica-web}"
BACKEND_IMAGE="$BACKEND_REPO:$IMAGE_TAG"
WEB_IMAGE="$WEB_REPO:$IMAGE_TAG"
BACKEND_PORT="$(read_env_value BACKEND_PORT || true)"
FRONTEND_PORT="$(read_env_value FRONTEND_PORT || true)"
BACKEND_PORT="${BACKEND_PORT:-3702}"
FRONTEND_PORT="${FRONTEND_PORT:-3180}"
valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 > 0 && 10#$1 <= 65535 )); }
valid_port "$BACKEND_PORT" || die "invalid BACKEND_PORT in $ENV_FILE"
valid_port "$FRONTEND_PORT" || die "invalid FRONTEND_PORT in $ENV_FILE"

for path in "$CONTAINERS_ROOT" "$WORKSPACE_ROOT"; do
  [ -d "$path" ] || die "required mount is missing: $path"
  available="$(free_kb "$path")"
  [[ "$available" =~ ^[0-9]+$ ]] || die "could not read free space for $path"
  [ "$available" -ge "$MIN_FREE_KB" ] || die "$path has less than 10 GiB free"
done

for image in "$BACKEND_IMAGE" "$WEB_IMAGE"; do
  podman image exists "$image" || die "staged image is missing: $image"
  image_commit="$(podman image inspect --format '{{ index .Labels "org.opencontainers.image.revision" }}' "$image" 2>/dev/null || true)"
  [ "$image_commit" = "$EXPECTED_COMMIT" ] || die "$image has revision label '$image_commit', expected $EXPECTED_COMMIT"
  image_tag="$(podman image inspect --format '{{ index .Labels "org.opencontainers.image.version" }}' "$image" 2>/dev/null || true)"
  [ "$image_tag" = "$IMAGE_TAG" ] || die "$image has version label '$image_tag', expected $IMAGE_TAG"
done

export TMPDIR="${MULTICA_MAIN_TMPDIR:-$WORKSPACE_ROOT/tmp/multica-main-deploy}"
case "$TMPDIR" in "$WORKSPACE_ROOT"/*) ;; *) die "TMPDIR must be under $WORKSPACE_ROOT" ;; esac
case "$BACKUP_ROOT" in "$WORKSPACE_ROOT"/*) ;; *) die "backup directory must be under $WORKSPACE_ROOT" ;; esac

printf 'Main Multica deployment plan\n'
printf '  image tag:       %s\n' "$IMAGE_TAG"
printf '  expected commit: %s\n' "$EXPECTED_COMMIT"
printf '  current tag:     %s\n' "$OLD_TAG"
printf '  max drain wait:  %ss\n' "$MAX_DRAIN_SECONDS"
printf '  force:           %s\n' "$([ "$FORCE" = 1 ] && printf true || printf false)"
printf '  backend image:   %s\n' "$BACKEND_IMAGE"
printf '  web image:       %s\n' "$WEB_IMAGE"
printf '  backend port:    %s\n' "$BACKEND_PORT"
printf '  frontend port:   %s\n' "$FRONTEND_PORT"
printf '  backups:         %s\n' "$BACKUP_ROOT"
printf '  switch: stop daemon, update .env, podman compose up -d, verify health/migrations/web, install daemon binary, start daemon\n'
printf '  rollback: restore .env and old daemon binary, podman compose up -d, start daemon; database dump is retained, never restored automatically\n'
if [ "$DRY_RUN" = 1 ]; then
  log "dry-run complete; no stack state was changed"
  exit 0
fi

daemon_json="$(multica daemon status --output json)" || die "could not read daemon status"
active_count="$(jq -r '.active_task_count // empty' <<<"$daemon_json")"
[[ "$active_count" =~ ^[0-9]+$ ]] || die "daemon status has no numeric active_task_count"
# max-drain-seconds 0 (the CI/CD default, owner directive 2026-11-04) deploys
# immediately: no wait for active tasks — stopping the daemon below cancels
# them. A positive value waits for tasks to drain first.
if [ "$MAX_DRAIN_SECONDS" -gt 0 ]; then
  deadline=$((SECONDS + MAX_DRAIN_SECONDS))
  while [ "$active_count" -gt 0 ] && [ "$SECONDS" -lt "$deadline" ]; do
    log "waiting for $active_count active task(s) to drain"
    sleep 5
    daemon_json="$(multica daemon status --output json)" || die "could not read daemon status while draining"
    active_count="$(jq -r '.active_task_count // empty' <<<"$daemon_json")"
    [[ "$active_count" =~ ^[0-9]+$ ]] || die "daemon status has no numeric active_task_count"
  done
  if [ "$active_count" -gt 0 ] && [ "$FORCE" != 1 ]; then
    die "drain timed out with $active_count active task(s); no changes made (pass --force to cancel them)"
  fi
fi

mkdir -p "$TMPDIR" "$BACKUP_ROOT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$(mktemp -d "$BACKUP_ROOT/${STAMP}.XXXXXX")"
chmod 700 "$BACKUP_DIR"
cp -p "$ENV_FILE" "$BACKUP_DIR/.env"
cp -p "$HOME/.local/bin/multica" "$BACKUP_DIR/multica"

rollback() {
  local rc=$?
  trap - EXIT
  set +e
  [ -z "$ENV_TMP" ] || rm -f "$ENV_TMP"
  if [ "$SWITCH_STARTED" = 1 ] && [ "$ROLLBACK_ACTIVE" = 0 ]; then
    ROLLBACK_ACTIVE=1
    local rollback_failed=0
    log "deployment failed; rolling back environment and daemon binary"
    systemctl --user stop multica-daemon.service || rollback_failed=1
    cp -p "$BACKUP_DIR/.env" "$ENV_FILE" || rollback_failed=1
    install -m 755 "$BACKUP_DIR/multica" "$HOME/.local/bin/multica" || rollback_failed=1
    (cd "$STACK_DIR" && podman compose up -d) || rollback_failed=1
    systemctl --user start multica-daemon.service || rollback_failed=1
    if [ "$rollback_failed" = 0 ]; then
      log "rollback commands completed; database dump retained at $BACKUP_DIR/database.dump"
    else
      log "ROLLBACK FAILED; inspect the stack; database dump retained at $BACKUP_DIR/database.dump"
    fi
  elif [ "$DAEMON_WAS_STOPPED" = 1 ]; then
    systemctl --user start multica-daemon.service || log "FAILED to restart the daemon after pre-switch abort"
  fi
  exit "$rc"
}
trap rollback EXIT

if [ "$active_count" -gt 0 ]; then
  log "stopping daemon to cancel $active_count remaining task(s); deploy does not wait for task drain"
fi
DAEMON_WAS_STOPPED=1
systemctl --user stop multica-daemon.service
db_container="$(cd "$STACK_DIR" && podman ps -q --filter "label=com.docker.compose.service=postgres" --filter "label=com.docker.compose.project=multica")" || die "could not locate postgres container"
[ -n "$db_container" ] || die "postgres container is not running"
podman exec "$db_container" sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > "$BACKUP_DIR/database.dump" || die "database backup failed"
[ -s "$BACKUP_DIR/database.dump" ] || die "database dump is empty"
chmod 600 "$BACKUP_DIR/.env" "$BACKUP_DIR/multica" "$BACKUP_DIR/database.dump"
log "backup complete: $BACKUP_DIR (database dump will not be restored automatically)"
SWITCH_STARTED=1
ENV_TMP="$ENV_FILE.tmp.$$"
awk -F= -v tag="$IMAGE_TAG" '
  BEGIN {updated=0}
  $1 == "MULTICA_IMAGE_TAG" {print "MULTICA_IMAGE_TAG=" tag; updated++; next}
  {print}
  END {if (updated != 1) exit 2}
' "$ENV_FILE" > "$ENV_TMP" || die "could not update MULTICA_IMAGE_TAG"
chmod --reference="$ENV_FILE" "$ENV_TMP"
mv "$ENV_TMP" "$ENV_FILE"
ENV_TMP=""
(cd "$STACK_DIR" && podman compose up -d)

health_ok=0
for _ in $(seq 1 60); do
  health="$(curl -fsS --max-time 3 "http://127.0.0.1:$BACKEND_PORT/health" 2>/dev/null || true)"
  commit="$(jq -r '.commit // empty' <<<"$health" 2>/dev/null || true)"
  version="$(jq -r '.version // empty' <<<"$health" 2>/dev/null || true)"
  if [ "$commit" = "$EXPECTED_COMMIT" ] && [ "$version" = "$IMAGE_TAG" ]; then health_ok=1; break; fi
  sleep 2
done
[ "$health_ok" = 1 ] || die "/health did not report expected commit and version"

ready_ok=0
for _ in $(seq 1 60); do
  ready="$(curl -fsS --max-time 3 "http://127.0.0.1:$BACKEND_PORT/healthz" 2>/dev/null || true)"
  ready_status="$(jq -r '.status // empty' <<<"$ready" 2>/dev/null || true)"
  migrations="$(jq -r '.checks.migrations // empty' <<<"$ready" 2>/dev/null || true)"
  if [ "$ready_status" = "ok" ] && [ "$migrations" = "ok" ]; then ready_ok=1; break; fi
  sleep 2
done
[ "$ready_ok" = 1 ] || die "/healthz did not report status=ok and checks.migrations=ok"

web_ok=0
# The web UI redirects unauthenticated / to /login (302), so follow redirects
# and require the final response to be 200 -- a bare 200 check fails on every
# deploy even when the stack is healthy.
for _ in $(seq 1 30); do
  if curl -fsSL --max-time 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$FRONTEND_PORT/" | grep -qx 200; then web_ok=1; break; fi
  sleep 2
done
[ "$web_ok" = 1 ] || die "web did not return HTTP 200"

new_binary="$TMPDIR/multica.new"
podman run --rm --network none --entrypoint cat "$BACKEND_IMAGE" /app/multica > "$new_binary"
[ -s "$new_binary" ] || die "new daemon binary extraction produced an empty file"
chmod 755 "$new_binary"
install -m 755 "$new_binary" "$HOME/.local/bin/multica.new"
mv "$HOME/.local/bin/multica.new" "$HOME/.local/bin/multica"
systemctl --user start multica-daemon.service
DAEMON_WAS_STOPPED=0

daemon_ok=0
for _ in $(seq 1 30); do
  daemon_json="$(multica daemon status --output json 2>/dev/null || true)"
  daemon_version="$(jq -r '.cli_version // empty' <<<"$daemon_json" 2>/dev/null || true)"
  if [ "$daemon_version" = "$IMAGE_TAG" ]; then daemon_ok=1; break; fi
  sleep 2
done
[ "$daemon_ok" = 1 ] || die "daemon status did not report version $IMAGE_TAG"

trap - EXIT
log "deployment verified: commit=$EXPECTED_COMMIT version=$IMAGE_TAG; backup=$BACKUP_DIR"
