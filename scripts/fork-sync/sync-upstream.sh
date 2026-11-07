#!/usr/bin/env bash
# Report — or prepare — the next sync of multica-ai/multica into our fork.
# Runbook: docs/fork-sync.md. Never pushes, never opens a pull request.
#
#   scripts/fork-sync/sync-upstream.sh --check   report only; leaves the checkout as found
#   scripts/fork-sync/sync-upstream.sh           branch sync/upstream-<version> and merge the tag
#
# Exit codes: 0 up to date or clean merge, 2 conflicts, 1 usage/environment error.

set -euo pipefail
export LC_ALL=C

base_ref=origin/multica-moct
upstream_remote=upstream
fetch_enabled=1
mode=sync
# Release tags only: desktop-v*, pre-releases and snapshots are not upstream releases.
tag_pattern='^v[0-9]+[.][0-9]+[.][0-9]+$'

usage() {
  cat <<'EOF'
Usage: scripts/fork-sync/sync-upstream.sh [--check] [--base <ref>] [--upstream <remote>] [--no-fetch]

  --check              Report only: newest upstream release tag, commits behind,
                       conflicting files, fork-owned flags, the migration
                       numbers on both sides and the MMX version string the
                       merged tree would stamp. Creates no branch.
  --base <ref>         Branch to sync into (default: origin/multica-moct).
  --upstream <remote>  Remote holding upstream (default: upstream).
  --no-fetch           Use the refs already in the repository.

Without --check the script creates sync/upstream-<version> from the base ref and
merges the newest upstream release tag into it, leaving any conflicts in the
working tree for you to resolve.

Exit codes: 0 up to date or clean merge, 2 conflicts, 1 usage/environment error.
EOF
}

die() {
  printf 'sync-upstream: %s\n' "$*" >&2
  exit 1
}

# awk, not grep -q, for the counts and lookups below: a pipeline that closes
# early trips `pipefail` and reports a match as a miss.
count_lines() { awk 'NF { n++ } END { print n + 0 }'; }

# Migration files directly under server/migrations/ at a revision, name only.
migration_files_of() {
  git ls-tree -r --name-only "$1" -- server/migrations/ 2>/dev/null |
    sed 's#.*/##' |
    { grep -E '^[0-9]+_.*\.up\.sql$' || true; } |
    sort
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) mode=check ;;
    --base)
      [ $# -ge 2 ] || die "--base needs a ref"
      base_ref=$2
      shift
      ;;
    --upstream)
      [ $# -ge 2 ] || die "--upstream needs a remote name"
      upstream_remote=$2
      shift
      ;;
    --no-fetch) fetch_enabled=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'sync-upstream: unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git checkout"
git remote get-url "$upstream_remote" >/dev/null 2>&1 ||
  die "no '$upstream_remote' remote; add it with: git remote add $upstream_remote https://github.com/multica-ai/multica.git"

