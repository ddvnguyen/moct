#!/usr/bin/env bash
# scripts/lane-z/autodeploy.sh — pull-based CD for lane z (M-151).
#
# The host pulls; CI never reaches the lane. dsh-z-autodeploy.timer runs this
# every 60 s as `ddv`. It asks GitHub for the newest SUCCESSFUL push run of CI
# on multica-moct, compares that head SHA with the release lane z is actually
# running (`multica-be/current/release.json`), and — only when they differ —
# downloads that run's artifacts, backs the database up, installs the release,
# migrates, switches, health-checks, and comments the evidence on the merged
# PR's card.
#
# No rebuild: every artifact comes from CI. A missing or mismatched artifact is
# a red report, never a local build.
#
# Invariants this script holds:
#   * one deploy at a time (flock); a tick that loses the lock exits 0 quietly
#   * newest SHA wins: the newest successful run is re-read after download, so
#     a superseded SHA is dropped instead of deployed
#   * a SHA that already failed is not retried every minute (data/autodeploy.failed)
#   * rollback switches binaries only — it NEVER restores the database. A
#     pg_restore over a live DB silently loses every write since the dump; the
#     dump path goes in the red report for a human to decide.
#   * the plugin bundle (and therefore dsh-z.service) is only touched when the
#     bundle content actually changed
#
# Usage:
#   autodeploy.sh                one tick (this is what the timer runs)
#   autodeploy.sh --dry-run      print what a tick would do; changes nothing
#   autodeploy.sh --sha <sha>    deploy a specific commit (still needs a green
#                                push run and its artifacts)
#   autodeploy.sh --drill-fail-health
#                                rollback drill: run a real deploy and force the
#                                post-switch health assertion to fail, so the
#                                rollback path and the red report are exercised.
#                                Posts nothing; prints the report it would send.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The timer runs the installed copy under AUTODEPLOY_BIN_DIR, where
# install-units.sh also drops dsh-z.env; a repo checkout keeps the same file two
# levels up. Sourcing the copy means the host never depends on a task checkout
# that disappears.
ENV_FILE="$SCRIPT_DIR/dsh-z.env"
[ -f "$ENV_FILE" ] || ENV_FILE="$SCRIPT_DIR/../../deploy/dsh-z/dsh-z.env"
# shellcheck source=/dev/null
. "$ENV_FILE"
# shellcheck source=./lane-lib.sh
. "$SCRIPT_DIR/lane-lib.sh"

log() { printf '[autodeploy %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# Every failure goes through fail(): it records why and returns non-zero so the
# ERR trap runs the rollback and the red report. A bare `exit 1` skips the trap
# and leaves a half-switched lane with nobody told.
fail() { # $1 = reason
  FAIL_REASON="$1"
  log "FAILED: $1"
  return 1
}

DRY_RUN=0
DRILL_FAIL_HEALTH=0
FORCE_SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --drill-fail-health) DRILL_FAIL_HEALTH=1 ;;
    --sha) shift; FORCE_SHA="${1:-}" ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$AUTODEPLOY_LOG_DIR" "$AUTODEPLOY_BACKUP_DIR" "$LANE_ROOT/artifacts" "$LANE_ROOT/data"
LOG_FILE="$AUTODEPLOY_LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ).log"
# Everything this run says also lands in its own log file, so the evidence
# comment can point at one path instead of pasting journal output.
exec > >(tee -a "$LOG_FILE") 2>&1

SHA=""
RUN_ID=""
LANE_COMMIT=""
REPORT_FAILED=0
SWITCHED=0
FAILED=0
FAIL_REASON=""
PREV_REL=""

on_error() { # $1 = line
  local rc=$?
  trap - ERR
  set +e
  FAILED=1
  FAIL_REASON="${FAIL_REASON:-command failed (rc=$rc) at line $1}"
  log "FAILED in step '$STEP': $FAIL_REASON"
  if [ "$SWITCHED" = 1 ]; then
    log "rolling back to the previous release"
    bash "$SCRIPT_DIR/rollback.sh" || log "ROLLBACK FAILED — lane z may be on the broken release"
  else
    log "nothing was switched; lane z still runs ${PREV_REL:-the previous release}"
  fi
  # report() prints instead of posting during a drill, so the red body is
  # always visible — the drill exists to prove exactly that text.
  report red
  log "log: $LOG_FILE"
  exit 1
}
trap 'on_error $LINENO' ERR

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

