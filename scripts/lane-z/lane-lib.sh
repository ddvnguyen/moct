#!/usr/bin/env bash
# scripts/lane-z/lane-lib.sh — helpers shared by autodeploy.sh and rollback.sh.
#
# Sourced, not executed. The caller must have sourced dsh-z.env (it uses
# $LANE_ROOT, $MULTICA_BE_Z_UNIT) and must define log().

# The backend unit must follow `multica-be/current`, not a release directory.
# deploy/dsh-z/deploy.sh pins one release path per install, and systemd never
# re-resolves a symlink for a running unit: a switch that only flips `current`
# then restarts the OLD binary, so the lane serves the previous commit while
# `current/release.json` advertises the new one. Pointing WorkingDirectory and
# ExecStart at `current` makes every restart run whatever the symlink names, so
# a switch is just "flip the symlink and restart".
render_backend_unit() { # $1 = release `current` must point at; flips the symlink
  local rel="$1" tmpl out tmp cur="$LANE_ROOT/multica-be/current"
  [ -n "$rel" ] && [ -d "$rel" ] || { log "render_backend_unit: '$rel' is not a release directory"; return 1; }
  ln -sfn "$rel" "$cur"
  tmpl="$SCRIPT_DIR/units/multica-be-z.service"
  [ -f "$tmpl" ] || tmpl="$SCRIPT_DIR/../../deploy/dsh-z/units/multica-be-z.service"
  [ -f "$tmpl" ] || { log "render_backend_unit: no multica-be-z.service template found"; return 1; }
  out="$HOME/.config/systemd/user/$MULTICA_BE_Z_UNIT"
  tmp="$out.tmp.$$"
  mkdir -p "$(dirname "$out")"
  sed -e "s|__RELEASE_DIR__|$cur|g" \
      -e "s|__SERVER_ENV__|$LANE_ROOT/multica-be/env|g" "$tmpl" > "$tmp"
  if grep -q '__[A-Z_]*__' "$tmp"; then
    log "render_backend_unit: unsubstituted placeholder in the rendered unit"
    rm -f "$tmp"
    return 1
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$out"
  systemctl --user daemon-reload
}

unit_release() { # release path the installed backend unit runs, or nothing
  systemctl --user cat "$MULTICA_BE_Z_UNIT" 2>/dev/null \
    | sed -n 's|^ExecStart=\(.*\)/bin/server$|\1|p' | head -1
}

# A release built by CI and one built by deploy/dsh-z/deploy.sh stamp the same
# commit differently: the Makefile uses `git rev-parse --short HEAD` (7 chars),
# deploy.sh uses the full 40. Both identify the same build, so a health check
# accepts either — but never an empty or too-short value, which would match
# anything.
commit_matches() { # $1 = commit the lane reports, $2 = sha it must be
  local got="$1" want="$2"
  [ -n "$got" ] && [ -n "$want" ] || return 1
  [ "$got" = "$want" ] && return 0
  [ "${#got}" -ge 7 ] && [ "${want#"$got"}" != "$want" ]
}

wait_http() { # $1=url $2=timeout $3=expected substring
  local deadline=$((SECONDS + $2)) body
  while [ "$SECONDS" -lt "$deadline" ]; do
    body="$(curl -fsS --max-time 3 "$1" 2>/dev/null || true)"
    if [ -n "$body" ] && { [ -z "${3:-}" ] || printf '%s' "$body" | grep -q "$3"; }; then
      return 0
    fi
    sleep 2
  done
  return 1
}
