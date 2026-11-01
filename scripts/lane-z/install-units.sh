#!/usr/bin/env bash
# scripts/lane-z/install-units.sh — install the lane z auto-deploy on this host.
#
# Idempotent: copies the scripts to a stable directory (a task checkout is
# disposable, a timer is not), renders the user units, creates the Multica CLI
# config the evidence comment uses, then enables the timer. Re-run it after
# changing anything under scripts/lane-z/.
#
# No sudo: everything is a systemd USER unit plus files under /mnt/workspace.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../../deploy/dsh-z/dsh-z.env
. "$REPO_ROOT/deploy/dsh-z/dsh-z.env"

log() { printf '[install %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

UNIT_DIR="$HOME/.config/systemd/user"

log "scripts -> $AUTODEPLOY_BIN_DIR"
mkdir -p "$AUTODEPLOY_BIN_DIR" "$AUTODEPLOY_LOG_DIR" "$AUTODEPLOY_BACKUP_DIR" \
  "$LANE_ROOT/data" /mnt/workspace/tmp/dsh-z-autodeploy /mnt/workspace/cache/xdg
install -m 0755 "$SCRIPT_DIR/autodeploy.sh" "$SCRIPT_DIR/rollback.sh" "$SCRIPT_DIR/lane-lib.sh" \
  "$AUTODEPLOY_BIN_DIR/"
# The backend unit template travels with the scripts: a switch re-renders it
# from here, so the timer never depends on a task checkout.
install -d "$AUTODEPLOY_BIN_DIR/units"
install -m 0644 "$REPO_ROOT/deploy/dsh-z/units/multica-be-z.service" "$AUTODEPLOY_BIN_DIR/units/"
# The timer must not source anything out of a task checkout: the installed copy
# carries the lane config with it.
install -m 0644 "$REPO_ROOT/deploy/dsh-z/dsh-z.env" "$AUTODEPLOY_BIN_DIR/dsh-z.env"

log "units -> $UNIT_DIR"
mkdir -p "$UNIT_DIR"
for u in dsh-z-autodeploy.service dsh-z-autodeploy.timer; do
  sed "s|__BIN_DIR__|$AUTODEPLOY_BIN_DIR|g" "$SCRIPT_DIR/units/$u" > "$UNIT_DIR/.$u.tmp"
  grep -q '__[A-Z_]*__' "$UNIT_DIR/.$u.tmp" && die "unsubstituted placeholder in $u"
  mv "$UNIT_DIR/.$u.tmp" "$UNIT_DIR/$u"
  chmod 600 "$UNIT_DIR/$u"
done

# Evidence delivery: the tick writes latest.md and calls the reporter
# autopilot's webhook. There is no Multica CLI config on this host on purpose —
# its token is the Owner's, and evidence comments must carry an agent identity.
# The URL is a credential, so it is provisioned by hand and only checked here.
if [ ! -s "$AUTODEPLOY_WEBHOOK_FILE" ]; then
  die "no reporter webhook at $AUTODEPLOY_WEBHOOK_FILE; write the autopilot's webhook URL there (chmod 600) first"
fi
if [ "$(stat -c %a "$AUTODEPLOY_WEBHOOK_FILE")" != "600" ]; then
  die "$AUTODEPLOY_WEBHOOK_FILE must be mode 0600"
fi
mkdir -p "$AUTODEPLOY_REPORT_DIR"
log "reporter webhook present; evidence will go to $AUTODEPLOY_REPORT_DIR/latest.md"

systemctl --user daemon-reload
systemctl --user enable --now dsh-z-autodeploy.timer
log "timer enabled:"
systemctl --user list-timers dsh-z-autodeploy.timer --no-pager || true
log "next: bash $AUTODEPLOY_BIN_DIR/autodeploy.sh --dry-run"