if [ "$fetch_enabled" = 1 ]; then
  git fetch --quiet --tags "$upstream_remote" ||
    die "git fetch $upstream_remote failed (use --no-fetch to read the refs already present)"
  base_remote=${base_ref%%/*}
  if [ "$base_remote" != "$base_ref" ] && git remote get-url "$base_remote" >/dev/null 2>&1; then
    git fetch --quiet "$base_remote" || die "git fetch $base_remote failed"
  fi
fi

git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null ||
  die "base ref '$base_ref' not found; pass --base <ref>"

release_tags=$(git tag --list --sort=-v:refname 'v*')
tag=$(awk -v re="$tag_pattern" '$0 ~ re { print; exit }' <<<"$release_tags")
[ -n "$tag" ] || die "no upstream release tag (vX.Y.Z) found; the fetch may have failed"

base_sha=$(git rev-parse --short=9 "$base_ref^{commit}")
tag_sha=$(git rev-parse --short=9 "$tag^{commit}")
behind=$(git rev-list --count "$base_ref..$tag")
current_branch=$(git rev-parse --abbrev-ref HEAD)

printf '== Multica fork upstream sync ==\n'
printf 'repository : %s (%s)\n' "$(git rev-parse --show-toplevel)" "$current_branch"
printf 'base       : %s @ %s\n' "$base_ref" "$base_sha"
printf 'upstream   : %s @ %s\n' "$tag" "$tag_sha"

# MMX stamp: scripts/mmx-version.mjs reads the version from apps/web/package.json
# and stamps it with the build time; the merged tree takes that version from the
# upstream tag. Show the deterministic stamp at the tag's commit time — the real
# stamp is build-time (CI asserts `node scripts/mmx-version.mjs --from-git`).
tag_time=$(git show -s --format=%cI "$tag^{commit}")
tag_version=$(git show "$tag:apps/web/package.json" | node -e \
  'let s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { console.log(JSON.parse(s).version ?? "unknown"); });')
if [ -n "$tag_version" ]; then
  tag_stamp=$(LC_ALL=C TZ='Asia/Ho_Chi_Minh' date -d "$tag_time" +%y%b%d.%H.%M | tr a-z A-Z)
  printf 'mmx-version : %s-%s (version from apps/web/package.json @ %s; stamp at tag time)\n' "$tag_version" "$tag_stamp" "$tag"
fi

if [ "$behind" -eq 0 ]; then
  printf 'behind     : 0 commits — %s already contains %s\n' "$base_ref" "$tag"
  exit 0
fi

printf 'behind     : %s commits\n' "$behind"

merge_base=$(git merge-base "$base_ref" "$tag") || die "no merge base between $base_ref and $tag"
printf 'merge base : %s\n' "$(git rev-parse --short=9 "$merge_base")"

# --write-tree reports the conflict set without touching the index or the
# working tree, which is what keeps --check side-effect free.
merge_status=0
merge_tree=$(git merge-tree --write-tree --name-only "$base_ref" "$tag" 2>/dev/null) || merge_status=$?
case "$merge_status" in
  0 | 1) ;;
  *) die "git merge-tree --write-tree failed; git >= 2.38 is required" ;;
esac

# Layout: tree OID, the conflicting files, a blank line, then auto-merge notes.
conflicts=$(printf '%s\n' "$merge_tree" | awk 'NR == 1 { next } /^$/ { files_done = 1 } !files_done && NF { print }')
conflict_count=$(count_lines <<<"$conflicts")

# A file is fork-owned when our branch changed it since the merge base: those
# conflicts are ours to re-apply, everything else is upstream's to take.
declare -A fork_owned=()
while IFS= read -r file; do
  if [ -n "$file" ]; then
    fork_owned["$file"]=1
  fi
done < <(git diff --no-renames --name-only "$merge_base" "$base_ref")
fork_owned_count=0
while IFS= read -r file; do
  if [ -n "$file" ] && [ -n "${fork_owned[$file]:-}" ]; then
    fork_owned_count=$((fork_owned_count + 1))
  fi
done <<<"$conflicts"

fork_files=$(migration_files_of "$base_ref")
upstream_files=$(migration_files_of "$tag")
base_files=$(migration_files_of "$merge_base")
fork_max=$(awk -F_ 'NF { if (!seen || $1 + 0 > max) { max = $1 + 0; seen = 1 } } END { print seen ? max : "none" }' <<<"$fork_files")
upstream_max=$(awk -F_ 'NF { if (!seen || $1 + 0 > max) { max = $1 + 0; seen = 1 } } END { print seen ? max : "none" }' <<<"$upstream_files")

# Only migrations upstream added since our last sync can collide with numbers we
# already spent, and only the ones we added ourselves are ours to renumber.
upstream_new=$(comm -13 <(printf '%s\n' "$base_files") <(printf '%s\n' "$upstream_files") | awk 'NF')
fork_new=$(comm -13 <(printf '%s\n' "$base_files") <(printf '%s\n' "$fork_files") | awk 'NF')
collisions=""
while IFS= read -r file; do
  [ -n "$file" ] || continue
  number=${file%%_*}
  same=$(awk -v n="$((10#$number))" -F_ 'NF && $1 + 0 == n' <<<"$fork_new")
  [ -n "$same" ] || continue
  collisions+="  ${number}: upstream ${file} / fork ${same//$'\n'/, }"$'\n'
done <<<"$upstream_new"
collision_count=$(count_lines <<<"$collisions")

printf 'conflicts  : %s files (%s fork-owned)\n' "$conflict_count" "$fork_owned_count"
printf 'migrations : fork max %s, upstream max %s, %s collisions\n' "$fork_max" "$upstream_max" "$collision_count"

if [ "$conflict_count" -gt 0 ]; then
  printf '\nconflicting files:\n'
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if [ -n "${fork_owned[$file]:-}" ]; then
      printf '  [fork-owned] %s\n' "$file"
    else
      printf '  [upstream]   %s\n' "$file"
    fi
  done <<<"$conflicts"
fi

if [ "$collision_count" -gt 0 ]; then
  printf '\nmigration number collisions:\n%s' "$collisions"
  printf 'Renumber the fork migration(s) before merging, and extend forkMigrationRenames in\n'
  printf 'server/cmd/migrate so rows recorded under the old stem move to the new one: the\n'
  printf 'schema_migrations version key is the full file stem, not the number.\n'
fi

if [ "$mode" = check ]; then
  printf '\nNo branch created. Re-run without --check to create sync/upstream-%s and merge %s.\n' "${tag#v}" "$tag"
  [ "$conflict_count" -eq 0 ] || exit 2
  exit 0
fi

if git rev-parse --quiet --verify MERGE_HEAD >/dev/null 2>&1; then
  die "a merge is already in progress; finish or abort it first"
fi
git diff-index --quiet HEAD -- ||
  die "the working tree has uncommitted changes to tracked files; commit or stash them first"

branch="sync/upstream-${tag#v}"
if git show-ref --verify --quiet "refs/heads/$branch"; then
  die "branch $branch already exists; check it out or delete it"
fi
git switch --quiet -c "$branch" "$base_ref" ||
  die "cannot create $branch from $base_ref"

printf '\nCreated %s from %s.\n' "$branch" "$base_ref"
if git merge --no-edit "$tag"; then
  printf '\nMerge clean. Next: pnpm install, pnpm typecheck, pnpm lint, pnpm test and make test,\n'
  printf 'then open the PR into %s (docs/fork-sync.md).\n' "$base_ref"
  exit 0
fi

printf '\nMerge stopped with conflicts. Resolve every [fork-owned] file in favour of our behaviour and\n'
printf 'take upstream where the file is not fork-owned, then finish the checks and open the PR into\n'
printf '%s. See docs/fork-sync.md.\n' "$base_ref"
exit 2