free_gb() { df -BG --output=avail /mnt/workspace | tail -1 | tr -dc '0-9'; }

# Every stage announces itself and clears the failure reason, so a red report
# names the step that actually broke instead of a stale one.
step() {
  STEP="$1"
  FAIL_REASON=""
  log "step: $1"
}

release_sha() { # sha of the release lane z currently runs
  local f="$LANE_ROOT/multica-be/current/release.json"
  [ -f "$f" ] || { printf 'none'; return; }
  jq -r '.sha // "none"' "$f"
}

release_version() {
  jq -r '.version // "unknown"' "$LANE_ROOT/multica-be/current/release.json" 2>/dev/null || printf 'unknown'
}

newest_green() { # newest successful push run of CI on the branch, as JSON
  gh run list --repo "$AUTODEPLOY_REPO" --workflow "$AUTODEPLOY_WORKFLOW" \
    --branch "$AUTODEPLOY_BRANCH" --event push --status success --limit 1 \
    --json headSha,databaseId,createdAt,updatedAt,url
}

run_for_sha() { # $1 = sha; run id of the successful push run for that sha
  gh run list --repo "$AUTODEPLOY_REPO" --workflow "$AUTODEPLOY_WORKFLOW" \
    --branch "$AUTODEPLOY_BRANCH" --event push --status success --limit 50 \
    --json headSha,databaseId \
    | jq -r --arg sha "$1" '[.[] | select(.headSha == $sha)][0].databaseId // empty'
}

assert_health() { # $1 = sha the lane must report
  local sha="$1" commit
  if [ "$DRILL_FAIL_HEALTH" = 1 ]; then
    log "drill: forcing the post-switch health assertion to fail"
    return 1
  fi
  wait_http "http://127.0.0.1:$MULTICA_BE_Z_PORT/healthz" 120 '"status":"ok"' \
    || { log "multica-be z /healthz did not answer ok"; return 1; }
  # The lane web binds LANE_WEB_HOST (10.88.0.1, podman bridge), not loopback.
  web="http://${LANE_WEB_HOST:-127.0.0.1}:3180"
  wait_http "$web/multica/healthz" 60 '' \
    || { log "lane web /multica/healthz did not answer"; return 1; }
  wait_http "$web/moct/status" 60 '' \
    || { log "lane web /moct/status did not answer"; return 1; }
  commit="$(curl -fsS --max-time 5 "$web/multica/health" | jq -r '.commit // empty')" \
    || { log "lane web /multica/health did not answer"; return 1; }
  commit_matches "$commit" "$sha" \
    || { log "/multica/health reports commit '$commit', expected '$sha'"; return 1; }
  # CI-built releases answer with the short sha; the report quotes what the lane
  # actually said, not what we expected it to say.
  LANE_COMMIT="$commit"
  log "health ok: /multica/health commit=$commit"
}

bundle_hash() { # content hash of a plugin bundle, node_modules included
  [ -d "$1" ] || { printf 'missing'; return; }
  [ -n "$(find "$1" -type f -print -quit)" ] || { printf 'empty'; return; }
  ( cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 )
}

resolve_card() { # $1 = sha; prints the issue identifier of the merged PR's card
  local sha="$1" pr ident
  pr="$(gh api "repos/$AUTODEPLOY_REPO/commits/$sha/pulls" 2>/dev/null || printf '[]')"
  # The PR title is the convention ("... (M-169)"); the body is the fallback.
  ident="$(printf '%s' "$pr" | jq -r '[.[0].title // "", .[0].body // ""] | join("\n")' 2>/dev/null \
    | grep -oE 'M-[0-9]+' | head -1 || true)"
  [ -n "$ident" ] || return 1
  printf '%s' "$ident"
}

# ---------------------------------------------------------------------------
# Evidence: latest.md plus the reporter autopilot's webhook
# ---------------------------------------------------------------------------
# This host holds the Owner's CLI token, so a comment posted from here would
# carry the Owner's name. It must not: evidence comments are posted by the
# "lane-z deploy reporter" autopilot under its own agent identity (Architect,
# 2026-10-30). The tick writes latest.md and pokes that autopilot's webhook;
# the URL is a credential, so it lives in a 0600 file — never in the repo, the
# log, or a comment. A webhook that cannot be reached leaves the evidence on
# disk and turns the tick red.

