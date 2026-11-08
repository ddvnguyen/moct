#!/usr/bin/env bash
# Provision / adopt the dedicated PG17 target for the MMX data migration.
#
# The target (M-262) is a fresh pgvector/pgvector:pg17 container bound to
# loopback, holding ONLY the migrated database `multica_mmx`. It never
# touches multica-main (postgres on :5432 inside the multica compose
# project, backend on :3702) nor the lane DB `multica_z` (infra-postgres).
# The container owns its data dir under /mnt/workspace/clouds/dsh-z-pg17/,
# its own role/password in a mode-0600 file, and this script as its
# podman run-script. A systemd user unit is shipped alongside
# (multica-pg17-mmx.service) for reboot survival; see docs/mmx-migrate.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: start-pg17.sh [--dry-run] [--install-unit]

Idempotently starts (or adopts) the MMX PG17 target container.

Environment overrides (defaults shown):
  MULTICA_MMX_WORKSPACE_ROOT=/mnt/workspace
  MULTICA_MMX_PG17_DIR=/mnt/workspace/clouds/dsh-z-pg17
  MULTICA_MMX_PG17_CONTAINER=multica-pg17-mmx
  MULTICA_MMX_PG17_PORT=55434
  MULTICA_MMX_PG17_USER=multica
  MULTICA_MMX_UNIT_DIR=$HOME/.config/systemd/user

--dry-run      print the plan; change nothing
--install-unit render multica-pg17-mmx.service into MULTICA_MMX_UNIT_DIR
               and run daemon-reload (needs systemctl --user)
EOF
}

log() { printf '[mmx-start-pg17 %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

DRY_RUN=0
INSTALL_UNIT=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --install-unit) INSTALL_UNIT=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

WORKSPACE_ROOT="${MULTICA_MMX_WORKSPACE_ROOT:-/mnt/workspace}"
PG17_DIR="${MULTICA_MMX_PG17_DIR:-$WORKSPACE_ROOT/clouds/dsh-z-pg17}"
CONTAINER="${MULTICA_MMX_PG17_CONTAINER:-multica-pg17-mmx}"
PORT="${MULTICA_MMX_PG17_PORT:-55434}"
PG_USER="${MULTICA_MMX_PG17_USER:-multica}"
UNIT_DIR="${MULTICA_MMX_UNIT_DIR:-$HOME/.config/systemd/user}"
IMAGE="pgvector/pgvector:pg17"
TARGET_DB="multica_mmx"
PGPASSWORD_FILE="$PG17_DIR/pgpassword"

