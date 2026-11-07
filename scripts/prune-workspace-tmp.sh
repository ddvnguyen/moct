#!/usr/bin/env bash
# Allowlist-based prune of the shared Multica scratch dir.
#
# Deletes only directories under $MULTICA_TMP_ROOT that match the allowlist
# below AND are older than 7 days (directory mtime):
#   - build caches: go-build*, gocache, gobuild, gotmp, buildah*,
#     node-compile-cache, jiti, tsx-*, node-addon-native-custom-loader-*,
#     playwright-transform-cache-*, playwright_chromiumdev_profile-*,
#     playwright-artifacts-*
#   - experiment scratch: m*-tmp
# Never touched, regardless of age: pnpm-store, gomodcache, pgdata,
# multica-pgdata, spike-tools, and every multica-task-* dir (the daemon owns
# their lifecycle). Anything not matching the allowlist is kept and listed.
#
# Dry-run by default; --apply deletes. One log line per decision.
#
# Usage: prune-workspace-tmp.sh [--apply] [--days N]
set -euo pipefail

log() { printf '[prune-workspace-tmp %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

APPLY=0
DAYS=7
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --days) DAYS="$2"; shift ;;
    *) log "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$DAYS" =~ ^[0-9]+$ ]] || { log "--days must be a number" >&2; exit 2; }

ROOT="${MULTICA_TMP_ROOT:-/mnt/workspace/tmp}"
[ -d "$ROOT" ] || { log "tmp root not found: $ROOT" >&2; exit 1; }
for cmd in date find du rm; do
  command -v "$cmd" >/dev/null 2>&1 || { log "required command not found: $cmd" >&2; exit 1; }
done

# Allowlist patterns for prunable entries.
ALLOW_PATTERNS=(
  'go-build*'
  'gocache'
  'gobuild'
  'gotmp'
  'buildah*'
  'node-compile-cache'
  'jiti'
  'tsx-*'
  'node-addon-native-custom-loader-*'
  'playwright-transform-cache-*'
  'playwright_chromiumdev_profile-*'
  'playwright-artifacts-*'
  'm*-tmp'
)

# Hard guards: matched names are never pruned even if they also match above.
PROTECTED_PATTERNS=(
  'pnpm-store'
  'gomodcache'
  'pgdata'
  'multica-pgdata'
  'spike-tools'
  'multica-task-*'
)

is_dir_allowed() {
  local name="$1" pat
  for pat in "${ALLOW_PATTERNS[@]}"; do
    [[ "$name" == $pat ]] && return 0
  done
  return 1
}

is_protected() {
  local name="$1" pat
  for pat in "${PROTECTED_PATTERNS[@]}"; do
    [[ "$name" == $pat ]] && return 0
  done
  return 1
}

DELETED=0
FREED_BYTES=0

while IFS= read -r -d '' dir; do
  name="$(basename "$dir")"
  if is_protected "$name"; then
    log "KEEP $name (protected)"
    continue
  fi
  if ! is_dir_allowed "$name"; then
    log "KEEP $name (not in allowlist)"
    continue
  fi
  # Directory mtime must be older than the prune age.
  if [ -n "$(find "$dir" -maxdepth 0 -mtime +"$DAYS" -print 2>/dev/null)" ]; then
    size="$(du -sk "$dir" 2>/dev/null | awk '{print $1}' || printf 0)"
    if [ "$APPLY" = 1 ]; then
      if rm -rf --one-file-system "$dir"; then
        log "DELETE $name (${size} KiB)"
        DELETED=$((DELETED + 1))
        FREED_BYTES=$((FREED_BYTES + size * 1024))
      else
        log "KEEP $name (delete failed)"
      fi
    else
      log "WOULD DELETE $name (${size} KiB)"
      DELETED=$((DELETED + 1))
      FREED_BYTES=$((FREED_BYTES + size * 1024))
    fi
  else
    log "KEEP $name (younger than ${DAYS}d)"
  fi
done < <(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

log "summary: $DELETED candidate(s) pruned, ~$((FREED_BYTES / 1024 / 1024)) MiB freed"
if [ "$APPLY" = 0 ]; then
  log "dry-run complete; nothing was deleted (pass --apply to delete)"
fi
