#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/prune-workspaces.sh"
SANDBOX="$(mktemp -d "$REPO_ROOT/.prune-workspaces-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
ROOT="$SANDBOX/root"
PROJ="$ROOT/project"
mkdir -p "$PROJ"

export MULTICA_WORKSPACES_ROOT="$ROOT"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@test GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@test

PAST_TS="$(date -u -d '4 days ago' +%Y-%m-%dT%H:%M:%SZ)"
RECENT_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

new_repo() { # $1 = dir, $2 = push (1) or keep local commits (0)
  local dir="$1" push="$2"
  mkdir -p "$dir/workdir/repo"
  git -C "$dir/workdir/repo" init -q
  echo "hello $(basename "$dir")" > "$dir/workdir/repo/file.txt"
  git -C "$dir/workdir/repo" add -A
  git -C "$dir/workdir/repo" commit -qm init
  if [ "$push" = 1 ]; then
    git -C "$dir/workdir/repo" remote add origin "$SANDBOX/origin.git"
    # Each repo pushes to its own branch: unrelated histories share origin.
    git -C "$dir/workdir/repo" push -q origin "HEAD:refs/heads/$(basename "$dir")"
  fi
}

meta() { # $1 = dir, $2 = completed_at timestamp
  printf '{"kind":"issue","completed_at":"%s"}\n' "$2" > "$1/.gc_meta.json"
}

# Remote shared by the pushed repos.
git init -q --bare "$SANDBOX/origin.git"

# 1. clean old dir: pushed repo, no changes, old completed_at, no lock.
new_repo "$PROJ/clean-old" 1
meta "$PROJ/clean-old" "$PAST_TS"

# 2. dirty repo: tracked change must keep the dir.
new_repo "$PROJ/dirty" 1
meta "$PROJ/dirty" "$PAST_TS"
echo changed > "$PROJ/dirty/workdir/repo/file.txt"

# 3. untracked file in the repo also keeps the dir.
new_repo "$PROJ/untracked" 1
meta "$PROJ/untracked" "$PAST_TS"
echo scratch > "$PROJ/untracked/workdir/repo/scratch.txt"

# 4. unpushed commit must keep the dir.
new_repo "$PROJ/unpushed" 1
meta "$PROJ/unpushed" "$PAST_TS"
echo more >> "$PROJ/unpushed/workdir/repo/file.txt"
git -C "$PROJ/unpushed/workdir/repo" commit -qam "unpushed work"

# 5. live .task_lock must keep the dir.
new_repo "$PROJ/locked" 1
meta "$PROJ/locked" "$PAST_TS"
printf '' > "$PROJ/locked/.task_lock"
flock "$PROJ/locked/.task_lock" sleep 60 &
LOCK_PID=$!
sleep 0.3

# 6. completed_at within TTL must keep the dir.
new_repo "$PROJ/fresh" 1
meta "$PROJ/fresh" "$RECENT_TS"

# 7. no .gc_meta.json must keep the dir.
new_repo "$PROJ/no-meta" 1

# 8. Linked worktrees (`.git` is a FILE pointing at a shared repo). The anchor
# repo is kept fresh so it survives the whole test.
new_repo "$PROJ/wt-anchor" 1
meta "$PROJ/wt-anchor" "$RECENT_TS"
ANCHOR="$PROJ/wt-anchor/workdir/repo"

# 8a. clean worktree on a pushed branch: deleted.
git -C "$ANCHOR" worktree add -q -b wtclean "$PROJ/wt-clean/workdir/wtree"
git -C "$PROJ/wt-clean/workdir/wtree" push -q origin wtclean
meta "$PROJ/wt-clean" "$PAST_TS"

# 8b. dirty worktree (modified tracked file + untracked file): kept.
git -C "$ANCHOR" worktree add -q -b wtdirty "$PROJ/wt-dirty/workdir/wtree"
echo changed > "$PROJ/wt-dirty/workdir/wtree/file.txt"
echo scratch > "$PROJ/wt-dirty/workdir/wtree/scratch.txt"
meta "$PROJ/wt-dirty" "$PAST_TS"

# 8c. worktree with an unpushed commit: kept.
git -C "$ANCHOR" worktree add -q -b wtunpushed "$PROJ/wt-unpushed/workdir/wtree"
echo more > "$PROJ/wt-unpushed/workdir/wtree/file.txt"
git -C "$PROJ/wt-unpushed/workdir/wtree" commit -qam "unpushed worktree commit"
meta "$PROJ/wt-unpushed" "$PAST_TS"

assert() { "$@" || { printf 'assertion failed: %s\n' "$*" >&2; exit 1; }; }

# Dry-run: nothing deleted, the clean dirs are the only deletion candidates.
out="$(bash "$SCRIPT")"
[[ "$out" == *"WOULD DELETE $PROJ/clean-old"* ]]
[[ "$out" == *"WOULD DELETE $PROJ/wt-clean"* ]]
[[ "$out" == *"KEEP $PROJ/dirty (dirty or untracked files"* ]]
[[ "$out" == *"KEEP $PROJ/untracked (dirty or untracked files"* ]]
[[ "$out" == *"KEEP $PROJ/unpushed (unpushed commits"* ]]
[[ "$out" == *"KEEP $PROJ/locked (live .task_lock)"* ]]
[[ "$out" == *"KEEP $PROJ/fresh (completed_at within 72h TTL)"* ]]
[[ "$out" == *"KEEP $PROJ/no-meta (no .gc_meta.json)"* ]]
[[ "$out" == *"KEEP $PROJ/wt-dirty (dirty or untracked files"* ]]
[[ "$out" == *"KEEP $PROJ/wt-unpushed (unpushed commits"* ]]
[[ "$out" == *"KEEP $PROJ/wt-anchor (completed_at within 72h TTL)"* ]]
[[ "$out" == *"dry-run complete"* ]]
assert test -d "$PROJ/clean-old"
assert test -d "$PROJ/wt-clean"

# Apply: only the clean old dirs are removed.
out="$(bash "$SCRIPT" --apply)"
[[ "$out" == *"DELETE $PROJ/clean-old"* ]]
[[ "$out" == *"DELETE $PROJ/wt-clean"* ]]
assert test ! -d "$PROJ/clean-old"
assert test ! -d "$PROJ/wt-clean"
for kept in dirty untracked unpushed locked fresh no-meta wt-anchor wt-dirty wt-unpushed; do
  assert test -d "$PROJ/$kept"
done

kill "$LOCK_PID" 2>/dev/null || true
wait "$LOCK_PID" 2>/dev/null || true

printf 'prune-workspaces stub tests passed\n'