# Hard guards: never aim at main or the lane, whatever env the caller passes.
case "$PORT" in 5432|3701|3702|4390|8310) die "refusing to use blocklisted port $PORT (main/lane)" ;; esac
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$PORT > 0 && 10#$PORT <= 65535 )) || die "invalid port: $PORT"
case "$CONTAINER" in multica_postgres_1|infra-postgres|multica_backend_1|multica_frontend_1) die "refusing to use main/lane container name: $CONTAINER" ;; esac
case "$PG17_DIR" in "$WORKSPACE_ROOT"/*) ;; *) die "PG17 dir must be under $WORKSPACE_ROOT: $PG17_DIR" ;; esac
case "$PG17_DIR" in /tmp*|/var/tmp*|/home/*) die "PG17 dir must stay on the workspace disk, not /tmp or home: $PG17_DIR" ;; esac
[[ "$PG_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "invalid PG user: $PG_USER"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for cmd in mkdir chmod date podman ss openssl; do
  command -v "$cmd" >/dev/null 2>&1 || die "required command not found: $cmd"
done
if [ "$INSTALL_UNIT" = 1 ]; then
  command -v systemctl >/dev/null 2>&1 || die "required command not found: systemctl"
  [ -f "$SCRIPT_DIR/multica-pg17-mmx.service" ] || die "unit template missing: $SCRIPT_DIR/multica-pg17-mmx.service"
fi

container_exists() { [ "${PODMAN_CONTAINER_EXISTS:-1}" = "1" ] && podman inspect "$CONTAINER" >/dev/null 2>&1; }
container_running() { [ "$(podman inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null || true)" = "running" ]; }
container_image() { podman inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true; }
# podman may report the image with an explicit docker.io/ registry prefix;
# normalize it so it compares equal to the short IMAGE name.
normalize_image() {
  case "$1" in docker.io/*) printf '%s' "${1#docker.io/}" ;; *) printf '%s' "$1" ;; esac
}

if [ "$DRY_RUN" = 1 ]; then
  printf 'MMX PG17 target plan\n'
  printf '  container:    %s\n' "$CONTAINER"
  printf '  image:        %s\n' "$IMAGE"
  printf '  port:         127.0.0.1:%s (loopback only)\n' "$PORT"
  printf '  pg dir:       %s (data/ + uploads/ + pgpassword 0600)\n' "$PG17_DIR"
  printf '  pg user:      %s\n' "$PG_USER"
  printf '  target db:    %s (created at restore time, not at init)\n' "$TARGET_DB"
  printf '  install unit: %s\n' "$([ "$INSTALL_UNIT" = 1 ] && printf true || printf false)"
  log "dry-run complete; nothing changed"
  exit 0
fi

# Install the systemd user unit first if asked, so a reboot keeps the target.
if [ "$INSTALL_UNIT" = 1 ]; then
  mkdir -p "$UNIT_DIR"
  sed "s|__MMX_MIGRATE_DIR__|$SCRIPT_DIR|g" "$SCRIPT_DIR/multica-pg17-mmx.service" > "$UNIT_DIR/multica-pg17-mmx.service"
  systemctl --user daemon-reload
  log "installed unit: $UNIT_DIR/multica-pg17-mmx.service"
fi

if container_exists; then
  if [ "$(normalize_image "$(container_image)")" != "$(normalize_image "$IMAGE")" ]; then
    die "container $CONTAINER exists but uses image $(container_image | head -c 120) (expected $IMAGE); nothing changed"
  fi
  if ! container_running; then
    podman start "$CONTAINER"
    log "started existing container $CONTAINER"
  fi
else
  # Fresh create. Refuse a foreign listener on the loopback port.
  if ss -tln 2>/dev/null | awk -v p=":$PORT" '{for (i=1;i<=NF;i++) if ($i ~ p"$") found=1} END {exit !found}'; then
    die "port $PORT is already listening (not by $CONTAINER); nothing changed"
  fi
  mkdir -p "$PG17_DIR/data" "$PG17_DIR/uploads"
  chmod 700 "$PG17_DIR/data"
  if [ ! -f "$PGPASSWORD_FILE" ]; then
    openssl rand -hex 24 > "$PGPASSWORD_FILE"
    chmod 600 "$PGPASSWORD_FILE"
  fi
  # POSTGRES_PASSWORD_FILE keeps the secret out of `podman inspect` env.
  podman run -d --name "$CONTAINER" \
    --env "POSTGRES_USER=$PG_USER" \
    --env "POSTGRES_PASSWORD_FILE=/run/secrets/pgpassword" \
    --volume "$PGPASSWORD_FILE:/run/secrets/pgpassword:ro" \
    --volume "$PG17_DIR/data:/var/lib/postgresql/data" \
    --publish "127.0.0.1:$PORT:5432" \
    "$IMAGE"
  log "created container $CONTAINER on 127.0.0.1:$PORT"
fi

ready_ok=0
for _ in $(seq 1 30); do
  if podman exec "$CONTAINER" pg_isready -U "$PG_USER" >/dev/null 2>&1; then ready_ok=1; break; fi
  sleep 2
done
[ "$ready_ok" = 1 ] || die "$CONTAINER did not become ready"

version="$(podman exec "$CONTAINER" psql -U "$PG_USER" -d postgres -tAc 'SHOW server_version;' 2>/dev/null || true)"
case "$version" in 17.*) ;; *) die "$CONTAINER is not PostgreSQL 17 (got: $version)" ;; esac

binding="$(podman inspect "$CONTAINER" --format '{{json .HostConfig.PortBindings}}' 2>/dev/null || true)"
case "$binding" in *'"HostPort":"'"$PORT"'"'*) ;; *) die "$CONTAINER is not published on port $PORT: $binding" ;; esac
case "$binding" in *'"HostIp":"127.0.0.1"'*) ;; *) die "$CONTAINER is not loopback-only: $binding" ;; esac

log "PG17 target ready: container=$CONTAINER version=$version port=127.0.0.1:$PORT dir=$PG17_DIR"
