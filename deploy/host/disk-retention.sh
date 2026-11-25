#!/usr/bin/env bash
# Disk-retention policy for lane z host (M-403).
#
# Why: the main-stack deploy preflight needs 10G free on both mounts, and lane z
# autodeploys refill freed space within hours. Two disk-full incidents in two days
# (runs 43940051419, 43995756080) aborted at the preflight floor. This script is
# the retention policy so it stops recurring.
#
# Policy (decided on M-403):
#   1. /mnt/containers (podman): prune dangling images every run; per
#      localhost/multica-{web,backend} keep the newest 2 staged tags
#      (deployed + previous) plus any tag a running container uses; delete older.
#   2. /mnt/workspace/cache/*: `pnpm store prune` (main + mmx stores, safe:
#      unreferenced content only); `npm cache verify` always, `npm cache clean
#      --force` only when the npm cache exceeds 2GiB; `go clean -cache
#      -testcache` only when go-build exceeds 512MiB (go toolchain present);
#      bun/go-mod caches are report-only (redownload cost, Owner call).
#   3. lane z releases/: keep the `current` symlink target + the newest other
#      release; delete older 40-hex dirs only when >=3 exist.
#   4. lane logs: delete logs/autodeploy/*.log, logs/rehearse-*.log,
#      logs/deploy-*.log, logs/verify-*.log older than 14 days.
#   5. /mnt/workspace/backups + /mnt/workspace/multica-main-backups: REPORT ONLY.
#      Lists per-prefix groups (newest two always kept) and flags candidates
#      older than 30d. Deletion needs Owner sign-off; this script never deletes.
#   6. Alert, don't silently prune: free space <12GiB on either mount logs ALERT
#      lines and sets alert=1 in the status file (the deploy preflight floor).
#   7. /mnt/workspace/clouds/dsh-z/artifacts: keep the newest 3 SHA dirs, plus any
#      SHA still referenced by a live symlink or by releases/, bin/ or bundles/.
#   8. /mnt/workspace/tmp: delete top-level entries older than 3 days; system
#      /tmp: delete dsh-workspace-changes-* and .5bff*.so older than 1 day.
#      Both skip anything with an open handle (lsof, includes mmapped .so).
#   9. Alert when /mnt/workspace is >=85% used. The log line + status file are
#      the source of truth; notify-send is best-effort (headless host is fine).
#      A marker file makes it fire on threshold crossing; it clears below 80%.
#
# Usage: disk-retention.sh [--apply|--dry-run]  (default: --dry-run report)
# Test overrides (never edit the production file to test): DISK_ALERT_PCT,
# DISK_ALERT_CLEAR_PCT, DISK_ALERT_MARKER.
# Timer unit runs with --apply daily. Logs to
# /mnt/workspace/clouds/dsh-z/logs/disk-retention.log; last-run summary in
# disk-retention.status next to it.
#
# Complements (does not replace) clouds/runners/disk-guard.sh, which guards the
# Actions runners' _work dirs and stops runners under its own floor.
set -euo pipefail

MODE="dry-run"
if [ "${1:-}" = "--apply" ]; then MODE="apply"; fi

LANE_Z="/mnt/workspace/clouds/dsh-z"
LOG_DIR="$LANE_Z/logs"
LOG_FILE="$LOG_DIR/disk-retention.log"
STATUS_FILE="$LOG_DIR/disk-retention.status"
ALERT_GIB=12
ALERT_PCT="${DISK_ALERT_PCT:-85}"
ALERT_CLEAR_PCT="${DISK_ALERT_CLEAR_PCT:-80}"
ALERT_MARKER="${DISK_ALERT_MARKER:-$LOG_DIR/disk-retention.alert-pct.marker}"
ARTIFACTS_KEEP=3
TMP_ROOT="/mnt/workspace/tmp"
TMP_AGE_DAYS=3
SYS_TMP_AGE_DAYS=1
NPM_CLEAN_OVER_MIB=2048
GO_CLEAN_OVER_MIB=512

