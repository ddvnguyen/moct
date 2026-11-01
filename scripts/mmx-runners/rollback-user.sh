#!/usr/bin/env bash
# scripts/mmx-runners/rollback-user.sh — tear down the rootless mmx pool (M-164).
set -euo pipefail

RUNNER_ROOT="/mnt/workspace/clouds/runners/multica-x"
CACHE_DIR="/mnt/workspace/cache/mmx"
UNIT_DIR="$HOME/.config/systemd/user"
IMAGE="${MMX_CI_IMAGE:-localhost/mmx-ci:latest}"

log() { printf '[rollback %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

[ "$(id -u)" -ne 0 ] || { log "must not run as root"; exit 1; }

log "stop + disable units"
for n in 1 2; do
  systemctl --user stop "mmx-runner@${n}.service" 2>/dev/null || true
  systemctl --user disable "mmx-runner@${n}.service" 2>/dev/null || true
  podman rm -f "mmx-runner-${n}" 2>/dev/null || true
done

log "deregister runners via gh"
for rid in $(gh api repos/ddvnguyen/multica-x/actions/runners --jq '.runners[] | select(.name | startswith("mmx-")) | .id' 2>/dev/null || true); do
  gh api -X DELETE "repos/ddvnguyen/multica-x/actions/runners/${rid}" >/dev/null 2>&1 || true
done

log "remove units + drop-in"
rm -f "$UNIT_DIR/mmx-runner@.service"
rm -rf "$UNIT_DIR/dsh-runner-disk-guard.service.d/mmx.conf"
rmdir "$UNIT_DIR/dsh-runner-disk-guard.service.d" 2>/dev/null || true
systemctl --user daemon-reload

log "remove dirs, caches, image (optional)"
read -r -p "Delete ${RUNNER_ROOT} and ${CACHE_DIR}? [y/N] " ans
if [ "${ans}" = "y" ] || [ "${ans}" = "Y" ]; then
  rm -rf "$RUNNER_ROOT" "$CACHE_DIR"
fi
read -r -p "Delete image ${IMAGE}? [y/N] " ans2
if [ "${ans2}" = "y" ] || [ "${ans2}" = "Y" ]; then
  podman rmi "$IMAGE" 2>/dev/null || true
fi

log "unset CI_RUNNER and MMX_CI_ALLOWLIST in repo vars manually to return to hosted-only"
log "done"
