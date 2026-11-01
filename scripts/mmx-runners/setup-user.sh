#!/usr/bin/env bash
# scripts/mmx-runners/setup-user.sh — bring up the rootless mmx runner pool (M-164).
#
# Runs as ddv only (no sudo). Registers mmx-1/mmx-2 as systemctl --user units
# that launch each job inside a rootless podman container. Re-run is idempotent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RUNNER_ROOT="/mnt/workspace/clouds/runners/multica-x"
CACHE_DIR="/mnt/workspace/cache/mmx"
BIN_DIR="${RUNNER_ROOT}/bin"
UNIT_DIR="$HOME/.config/systemd/user"
IMAGE="${MMX_CI_IMAGE:-localhost/mmx-ci:latest}"

log() { printf '[setup %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

[ "$(id -u)" -ne 0 ] || die "must not run as root; run as ddv"

# disk/cache env (never /tmp or /home/ddv)
export TMPDIR="/mnt/workspace/tmp/mmx"
export XDG_CACHE_HOME="/mnt/workspace/cache/xdg"
export GOCACHE="/mnt/workspace/cache/go-build"
export GOMODCACHE="/mnt/workspace/cache/go-mod"
export npm_config_cache="/mnt/workspace/cache/npm"
export BUN_INSTALL_CACHE_DIR="/mnt/workspace/cache/bun"
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$GOCACHE" "$GOMODCACHE" "$npm_config_cache" \
  "$BUN_INSTALL_CACHE_DIR" "$CACHE_DIR"/{pnpm-store,turbo,toolcache,scratch}

# verify runner payloads are staged
for n in 1 2; do
  [ -x "${RUNNER_ROOT}/mmx-${n}/config.sh" ] || die "missing runner payload at ${RUNNER_ROOT}/mmx-${n}; stage payload-2.338.0 there first"
done

log "install runner-entry.sh -> ${BIN_DIR}"
mkdir -p "$BIN_DIR"
install -m 0755 "$SCRIPT_DIR/runner-entry.sh" "$BIN_DIR/runner-entry.sh"

log "build image -> ${IMAGE}"
podman build -t "$IMAGE" -f "$REPO_ROOT/docker/mmx-ci.Containerfile" "$REPO_ROOT"

log "units -> ${UNIT_DIR}"
mkdir -p "$UNIT_DIR"
for u in "mmx-runner@.service"; do
  install -m 0600 "$SCRIPT_DIR/units/$u" "$UNIT_DIR/$u"
done

# drop-in to reuse the existing disk guard for mmx units
GUARD_DROPIN_DIR="$UNIT_DIR/dsh-runner-disk-guard.service.d"
mkdir -p "$GUARD_DROPIN_DIR"
install -m 0600 "$SCRIPT_DIR/units/mmx-disk-guard-dropin.conf" "$GUARD_DROPIN_DIR/mmx.conf"

log "prune stale offline mmx-* runners"
for rid in $(gh api repos/ddvnguyen/multica-x/actions/runners --jq '.runners[] | select(.name | startswith("mmx-")) | select(.status=="offline") | .id'); do
  log "  deleting offline runner id=$rid"
  gh api -X DELETE "repos/ddvnguyen/multica-x/actions/runners/${rid}" >/dev/null || true
done

systemctl --user daemon-reload
systemctl --user enable mmx-runner@1.service mmx-runner@2.service
log "enable (not start) done; start with: systemctl --user start mmx-runner@1 mmx-runner@2"
log "status: systemctl --user status mmx-runner@1 mmx-runner@2"
