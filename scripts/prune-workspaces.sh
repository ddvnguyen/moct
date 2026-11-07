#!/usr/bin/env bash
# Prune completed Multica run directories that hold no unpushed git work.
#
# A run directory under $MULTICA_WORKSPACES_ROOT is deleted only when ALL of:
#   - its .gc_meta.json has completed_at older than the TTL (default 72h)
#   - its .task_lock advisory flock is not held by a live process
#   - every git repository inside has no modified/untracked files and no
#     commits that exist on no remote (untracked files also keep the dir:
#     they are as much uncommitted work as a dirty tree)
# Everything else is kept and listed. Dry-run by default; --apply deletes.
# One log line per decision, then a summary.
#
# The daemon GC (MULTICA_GC_COMPLETED_TASK_TTL) intentionally stays disabled:
# it deletes on completed_at age alone, without the git audit done here.
#
# Usage: prune-workspaces.sh [--apply] [--ttl-hours N]
set -euo pipefail

log() { printf '[prune-workspaces %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

APPLY=0
TTL_HOURS=72
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --ttl-hours) TTL_HOURS="$2"; shift ;;
    *) log "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$TTL_HOURS" =~ ^[0-9]+$ ]] || { log "--ttl-hours must be a number" >&2; exit 2; }

ROOT="${MULTICA_WORKSPACES_ROOT:-/mnt/workspace/multica_workspaces}"
[ -d "$ROOT" ] || { log "workspaces root not found: $ROOT" >&2; exit 1; }
for cmd in date flock find git jq rm; do
  command -v "$cmd" >/dev/null 2>&1 || { log "required command not found: $cmd" >&2; exit 1; }
done

NOW=$(date -u +%s)
CUTOFF=$((NOW - TTL_HOURS * 3600))
DELETED=0
KEPT=0
declare -a SUMMARY=()

# Prints "ok" when the dir is safe to delete, otherwise the keep reason.
audit_dir() {
  local dir="$1" meta completed completed_epoch lock repos repo git_out
  meta="$dir/.gc_meta.json"
  if [ ! -f "$meta" ]; then
    printf 'no .gc_meta.json'
    return
  fi
  completed="$(jq -r '.completed_at // empty' "$meta" 2>/dev/null || true)"
  if [ -z "$completed" ]; then
    printf 'gc meta has no completed_at'
    return
  fi
  completed_epoch="$(date -u -d "$completed" +%s 2>/dev/null || true)"
  if ! [[ "$completed_epoch" =~ ^[0-9]+$ ]]; then
    printf 'unparseable completed_at'
    return
  fi
  if [ "$completed_epoch" -gt "$CUTOFF" ]; then
    printf 'completed_at within %sh TTL' "$TTL_HOURS"
    return
  fi
  lock="$dir/.task_lock"
  if [ -e "$lock" ] && ! flock -n "$lock" true 2>/dev/null; then
    printf 'live .task_lock'
    return
  fi
  # .git can be a directory (normal repo) or a file (linked worktree whose
  # repository lives in the shared bare repo) — audit both.
  repos="$(find "$dir" -name .git -prune -print 2>/dev/null || true)"
  while IFS= read -r gitdir; do
    [ -n "$gitdir" ] || continue
    repo="$(dirname "$gitdir")"
    git_out="$(git --no-optional-locks -C "$repo" status --porcelain 2>/dev/null || printf 'GIT_FAIL')"
    if [ "$git_out" = "GIT_FAIL" ]; then
      printf 'git audit failed: %s' "$repo"
      return
    fi
    if [ -n "$git_out" ]; then
      printf 'dirty or untracked files: %s' "$repo"
      return
    fi
    if [ -f "$gitdir" ]; then
      # Linked worktree: the shared bare repo's branches belong to other run
      # dirs too, so audit only what this worktree's HEAD adds.
      unpushed="$(git --no-optional-locks -C "$repo" rev-list HEAD --not --remotes 2>/dev/null || printf 'GIT_FAIL')"
    else
      unpushed="$(git --no-optional-locks -C "$repo" log --branches --not --remotes --format=%H 2>/dev/null || printf 'GIT_FAIL')"
    fi
    if [ "$unpushed" = "GIT_FAIL" ]; then
      printf 'git audit failed: %s' "$repo"
      return
    fi
    if [ -n "$unpushed" ]; then
      printf 'unpushed commits: %s' "$repo"
      return
    fi
  done <<<"$repos"
  printf 'ok'
}

for project in "$ROOT"/*/; do
  [ -d "$project" ] || continue
  for dir in "$project"*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    reason="$(audit_dir "$dir")"
    if [ "$reason" = "ok" ]; then
      if [ "$APPLY" = 1 ]; then
        if rm -rf --one-file-system "$dir"; then
          log "DELETE $dir"
          SUMMARY+=("deleted $dir")
          DELETED=$((DELETED + 1))
        else
          log "KEEP $dir (delete failed)"
          KEPT=$((KEPT + 1))
        fi
      else
        log "WOULD DELETE $dir"
        SUMMARY+=("would delete $dir")
        DELETED=$((DELETED + 1))
      fi
    else
      log "KEEP $dir ($reason)"
      KEPT=$((KEPT + 1))
    fi
  done
done

log "summary: $DELETED candidate(s) for deletion, $KEPT kept"
for line in "${SUMMARY[@]:-}"; do
  [ -n "$line" ] && log "$line"
done
if [ "$APPLY" = 0 ]; then
  log "dry-run complete; nothing was deleted (pass --apply to delete)"
fi
