#!/usr/bin/env bash
# Host-side entrypoint for one mmx runner instance (M-164).
# Invoked by ~/.config/systemd/user/mmx-runner@.service with the instance id.
# Runs as ddv (no sudo). Each loop iteration registers an ephemeral runner,
# runs one job inside a rootless podman container, then wipes the work dir.
set -euo pipefail

INSTANCE="${1:?instance id required}"
INSTANCE_DIR="/mnt/workspace/clouds/runners/multica-x/mmx-${INSTANCE}"
RUNNER_NAME="mmx-${INSTANCE}"
RUNNER_URL="https://github.com/ddvnguyen/multica-x"
RUNNER_LABELS="self-hosted,linux,mmx"
CACHE_DIR="/mnt/workspace/cache/mmx"
IMAGE="${MMX_CI_IMAGE:-localhost/mmx-ci:latest}"
CANARY_PORT="${MMX_CANARY_PORT:-39180}"

# disk/cache env (never /tmp or /home/ddv)
export TMPDIR="/mnt/workspace/tmp/mmx"
export XDG_CACHE_HOME="/mnt/workspace/cache/xdg"
export GOCACHE="/mnt/workspace/cache/go-build"
export GOMODCACHE="/mnt/workspace/cache/go-mod"
export npm_config_cache="/mnt/workspace/cache/npm"
export BUN_INSTALL_CACHE_DIR="/mnt/workspace/cache/bun"
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$GOCACHE" "$GOMODCACHE" "$npm_config_cache" \
  "$BUN_INSTALL_CACHE_DIR" "$CACHE_DIR"/{pnpm-store,turbo,toolcache,scratch}

# canary listener on 0.0.0.0 for the lifetime of this unit (host side, so the
# container can probe the gateway). Bound to 0.0.0.0 so pasta reaches it.
python3 - "$CANARY_PORT" <<'PY' &
import http.server, socketserver, sys
port = int(sys.argv[1])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'canary')
    def log_message(self, *a):
        pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("0.0.0.0", port), H) as httpd:
    httpd.serve_forever()
PY
CANARY_PID=$!
trap 'kill "$CANARY_PID" 2>/dev/null || true' EXIT INT TERM

while :; do
  # fetch a short-lived registration token (never printed/stored on disk)
  TOKEN="$(gh api -X POST "repos/ddvnguyen/multica-x/actions/runners/registration-token" --jq .token)"

  rm -rf "${INSTANCE_DIR}/_work"
  mkdir -p "${INSTANCE_DIR}/_work"

  set +e
  podman run --rm --name "mmx-runner-${INSTANCE}" --replace \
    --userns=keep-id --cap-add=NET_ADMIN \
    --memory=12g --pids-limit=4096 --cpus=6 \
    -e "INSTANCE_DIR=${INSTANCE_DIR}" \
    -e "RUNNER_NAME=${RUNNER_NAME}" \
    -e "RUNNER_URL=${RUNNER_URL}" \
    -e "RUNNER_LABELS=${RUNNER_LABELS}" \
    -e "RUNNER_TOKEN=${TOKEN}" \
    -e "CANARY_PORT=${CANARY_PORT}" \
    -e "TMPDIR=/mnt/workspace/tmp/mmx" \
    -e "XDG_CACHE_HOME=/mnt/workspace/cache/xdg" \
    -v "${INSTANCE_DIR}:${INSTANCE_DIR}" \
    -v "${CACHE_DIR}:${CACHE_DIR}" \
    "$IMAGE"
  RC=$?
  set -e

  # post-job wipe: work dir + per-run scratch
  rm -rf "${INSTANCE_DIR}/_work"
  rm -rf "${CACHE_DIR}/scratch"/* 2>/dev/null || true
  mkdir -p "${INSTANCE_DIR}/_work" "${CACHE_DIR}/scratch"

  sleep 5
done