CARD=""

write_report() { # $1 = body file; sets CARD
  local body="$1" out="$AUTODEPLOY_REPORT_DIR/latest.md" tmp
  CARD="$(resolve_card "$SHA" || true)"
  [ -n "$CARD" ] || log "no merged PR with an M-NNN reference for $SHA; latest.md names no card"
  mkdir -p "$AUTODEPLOY_REPORT_DIR"
  tmp="$out.tmp.$$"
  {
    printf 'card: %s\n' "$CARD"
    printf 'sha: %s\n' "$SHA"
    printf 'generated: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf -- '---\n'
    cat "$body"
  } > "$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$out"
  log "evidence written to $out (card ${CARD:-none})"
}

notify_reporter() { # no args; uses CARD. Non-zero means the evidence was not delivered.
  local url attempt=1
  if [ -z "$CARD" ]; then
    log "no card to notify; the evidence stays at $AUTODEPLOY_REPORT_DIR/latest.md"
    return 0
  fi
  if [ ! -s "$AUTODEPLOY_WEBHOOK_FILE" ]; then
    log "no reporter webhook at $AUTODEPLOY_WEBHOOK_FILE; evidence stays at $AUTODEPLOY_REPORT_DIR/latest.md"
    return 1
  fi
  url="$(tr -d '\r\n' < "$AUTODEPLOY_WEBHOOK_FILE")"
  while :; do
    if curl -fsS --max-time 15 -X POST -H 'Content-Type: application/json' \
         -H "Idempotency-Key: autodeploy-${SHA:0:9}-$RUN_ID" \
         -d "{\"card\":\"$CARD\",\"sha\":\"$SHA\"}" "$url" >/dev/null; then
      log "reporter autopilot notified for $CARD"
      return 0
    fi
    if [ "$attempt" -ge 3 ]; then
      log "reporter webhook failed after 3 attempts; evidence stays at $AUTODEPLOY_REPORT_DIR/latest.md"
      return 1
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
}

report() { # $1 = green|red
  # A dry run is not a deploy: it must never leave evidence behind.
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  local kind="$1" body="$LANE_ROOT/data/autodeploy-comment.md" dur applied plugin_note
  dur=$(( $(date +%s) - STARTED ))
  applied="$( [ -s "$LANE_ROOT/data/autodeploy-migrations.applied" ] && paste -sd', ' "$LANE_ROOT/data/autodeploy-migrations.applied" || true )"
  [ -n "$applied" ] || applied="none"
  plugin_note="$(cat "$LANE_ROOT/data/autodeploy-plugin.note" 2>/dev/null || printf 'unchanged')"

  if [ "$kind" = green ]; then
    {
      printf '**[autodeploy]** lane z is on `%s`\n\n' "${SHA:0:9}"
      printf -- '- version: `%s` (built %s)\n' "$(release_version)" "${BUILT_AT:-unknown}"
      printf -- '- CI: [run %s](%s), build %s\n' "$RUN_ID" "${RUN_URL:-n/a}" "${BUILD_TIME:-unknown}"
      printf -- '- migrations applied: %s\n' "$applied"
      printf -- '- health: `/multica/health` commit `%s`, `/multica/healthz` ok, `/moct/status` ok\n' "${LANE_COMMIT:-$SHA}"
      printf -- '- plugin: %s\n' "$plugin_note"
      printf -- '- DB backup: `%s` (never auto-restored)\n' "${DUMP:-none taken}"
      printf -- '- disk: `/mnt/workspace` %sG free before, %sG after\n' "$DF_BEFORE" "$(free_gb)"
      printf -- '- deploy took %ss\n' "$dur"
    } > "$body"
  else
    {
      printf '**[autodeploy]** lane z deploy of `%s` FAILED — rolled back to `%s`\n\n' "${SHA:0:9}" "$(release_sha)"
      printf -- '- failed in step: `%s` — %s\n' "$STEP" "$FAIL_REASON"
      printf -- '- CI: [run %s](%s)\n' "$RUN_ID" "${RUN_URL:-n/a}"
      printf -- '- migrations applied before the failure: %s\n' "$applied"
      printf -- '- DB dump (for a human; NOT restored automatically): `%s`\n' "${DUMP:-none taken}"
      printf -- '- log: `%s`\n' "$LOG_FILE"
    } > "$body"
  fi

  if [ "$DRILL_FAIL_HEALTH" = 1 ]; then
    log "drill: report not delivered. Body follows:"
    sed 's/^/  | /' "$body"
    return 0
  fi
  write_report "$body"
  rm -f "$body"
  # A failed notification never fails the deploy: report() must not hand a
  # healthy lane to the ERR trap and roll it back. It only marks the tick red.
  notify_reporter || REPORT_FAILED=1
  return 0
}

