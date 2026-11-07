#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d "$REPO_ROOT/.autodeploy-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

LANE_ROOT="$SANDBOX/lane"
PROC_ROOT="$SANDBOX/proc"
mkdir -p "$LANE_ROOT/multica-be/releases" "$PROC_ROOT/4242"
export LANE_ROOT MULTICA_LANE_PROC_ROOT="$PROC_ROOT"
export AUTODEPLOY_KEEP_RELEASES=1
export MULTICA_DAEMON_Z_UNIT=multica-daemon-z.service

for release in old middle current; do
  mkdir -p "$LANE_ROOT/multica-be/releases/$release/bin"
  printf 'binary %s\n' "$release" > "$LANE_ROOT/multica-be/releases/$release/bin/multica"
done
touch -t 202611061000 "$LANE_ROOT/multica-be/releases/old"
touch -t 202611061100 "$LANE_ROOT/multica-be/releases/middle"
touch -t 202611061200 "$LANE_ROOT/multica-be/releases/current"
ln -s "$LANE_ROOT/multica-be/releases/current" "$LANE_ROOT/multica-be/current"

# Model /proc/<pid>/exe after its release was unlinked. Linux appends this
# marker to readlink output; the proc link itself still refers to the open file.
printf 'open deleted executable\n' > "$LANE_ROOT/multica-be/releases/old/bin/multica (deleted)"
ln -s "$LANE_ROOT/multica-be/releases/old/bin/multica (deleted)" "$PROC_ROOT/4242/exe"

BIN_DIR="$SANDBOX/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"show --property=MainPID --value multica-daemon-z.service"* ]]; then
  printf '4242\n'
else
  printf 'unexpected systemctl call: %s\n' "$*" >&2
  exit 2
fi
EOF
chmod 755 "$BIN_DIR/systemctl"
export PATH="$BIN_DIR:$PATH"

log() { :; }
# shellcheck source=./lane-lib.sh
. "$REPO_ROOT/scripts/lane-z/lane-lib.sh"
prune_releases

test -d "$LANE_ROOT/multica-be/releases/old"
test ! -e "$LANE_ROOT/multica-be/releases/middle"
test -d "$LANE_ROOT/multica-be/releases/current"
printf 'autodeploy release pruning tests passed\n'
