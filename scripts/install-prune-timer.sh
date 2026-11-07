#!/usr/bin/env bash
# Install a systemd user timer that runs prune-workspaces.sh weekly.
#
# The prune script is copied to ~/.local/bin so the timer does not depend on
# a repository checkout staying alive on disk. Re-run this script to refresh
# the copy and units.
#
# Disable with:  systemctl --user disable --now multica-prune-workspaces.timer
# Override the schedule with: MULTICA_PRUNE_ONCALENDAR='Sat *-*-* 04:00:00'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUNE_SRC="$SCRIPT_DIR/prune-workspaces.sh"
BIN_DIR="${HOME}/.local/bin"
UNIT_DIR="${HOME}/.config/systemd/user"
SERVICE=multica-prune-workspaces.service
TIMER=multica-prune-workspaces.timer
ONCALENDAR="${MULTICA_PRUNE_ONCALENDAR:-Sat *-*-* 04:00:00}"

[ -f "$PRUNE_SRC" ] || { echo "prune script not found: $PRUNE_SRC" >&2; exit 1; }
for cmd in install mkdir systemctl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "required command not found: $cmd" >&2; exit 1; }
done

mkdir -p "$BIN_DIR" "$UNIT_DIR"
install -m 755 "$PRUNE_SRC" "$BIN_DIR/multica-prune-workspaces.sh"

cat > "$UNIT_DIR/$SERVICE" <<EOF
[Unit]
Description=Prune completed Multica run directories with a git audit

[Service]
Type=oneshot
ExecStart=$BIN_DIR/multica-prune-workspaces.sh --apply
EOF

cat > "$UNIT_DIR/$TIMER" <<EOF
[Unit]
Description=Run multica-prune-workspaces weekly

[Timer]
OnCalendar=$ONCALENDAR
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER"
echo "installed: $UNIT_DIR/$TIMER (schedule: $ONCALENDAR)"
echo "disable with: systemctl --user disable --now $TIMER"
systemctl --user list-timers "$TIMER" --no-pager