prune_backups() {
  find "$AUTODEPLOY_BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'multica_z-pre-*.dump' -o -name 'multica_z-pre-*-migrations-*.txt' \) \
    -mtime +"$AUTODEPLOY_BACKUP_KEEP_DAYS" -print -delete 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Lock + guards
# ---------------------------------------------------------------------------

exec 9>"$LANE_ROOT/data/autodeploy.lock"
if ! flock -n 9; then
  log "another deploy holds the lock; skipping this tick"
  exit 0
fi

STARTED=$(date +%s)
DF_BEFORE=$(free_gb)
log "start: lane z on $(release_sha) ($(release_version)), /mnt/workspace ${DF_BEFORE}G free"

step "resolve-target"
if [ -n "$FORCE_SHA" ]; then
  SHA="$FORCE_SHA"
  RUN_ID="$(run_for_sha "$SHA")"
  [ -n "$RUN_ID" ] || fail "no successful push run of $AUTODEPLOY_WORKFLOW on $AUTODEPLOY_BRANCH for $SHA"
  RUN_JSON="$(gh run view "$RUN_ID" --repo "$AUTODEPLOY_REPO" --json headSha,url,createdAt,updatedAt,conclusion)"
else
  # newest_green returns a one-element list; normalise it to the same object
  # shape `gh run view` gives, so everything below reads one shape.
  RUN_JSON="$(newest_green | jq '.[0] // empty')"
  SHA="$(printf '%s' "$RUN_JSON" | jq -r '.headSha // empty')"
  [ -n "$SHA" ] || { log "no successful push run found on $AUTODEPLOY_BRANCH"; exit 0; }
  RUN_ID="$(printf '%s' "$RUN_JSON" | jq -r '.databaseId // empty')"
fi
RUN_URL="$(printf '%s' "$RUN_JSON" | jq -r '.url // empty')"
RUN_STARTED="$(printf '%s' "$RUN_JSON" | jq -r '.createdAt // empty')"
RUN_ENDED="$(printf '%s' "$RUN_JSON" | jq -r '.updatedAt // empty')"
if [ -n "$RUN_STARTED" ] && [ -n "$RUN_ENDED" ]; then
  BUILD_TIME="$(( ( $(date -d "$RUN_ENDED" +%s) - $(date -d "$RUN_STARTED" +%s) ) / 60 ))m$(( ( $(date -d "$RUN_ENDED" +%s) - $(date -d "$RUN_STARTED" +%s) ) % 60 ))s"
else
  BUILD_TIME="unknown"
fi

if [ "$DRY_RUN" = 1 ] && [ "$(release_sha)" = "$SHA" ]; then
  log "dry-run: lane z already runs ${SHA:0:9} (run $RUN_ID); a real tick exits here"
  exit 0
fi

if [ "$(release_sha)" = "$SHA" ]; then
  log "lane z already runs $SHA; nothing to do"
  exit 0
fi

if [ -f "$LANE_ROOT/data/autodeploy.failed" ] && [ "$(cat "$LANE_ROOT/data/autodeploy.failed")" = "$SHA" ]; then
  log "$SHA already failed on this host; not retrying (rm $LANE_ROOT/data/autodeploy.failed to allow it)"
  exit 0
fi

ART="$LANE_ROOT/artifacts/$SHA"
if [ "$DRY_RUN" = 1 ]; then
  log "dry-run: newest green run on $AUTODEPLOY_BRANCH is ${SHA:0:9} (run $RUN_ID, $RUN_URL)"
  log "dry-run: lane z runs $(release_sha) ($(release_version))"
  log "dry-run: artifacts in run $RUN_ID:"
  gh api "repos/$AUTODEPLOY_REPO/actions/runs/$RUN_ID/artifacts" \
    --jq '.artifacts[] | "  - \(.name) \(.size_in_bytes / 1048576 | floor) MB"' 2>/dev/null || log "  (artifact list unavailable)"
  log "dry-run: would download to $ART, back up the DB to $AUTODEPLOY_BACKUP_DIR, install releases/${SHA:0:9}, migrate, switch current, restart $MULTICA_BE_Z_UNIT,"
  log "dry-run: would sync the plugin bundle and restart $DSH_Z_WEB_UNIT only if its content changed, then assert health and comment on $(resolve_card "$SHA" || printf 'no card')"
  log "dry-run: disk ${DF_BEFORE}G free (refuse below ${AUTODEPLOY_MIN_FREE_GB}G), keeping $AUTODEPLOY_KEEP_RELEASES releases"
  exit 0
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

step "disk-guard"
if [ "$DF_BEFORE" -lt "$AUTODEPLOY_MIN_FREE_GB" ]; then
  fail "/mnt/workspace has ${DF_BEFORE}G free, below the ${AUTODEPLOY_MIN_FREE_GB}G floor; refusing to download"
fi

step "download"
PREV_REL="$(readlink -f "$LANE_ROOT/multica-be/current" 2>/dev/null || true)"
rm -rf "$ART"; mkdir -p "$ART/multica-be" "$ART/web-dist"
log "downloading multica-be-$SHA"
gh run download "$RUN_ID" --repo "$AUTODEPLOY_REPO" -n "multica-be-$SHA" -D "$ART/multica-be"
log "downloading web-dist-$SHA"
gh run download "$RUN_ID" --repo "$AUTODEPLOY_REPO" -n "web-dist-$SHA" -D "$ART/web-dist"
# The plugin bundle is optional: a push that touches nothing under packages/
# never runs the frontend job, and then the lane's current bundle is correct.
PLUGIN_PRESENT=0
if gh run download "$RUN_ID" --repo "$AUTODEPLOY_REPO" -n "dsh-plugin-$SHA" -D "$ART/dsh-plugin" 2>/dev/null; then
  PLUGIN_PRESENT=1
fi

step "verify-artifact"
[ -x "$ART/multica-be/bin/server" ] || fail "multica-be artifact has no bin/server"
[ -d "$ART/multica-be/migrations" ] || fail "multica-be artifact has no migrations/"
ART_SHA="$(jq -r '.sha // empty' "$ART/multica-be/release.json")"
[ "$ART_SHA" = "$SHA" ] || fail "artifact release.json sha '$ART_SHA' != run sha '$SHA'"
BUILT_AT="$(jq -r '.builtAt // "unknown"' "$ART/multica-be/release.json")"
log "artifact verified: sha $SHA, built $BUILT_AT"

step "supersede-check"
if [ -z "$FORCE_SHA" ]; then
  NOW_NEWEST="$(newest_green | jq -r '.[0].headSha // empty')"
  if [ "$NOW_NEWEST" != "$SHA" ]; then
    log "a newer green SHA ($NOW_NEWEST) landed while downloading; dropping $SHA for the next tick"
    rm -rf "$ART"
    exit 0
  fi
fi

step "backup"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$AUTODEPLOY_BACKUP_DIR/multica_z-pre-${SHA:0:9}-$TS.dump"
MIG_LIST_PRE="$AUTODEPLOY_BACKUP_DIR/multica_z-pre-${SHA:0:9}-migrations-$TS.txt"
log "dumping $MULTICA_Z_DB_NAME to $DUMP"
podman exec "$MULTICA_Z_DB_CONTAINER" pg_dump -U hydra -Fc "$MULTICA_Z_DB_NAME" > "$DUMP"
[ -s "$DUMP" ] || fail "pg_dump produced an empty file"
podman exec "$MULTICA_Z_DB_CONTAINER" psql -U hydra -d "$MULTICA_Z_DB_NAME" -tAc \
  'select version from schema_migrations order by version' | sed '/^$/d' | sort > "$MIG_LIST_PRE"
log "backup ok: $(du -h "$DUMP" | cut -f1), $(wc -l < "$MIG_LIST_PRE") migrations recorded"

step "install-release"
REL="$LANE_ROOT/multica-be/releases/$SHA"
rm -rf "$REL"; mkdir -p "$REL"
cp -a "$ART/multica-be/." "$REL/"
: > "$REL/.complete"
printf '%s\n' "$PREV_REL" > "$LANE_ROOT/multica-be/previous-release"
log "release installed at $REL"

step "migrate"
# shellcheck source=/dev/null
if [ -f "$LANE_RUNTIME_ENV" ]; then . "$LANE_RUNTIME_ENV"; fi
[ -n "${MULTICA_Z_DB_PASSWORD:-}" ] || fail "no MULTICA_Z_DB_PASSWORD in $LANE_RUNTIME_ENV"
DSN="${MULTICA_Z_DSN_TEMPLATE/PASSWORD/$MULTICA_Z_DB_PASSWORD}"
( cd "$REL" && DATABASE_URL="$DSN" "$REL/bin/migrate" up )
podman exec "$MULTICA_Z_DB_CONTAINER" psql -U hydra -d "$MULTICA_Z_DB_NAME" -tAc \
  'select version from schema_migrations order by version' | sed '/^$/d' | sort > "$LANE_ROOT/data/autodeploy-migrations.post"
comm -13 "$MIG_LIST_PRE" "$LANE_ROOT/data/autodeploy-migrations.post" > "$LANE_ROOT/data/autodeploy-migrations.applied" || true
log "migrations applied: $( [ -s "$LANE_ROOT/data/autodeploy-migrations.applied" ] && paste -sd', ' "$LANE_ROOT/data/autodeploy-migrations.applied" || echo none)"

step "switch"
# The flip is what makes this a switch, so the rollback marker goes on first.
SWITCHED=1
render_backend_unit "$REL" || fail "could not point $MULTICA_BE_Z_UNIT at releases/${SHA:0:9}"
[ "$(readlink -f "$LANE_ROOT/multica-be/current")" = "$REL" ] || fail "current does not resolve to $REL"
UNIT_REL="$(unit_release)"
[ "$UNIT_REL" = "$LANE_ROOT/multica-be/current" ] \
  || fail "$MULTICA_BE_Z_UNIT runs '$UNIT_REL', not the current symlink"
log "$MULTICA_BE_Z_UNIT -> current -> releases/${SHA:0:9}; restarting"
systemctl --user restart "$MULTICA_BE_Z_UNIT"

step "health"
assert_health "$SHA" || fail "health check failed after the switch"

step "plugin"
if [ "$PLUGIN_PRESENT" = 1 ]; then
  NEW_HASH="$(bundle_hash "$ART/dsh-plugin")"
  OLD_HASH="$(bundle_hash "$DSH_Z_PLUGIN_BUNDLE")"
  if [ "$NEW_HASH" = "$OLD_HASH" ]; then
    printf 'unchanged (artifact matches the installed bundle)\n' > "$LANE_ROOT/data/autodeploy-plugin.note"
    log "plugin bundle unchanged; $DSH_Z_WEB_UNIT not restarted"
  else
    log "plugin bundle changed ($OLD_HASH -> $NEW_HASH); installing and restarting $DSH_Z_WEB_UNIT"
    rsync -a --delete "$ART/dsh-plugin/" "$DSH_Z_PLUGIN_BUNDLE/"
    printf 'updated (dsh-z restarted)\n' > "$LANE_ROOT/data/autodeploy-plugin.note"
    systemctl --user restart "$DSH_Z_WEB_UNIT"
    wait_http "http://${LANE_WEB_HOST:-127.0.0.1}:3180/" 90 '' || fail "lane web did not come back after the plugin update"
    assert_health "$SHA" || fail "health check failed after the plugin update"
  fi
else
  printf 'unchanged (no dsh-plugin artifact in this run)\n' > "$LANE_ROOT/data/autodeploy-plugin.note"
  log "no dsh-plugin artifact in run $RUN_ID; keeping the installed bundle"
fi

step "cleanup"
rm -rf "$ART"
prune_releases
prune_backups
rm -f "$LANE_ROOT/data/autodeploy.failed"

step "report"
report green
log "done in $(( $(date +%s) - STARTED ))s; /mnt/workspace $(free_gb)G free (was ${DF_BEFORE}G)"
if [ "$REPORT_FAILED" = 1 ]; then
  # The lane is healthy, so this must not roll back — but a deploy nobody was
  # told about is a failed tick, and the unit status is how that surfaces.
  log "deploy is UP but the evidence comment was not delivered; latest.md holds it"
  exit 1
fi
