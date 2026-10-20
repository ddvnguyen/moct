#!/usr/bin/env bash
# cut-snapshot.sh — cut one day's snapshot across the whole release train.
#
# One command, one date, every repo: for each repo of deploy/train-repos.json
# the repo's snapshot-tag.yml is dispatched with the SAME date token, then the
# stack-PR workflow is dispatched, then the tags and their shas are printed.
#
# The date token is computed from UTC, never typed by hand. The script uses the
# operator's own `gh` credentials and stores NO token: `gh` reads them from
# its own configuration.
#
# Flags:
#   --date ddMMMyy   the date token (default: today, UTC)
#   --repos a,b,c    only these train keys (default: every repo of the manifest)
#   --dry-run        print what would be dispatched, change nothing
#
# The script lives in the train owner (ddvnguyen/moct); it dispatches into the
# other repos of the train through the GitHub API.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MANIFEST="${MANIFEST:-$REPO_ROOT/deploy/train-repos.json}"

DATE=""
REPOS=""
DRY_RUN=0
WAIT_SECONDS="${WAIT_SECONDS:-600}"

log() { printf '[cut-snapshot %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { printf '[cut-snapshot %s] FATAL: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit 1; }

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --date)
      [ "$#" -ge 2 ] || die "--date needs a value"
      DATE="$2"; shift 2 ;;
    --date=*)
      DATE="${1#*=}"; shift ;;
    --repos)
      [ "$#" -ge 2 ] || die "--repos needs a value"
      REPOS="$2"; shift 2 ;;
    --repos=*)
      REPOS="${1#*=}"; shift ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      usage 0 ;;
    *)
      die "unknown flag: $1 (try --help)" ;;
  esac
done

[ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST"
command -v gh >/dev/null 2>&1 || die "gh is required (the operator's own gh credentials are used; no token is read from the environment)"

# The date token is computed from UTC. A supplied token is accepted only in
# the exact ddMMyy shape.
if [ -z "$DATE" ]; then
  DATE="$(date -u +%d%b%y)"
else
  printf '%s' "$DATE" | grep -Eq '^[0-9]{2}[A-Z][a-z]{2}[0-9]{2}$' \
    || die "--date must look like ddMMMyy (20Oct26), got: $DATE"
fi
TAG="snapshot/$DATE"

# The train map: key -> repo slug.
TRAIN="$(node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const [key, e] of Object.entries(m.repos)) console.log(`${key}\t${e.repo}`);
' "$MANIFEST")" || die "manifest is unreadable: $MANIFEST"
[ -n "$TRAIN" ] || die "the manifest lists no repos"

SELECTED=""
if [ -n "$REPOS" ]; then
  for key in $(printf '%s' "$REPOS" | tr ',' ' '); do
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    [ -n "$key" ] || continue
    printf '%s\n' "$TRAIN" | grep -q "^$key"$'\t' || die "unknown train key: $key"
    SELECTED="$SELECTED$key"$'\n'
  done
else
  SELECTED="$(printf '%s\n' "$TRAIN" | cut -f1)"$'\n'
fi

log "date token: $DATE (tag $TAG)"
log "repos: $(printf '%s' "$SELECTED" | tr '\n' ' ')"
[ "$DRY_RUN" = "1" ] && log "DRY_RUN=1 — nothing is dispatched"

# --- 1. dispatch the snapshot tag workflow in every repo ---------------------
for key in $(printf '%s' "$SELECTED" | tr '\n' ' '); do
  repo="$(printf '%s\n' "$TRAIN" | awk -F'\t' -v k="$key" '$1==k{print $2}')"
  [ -n "$repo" ] || die "no repo for the train key $key"
  if [ "$DRY_RUN" = "1" ]; then
    log "would dispatch snapshot-tag.yml in $repo with date=$DATE"
    continue
  fi
  log "dispatching snapshot-tag.yml in $repo (date=$DATE)"
  gh workflow run snapshot-tag.yml --repo "$repo" -f "date=$DATE" \
    || die "could not dispatch snapshot-tag.yml in $repo"
done

# --- 2. wait for the tags, then dispatch the stack PR workflows --------------
# The tag workflow is asynchronous: the run has to reach its tag step before
# the ref exists. The wait is bounded and reports what is missing.
if [ "$DRY_RUN" = "1" ]; then
  for key in $(printf '%s' "$SELECTED" | tr '\n' ' '); do
    repo="$(printf '%s\n' "$TRAIN" | awk -F'\t' -v k="$key" '$1==k{print $2}')"
    log "would dispatch stack-pr.yml in $repo"
  done
  log "would print the tag shas of $TAG"
  exit 0
fi

deadline=$(( $(date +%s) + WAIT_SECONDS ))
missing=""
while :; do
  missing=""
  for key in $(printf '%s' "$SELECTED" | tr '\n' ' '); do
    repo="$(printf '%s\n' "$TRAIN" | awk -F'\t' -v k="$key" '$1==k{print $2}')"
    if ! gh api "repos/$repo/git/ref/tags/$TAG" >/dev/null 2>&1; then
      missing="$missing $repo"
    fi
  done
  [ -n "$missing" ] || break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "the tag $TAG did not appear in:$missing within ${WAIT_SECONDS}s"
    break
  fi
  sleep 10
done

for key in $(printf '%s' "$SELECTED" | tr '\n' ' '); do
  repo="$(printf '%s\n' "$TRAIN" | awk -F'\t' -v k="$key" '$1==k{print $2}')"
  log "dispatching stack-pr.yml in $repo"
  gh workflow run stack-pr.yml --repo "$repo" || log "WARNING: could not dispatch stack-pr.yml in $repo"
done

# --- 3. print the tag names and their shas ---------------------------------
log "tags:"
for key in $(printf '%s' "$SELECTED" | tr '\n' ' '); do
  repo="$(printf '%s\n' "$TRAIN" | awk -F'\t' -v k="$key" '$1==k{print $2}')"
  ref="$(gh api "repos/$repo/git/ref/tags/$TAG" 2>/dev/null || true)"
  if [ -z "$ref" ]; then
    printf '%-8s %-32s %-40s %s\n' "$key" "$repo" "$TAG" "MISSING"
    continue
  fi
  tag_sha="$(printf '%s' "$ref" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(o.object.sha)})')"
  kind="$(printf '%s' "$ref" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(o.object.type)})')"
  commit_sha="$tag_sha"
  if [ "$kind" = "tag" ]; then
    commit_sha="$(gh api "repos/$repo/git/tags/$tag_sha" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(o.object.sha)}catch{process.stdout.write("unknown")}})' || echo unknown)"
  fi
  printf '%-8s %-32s %-40s %s\n' "$key" "$repo" "$TAG" "tag=$tag_sha commit=$commit_sha"
done
