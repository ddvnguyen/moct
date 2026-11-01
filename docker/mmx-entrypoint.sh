#!/bin/sh
set -eu

# mmx-ci container entrypoint (M-164).
# Runs as container root (uid 0 in the userns). Installs the egress filter
# inside this container's own network namespace, then drops to the capless job
# uid (1000 = host ddv via --userns=keep-id) before exec'ing the runner so
# job steps cannot remove the filter or reach a container engine.

# 1. Install the in-netns egress filter. Requires --cap-add=NET_ADMIN.
if command -v nft >/dev/null 2>&1 && [ -f /etc/mmx-nft.rules ]; then
  nft -f /etc/mmx-nft.rules
fi

INSTANCE_DIR="${INSTANCE_DIR:-/mnt/workspace/clouds/runners/multica-x/mmx-1}"
RUNNER_NAME="${RUNNER_NAME:-mmx-1}"
RUNNER_URL="${RUNNER_URL:-https://github.com/ddvnguyen/multica-x}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,mmx}"
RUNNER_TOKEN="${RUNNER_TOKEN:-}"

# 2. Drop privileges and run the GitHub Actions runner (config + run).
exec setpriv --reuid 1000 --regid 1000 --keep-groups \
  --no-new-privs --bounding-set=-all --inh-caps=-all \
  /bin/sh -c '
    set -eu
    cd "$INSTANCE_DIR"
    if [ -f .runner ] && [ -n "$RUNNER_TOKEN" ]; then
      RUNNER_TOKEN="$RUNNER_TOKEN" ./config.sh remove --token "$RUNNER_TOKEN" >/dev/null 2>&1 || true
      rm -f .runner .credentials .credentials_rsaparams
    fi
    if [ -n "$RUNNER_TOKEN" ]; then
      RUNNER_TOKEN="$RUNNER_TOKEN" ./config.sh --ephemeral --unattended --replace \
        --url "$RUNNER_URL" --token "$RUNNER_TOKEN" \
        --labels "$RUNNER_LABELS" --name "$RUNNER_NAME"
    fi
    # scrub registration token from the job environment
    unset RUNNER_TOKEN
    RUNNER_MANUALLY_TRAP_SIG=1 exec ./run.sh
  '