log() { printf '[disk-retention %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"; }
log_alert() { printf '[disk-retention %s] ALERT: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"; }

free_gib() { df -BG --output=avail "$1" | tail -1 | tr -dc '0-9'; }
used_pct() { df -P "$1" | awk 'NR==2 {gsub(/%/, "", $5); print $5+0}'; }
path_busy() { # open handles, including mmapped .so files; lsof is the check
  local p="$1"
  command -v lsof >/dev/null 2>&1 || return 1
  if [ -d "$p" ]; then
    [ -n "$(lsof +D -- "$p" 2>/dev/null | tail -n +2)" ]
  else
    [ -n "$(lsof -- "$p" 2>/dev/null | tail -n +2)" ]
  fi
}

FREED_MIB=0
ALERT=0
apply_rm() { # apply_rm <path...> : rm -rf in apply mode, report in dry-run
  local size=0 p mib
  for p in "$@"; do
    # du may fail on unreadable paths; pipefail would otherwise append an
    # extra "0" to the substitution and break the arithmetic below.
    mib="$(du -sm "$p" 2>/dev/null | cut -f1 || true)"
    [[ "$mib" =~ ^[0-9]+$ ]] || mib=0
    size=$((size + mib))
  done
  if [ "$MODE" = "apply" ]; then
    # A failed rm (e.g. an other-uid tmp/ entry) must not abort the whole run.
    if rm -rf -- "$@"; then log "pruned $* (~${size}M)"; else log "prune FAILED $* (left in place)"; fi
  else
    log "would prune $* (~${size}M)"
  fi
  FREED_MIB=$((FREED_MIB + size))
}

log "start mode=$MODE"

# --- 0. free-space report + alert (not silent) ---
WS_FREE=$(free_gib /mnt/workspace)
CT_FREE=$(free_gib /mnt/containers)
WS_PCT=$(used_pct /mnt/workspace)
log "free: /mnt/workspace=${WS_FREE}G (${WS_PCT}% used) /mnt/containers=${CT_FREE}G (alert below ${ALERT_GIB}G, pct alert >=${ALERT_PCT}%)"
if [ "$WS_FREE" -lt "$ALERT_GIB" ]; then log_alert "/mnt/workspace free ${WS_FREE}G < ${ALERT_GIB}G"; ALERT=1; fi
if [ "$CT_FREE" -lt "$ALERT_GIB" ]; then log_alert "/mnt/containers free ${CT_FREE}G < ${ALERT_GIB}G"; ALERT=1; fi
# Percentage alert fires on crossing, not on every run. Log + status are the
# source of truth; notify-send is best-effort and may be absent on a headless host.
if [ "$WS_PCT" -ge "$ALERT_PCT" ]; then
  log_alert "/mnt/workspace ${WS_PCT}% used >= ${ALERT_PCT}%"
  ALERT=1
  if [ ! -e "$ALERT_MARKER" ]; then
    if command -v notify-send >/dev/null 2>&1; then
      notify-send "Disk alert" "/mnt/workspace is ${WS_PCT}% used (>= ${ALERT_PCT}%)" >/dev/null 2>&1 \
        || log "notify-send unavailable (no session bus); log/status are authoritative"
    else
      log "notify-send not installed; log/status are authoritative"
    fi
    date -u +%Y-%m-%dT%H:%M:%SZ > "$ALERT_MARKER" 2>/dev/null || true
  fi
elif [ "$WS_PCT" -le "$ALERT_CLEAR_PCT" ] && [ -e "$ALERT_MARKER" ]; then
  rm -f -- "$ALERT_MARKER" && log "pct alert cleared (${WS_PCT}% <= ${ALERT_CLEAR_PCT}%)"
fi

# --- 1. podman images ---
if command -v podman >/dev/null 2>&1; then
  if [ "$MODE" = "apply" ]; then
    PRUNE_OUT=$(podman image prune -f 2>&1 || true)
    PRUNE_N=$(printf '%s' "$PRUNE_OUT" | grep -cE '^[0-9a-f]{12,}' || true)
    log "podman image prune done (in-use images are skipped by podman): ${PRUNE_N} removed"
  else
    DANGLING_MIB=$(podman images -f dangling=true --format '{{.Size}}' 2>/dev/null | awk '{u=$2; v=$1; if (u=="GB") v*=1024; else if (u=="kB"||u=="KB") v/=1024; else if (u=="B") v=0; s+=v} END {printf "%d", s}')
    DANGLING_N=$(podman images -f dangling=true --format '{{.ID}}' 2>/dev/null | wc -l)
    log "would prune dangling podman images (${DANGLING_N} untagged, ~${DANGLING_MIB}M; podman skips any in use by containers)"
  fi
  # Keep newest 2 staged tags per repo + tags in use by running containers.
  IN_USE=$(podman ps --format '{{.Image}}' 2>/dev/null | sort -u || true)
  for repo in localhost/multica-web localhost/multica-backend; do
    mapfile -t TAGS < <(podman images --format '{{.Tag}} {{.CreatedAt}}' "$repo" 2>/dev/null | sort -k2 -r | awk '{print $1}' || true)
    [ "${#TAGS[@]}" -gt 2 ] || { log "$repo: ${#TAGS[@]} tags, keep all"; continue; }
    KEEP=("${TAGS[0]}" "${TAGS[1]}")
    for t in "${TAGS[@]:2}"; do
      if printf '%s\n' "$IN_USE" | grep -qxF "$repo:$t"; then log "$repo:$t in use by a running container, keep"; continue; fi
      if [ "$MODE" = "apply" ]; then
        podman rmi "$repo:$t" >/dev/null 2>&1 && log "removed old staged tag $repo:$t" || log "keep $repo:$t (rmi failed, likely shared layers in use)"
      else
        log "would remove old staged tag $repo:$t"
      fi
    done
    log "$repo: keep ${KEEP[*]}"
  done
else
  log "podman not found, skip image retention"
fi

# --- 2. package caches ---
if command -v pnpm >/dev/null 2>&1; then
  for store in /mnt/workspace/cache/pnpm-store /mnt/workspace/cache/mmx/pnpm-store; do
    [ -d "$store" ] || continue
    if [ "$MODE" = "apply" ]; then
      log "pnpm store prune ($store): $(pnpm store prune --store-dir "$store" 2>&1 | tail -1)"
    else
      log "would run: pnpm store prune --store-dir $store ($(du -sh "$store" 2>/dev/null | cut -f1) total)"
    fi
  done
else
  log "pnpm not found, skip pnpm store prune"
fi
if command -v npm >/dev/null 2>&1; then
  NPM_CACHE="${npm_config_cache:-/mnt/workspace/cache/npm}"
  if [ "$MODE" = "apply" ]; then
    npm cache verify --cache "$NPM_CACHE" >/dev/null 2>&1 && log "npm cache verify ok ($NPM_CACHE)" || log "npm cache verify failed"
    NPM_MIB=$(du -sm "$NPM_CACHE" 2>/dev/null | cut -f1 || echo 0)
    if [ "$NPM_MIB" -gt "$NPM_CLEAN_OVER_MIB" ]; then
      npm cache clean --force --cache "$NPM_CACHE" >/dev/null 2>&1 && log "npm cache clean --force (${NPM_MIB}M > ${NPM_CLEAN_OVER_MIB}M)" || log "npm cache clean failed"
    else
      log "npm cache ${NPM_MIB}M <= ${NPM_CLEAN_OVER_MIB}M, keep"
    fi
  else
    log "would run: npm cache verify (+ clean --force only if > ${NPM_CLEAN_OVER_MIB}M; now $(du -sh "$NPM_CACHE" 2>/dev/null | cut -f1))"
  fi
fi
if command -v go >/dev/null 2>&1; then
  for gb in /mnt/workspace/cache/go-build /mnt/workspace/cache/mmx/go-build; do
    [ -d "$gb" ] || continue
    GB_MIB=$(du -sm "$gb" 2>/dev/null | cut -f1 || echo 0)
    if [ "$GB_MIB" -gt "$GO_CLEAN_OVER_MIB" ] && [ "$MODE" = "apply" ]; then
      export GOCACHE="$gb"
      go clean -cache -testcache -fuzzcache 2>/dev/null && log "go clean caches ($gb was ${GB_MIB}M)" || log "go clean failed for $gb"
    else
      log "go-build $gb ${GB_MIB}M (clean only if > ${GO_CLEAN_OVER_MIB}M in apply mode)"
    fi
  done
else
  log "go not in PATH, go caches report-only: $(du -sh /mnt/workspace/cache/go-mod /mnt/workspace/cache/go-build /mnt/workspace/cache/mmx/go-mod /mnt/workspace/cache/mmx/go-build 2>/dev/null | tr '\n' ' ')"
fi
log "bun/go-mod caches report-only (redownload cost): $(du -sh /mnt/workspace/cache/bun /mnt/workspace/cache/go-mod /mnt/workspace/cache/mmx/go-mod 2>/dev/null | tr '\n' ' ')"

# --- 3. lane z releases: current + previous only ---
REL_DIR="$LANE_Z/releases"
if [ -L "$LANE_Z/current" ]; then
  CURRENT=$(readlink "$LANE_Z/current")
  CURRENT_BASE=$(basename "$CURRENT")
  mapfile -t RELS < <(find "$REL_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' 2>/dev/null | sort -rn | awk '{print $2}' || true)
  if [ "${#RELS[@]}" -gt 2 ]; then
    PREV=""
    for r in "${RELS[@]}"; do [ "$r" != "$CURRENT_BASE" ] && { PREV="$r"; break; }; done
    for r in "${RELS[@]}"; do
      [ "$r" = "$CURRENT_BASE" ] || [ "$r" = "$PREV" ] && continue
      [[ "$r" =~ ^[0-9a-f]{40}$ ]] || { log "releases/$r not a 40-hex dir, skip"; continue; }
      apply_rm "$REL_DIR/$r"
    done
    log "releases: keep current=$CURRENT_BASE previous=$PREV"
  else
    log "releases: ${#RELS[@]} dirs (current=$CURRENT_BASE), keep all"
  fi
else
  log "releases: $LANE_Z/current not a symlink, skip (refuse to guess)"
fi

# --- 3b. lane z artifacts: newest 3 SHAs + any live-ref SHA (M-559) ---
ART_DIR="$LANE_Z/artifacts"
if [ -d "$ART_DIR" ]; then
  mapfile -t ARTS < <(find "$ART_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' 2>/dev/null | sort -rn | awk '{print $2}' || true)
  declare -A PROTECTED=()
  for s in "${ARTS[@]}"; do
    [[ "$s" =~ ^[0-9a-f]{40}$ ]] || continue
    ref=""
    for l in "$LANE_Z"/*; do
      [ -L "$l" ] || continue
      target="$(readlink "$l" 2>/dev/null || true)"
      case "$target" in *"$s"*) ref="$(basename "$l") -> $target"; break;; esac
    done
    if [ -z "$ref" ]; then
      ref="$(grep -rl -- "$s" "$LANE_Z/releases" "$LANE_Z/bin" "$LANE_Z/bundles" 2>/dev/null | head -1 || true)"
    fi
    if [ -n "$ref" ]; then
      PROTECTED["$s"]="$ref"
      log "artifacts/$s live-ref ($ref), keep"
    fi
  done
  kept=0
  for s in "${ARTS[@]}"; do
    [[ "$s" =~ ^[0-9a-f]{40}$ ]] || { log "artifacts/$s not 40-hex, keep"; continue; }
    [ -n "${PROTECTED[$s]:-}" ] && continue
    if [ "$kept" -lt "$ARTIFACTS_KEEP" ]; then kept=$((kept + 1)); continue; fi
    apply_rm "$ART_DIR/$s"
  done
  log "artifacts: keep newest ${ARTIFACTS_KEEP} SHA dir(s) + ${#PROTECTED[@]} live-ref(s)"
else
  log "artifacts: $ART_DIR not found, skip"
fi

# --- 4. lane logs older than 14 days ---
mapfile -t OLD_LOGS < <(find "$LOG_DIR/autodeploy" "$LOG_DIR" -maxdepth 1 -type f \
  \( -path "$LOG_DIR/autodeploy/*.log" -o -name 'rehearse-*.log' -o -name 'deploy-*.log' -o -name 'verify-*.log' \) \
  -mtime +14 -print 2>/dev/null || true)
if [ "${#OLD_LOGS[@]}" -gt 0 ]; then
  # shellcheck disable=SC2128
  apply_rm "${OLD_LOGS[@]}"
  log "logs: ${#OLD_LOGS[@]} files older than 14d"
else
  log "logs: no matching files older than 14d"
fi

# --- 4b. /mnt/workspace/tmp older than 3 days (M-559) ---
if [ -d "$TMP_ROOT" ]; then
  mapfile -d '' -t OLD_TMP < <(find "$TMP_ROOT" -mindepth 1 -maxdepth 1 -mtime "+$TMP_AGE_DAYS" -print0 2>/dev/null || true)
  n=0
  for p in "${OLD_TMP[@]}"; do
    if path_busy "$p"; then log "tmp: $p has an open handle, skip"; continue; fi
    apply_rm "$p"; n=$((n + 1))
  done
  log "tmp: ${#OLD_TMP[@]} entries older than ${TMP_AGE_DAYS}d, pruned $n"
else
  log "tmp: $TMP_ROOT not found, skip"
fi

# --- 4c. system /tmp leftovers older than 1 day (M-559) ---
mapfile -d '' -t OLD_SYS_TMP < <(find /tmp -maxdepth 1 -mtime "+$SYS_TMP_AGE_DAYS" \
  \( -name 'dsh-workspace-changes-*' -o -name '.5bff*.so' \) -print0 2>/dev/null || true)
n=0
for p in "${OLD_SYS_TMP[@]}"; do
  if path_busy "$p"; then log "sys-tmp: $p has an open handle, skip"; continue; fi
  apply_rm "$p"; n=$((n + 1))
done
log "sys-tmp: ${#OLD_SYS_TMP[@]} leftovers older than ${SYS_TMP_AGE_DAYS}d, pruned $n"

# --- 5. backups: report only, never delete (Owner sign-off required) ---
for bdir in /mnt/workspace/backups /mnt/workspace/multica-main-backups; do
  [ -d "$bdir" ] || continue
  log "backups report-only: $bdir ($(du -sh "$bdir" 2>/dev/null | cut -f1) total)"
  # Group dump files by prefix (strip trailing timestamp/hash segments), keep
  # newest two per group; older files are deletion candidates for the Owner.
  # Per-prefix groups (strip trailing timestamp/hash segments); newest two per
  # group are kept, older files are deletion candidates for the Owner.
  find "$bdir" -maxdepth 2 -type f \( -name '*.dump' -o -name '*.sql' \) -printf '%T@ %h %f\n' 2>/dev/null \
    | sort -rn \
    | awk '{full=$2"/"$3; grp=$3;
            tmp=grp; sub(/-[0-9a-f]{7,}(-20[0-9]{6}T.*)?(\.dump|\.sql)$/, "", tmp); sub(/-20[0-9]{6}T.*(\.dump|\.sql)$/, "", tmp);
            if (tmp=="database.dump" || tmp=="database.sql") grp=$2; else grp=tmp;
            n[grp]++; if (n[grp]<=2) keep[grp]=keep[grp]" "full; else old[grp]++}
           END {for (g in n) printf "  group %s: %d files, keep newest two%s\n", g, n[g], (old[g]>0?"; "old[g]" older candidate(s) need Owner sign-off":"")}' \
    | sort | head -15 | while IFS= read -r line; do log "$line"; done
  STALE_CK="$bdir/stale-checkouts"
  [ -d "$STALE_CK" ] && log "  note: $STALE_CK ($(du -sh "$STALE_CK" 2>/dev/null | cut -f1)) is a separate cleanup pile, not covered by dump retention"
done

# --- 6. status file ---
{
  echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "mode=$MODE"
  echo "workspace_free_gib=$WS_FREE workspace_used_pct=$WS_PCT containers_free_gib=$CT_FREE alert=$ALERT"
  echo "approx_freed_mib=$FREED_MIB"
} > "$STATUS_FILE"
log "done mode=$MODE alert=$ALERT approx_freed=${FREED_MIB}M status=$STATUS_FILE"
