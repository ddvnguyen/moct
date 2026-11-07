#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/prune-workspace-tmp.sh"
SANDBOX="$(mktemp -d "$REPO_ROOT/.prune-workspace-tmp-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

export MULTICA_TMP_ROOT="$SANDBOX/tmp"
mkdir -p "$MULTICA_TMP_ROOT"
OLD_DATE='10 days ago'

mkold() { mkdir -p "$1"; find "$1" -maxdepth 0 -mtime +7 >/dev/null; touch -d "$OLD_DATE" "$1"; }

# Old allowlisted build caches: pruned.
mkold "$MULTICA_TMP_ROOT/gocache"
mkold "$MULTICA_TMP_ROOT/go-build12345"
mkold "$MULTICA_TMP_ROOT/m209-dev-tmp"

# Fresh allowlisted cache: kept.
mkdir -p "$MULTICA_TMP_ROOT/go-build-fresh"

# Protected names: kept even when old.
mkold "$MULTICA_TMP_ROOT/pnpm-store"
mkold "$MULTICA_TMP_ROOT/gomodcache"
mkold "$MULTICA_TMP_ROOT/pgdata"
mkold "$MULTICA_TMP_ROOT/spike-tools"
mkold "$MULTICA_TMP_ROOT/multica-task-123456"

# Names outside the allowlist: kept.
mkold "$MULTICA_TMP_ROOT/dsh-spill-abc"
mkold "$MULTICA_TMP_ROOT/some-experiment"

assert() { "$@" || { printf 'assertion failed: %s\n' "$*" >&2; exit 1; }; }

# Dry-run: lists candidates, deletes nothing.
out="$(bash "$SCRIPT")"
[[ "$out" == *"WOULD DELETE gocache"* ]]
[[ "$out" == *"WOULD DELETE go-build12345"* ]]
[[ "$out" == *"WOULD DELETE m209-dev-tmp"* ]]
[[ "$out" == *"KEEP go-build-fresh (younger than 7d)"* ]]
[[ "$out" == *"KEEP pnpm-store (protected)"* ]]
[[ "$out" == *"KEEP gomodcache (protected)"* ]]
[[ "$out" == *"KEEP pgdata (protected)"* ]]
[[ "$out" == *"KEEP spike-tools (protected)"* ]]
[[ "$out" == *"KEEP multica-task-123456 (protected)"* ]]
[[ "$out" == *"KEEP dsh-spill-abc (not in allowlist)"* ]]
[[ "$out" == *"KEEP some-experiment (not in allowlist)"* ]]
[[ "$out" == *"dry-run complete"* ]]
for d in gocache go-build12345 m209-dev-tmp go-build-fresh pnpm-store gomodcache pgdata spike-tools multica-task-123456 dsh-spill-abc some-experiment; do
  assert test -d "$MULTICA_TMP_ROOT/$d"
done

# Apply: only the old allowlisted dirs are removed.
out="$(bash "$SCRIPT" --apply)"
[[ "$out" == *"DELETE gocache"* ]]
assert test ! -d "$MULTICA_TMP_ROOT/gocache"
assert test ! -d "$MULTICA_TMP_ROOT/go-build12345"
assert test ! -d "$MULTICA_TMP_ROOT/m209-dev-tmp"
for d in go-build-fresh pnpm-store gomodcache pgdata spike-tools multica-task-123456 dsh-spill-abc some-experiment; do
  assert test -d "$MULTICA_TMP_ROOT/$d"
done

printf 'prune-workspace-tmp stub tests passed\n'
