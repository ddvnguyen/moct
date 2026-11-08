#!/usr/bin/env bash
# DSH customizations deploy — installs the DSH plugin packages into ONE lane's
# web profile and applies the manifest's patches.
#
# One lane per invocation: the lane owns its profile, its artifacts and its
# backups. The script never touches another lane, never touches the PROD unit
# (dsh-prod.service on :3080) and never writes outside $DSH_ROOT.
#
# Env (all optional except LANE / PLUGINS_ROOT):
#   LANE          x | z                      required: which lane to install into
#   PLUGINS_ROOT  checkout of the plugins repo   required: where the packages are built from
#   DSH_ROOT      lane root                  default: /mnt/workspace/clouds/dsh-$LANE
#   PROFILE_DIR   lane profile dir           default: $DSH_ROOT/data/home/profiles/web
#   ARTIFACTS_DIR tarball dir                default: $DSH_ROOT/artifacts
#   DRY_RUN       1 = print the plan, change nothing   default: 0
#
#   DSH_HARNESS_DIR name of the plugins repo's harness sibling checkout
#                 default: deepseek-harness, next to the plugins checkout
#
#   PLUGINS_SHA   the plugins commit this deploy ships     default: the HEAD of
#                 the plugins checkout
#   PLUGINS_BRANCH the branch that commit came from         default: (unset)
#
# The commit names the artifact and is written into the installed package
# (build-info.json), so the lane can answer "which plugins commit am I
# running?" from a file.
#
# The plugins repo resolves its sibling harness checkout through that name (the
# type facades point at the sibling's sources). The sibling must be a real
# directory — see harness_sibling() below.
#
# The manifest (deploy/dsh-customizations.json) is the single source of truth:
# it lists the packages and the patches. Each patch names the package it
# patches and the applier that patches it; the appliers are owned by the
# PLUGINS repo (scripts/codex-ui-sidebar-patch/apply.mjs,
# scripts/dsh-market-trusted-host-patch/apply.mjs) and their paths are
# resolved against $PLUGINS_ROOT.
#
# Every patch is applied and then VERIFIED with the applier's --verify mode:
# a package left half-patched fails the deploy here, instead of reaching the
# lane.
#
# The installed version of each package is the version of the tarball that was
# just built, and the profile is restored from the snapshot whenever anything
# fails after the install step.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MANIFEST="${MANIFEST:-$REPO_ROOT/deploy/dsh-customizations.json}"

# The log goes to stderr: stdout is this script's DATA channel (the manifest
# and the packed packages are read back from it), and a log line that lands
# in that data is parsed as a package name. The deploy's output still shows
# up in the CI log - both streams are captured there.
log() { printf '[dsh-customizations %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() { printf '[dsh-customizations %s] FATAL: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit 1; }
warn() { printf '[dsh-customizations %s] WARN: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }

DRY_RUN="${DRY_RUN:-0}"

# --- 1. lane resolution and refusals ---------------------------------------
LANE="${LANE:-}"
case "$LANE" in
  x|z) : ;;
  *) die "LANE must be x or z (got '${LANE:-unset}')" ;;
esac
SERVICE="dsh-$LANE"
case "$LANE" in
  x) PORT=3181 ;;
  z) PORT=3180 ;;
esac

PLUGINS_ROOT="${PLUGINS_ROOT:-}"
[ -n "$PLUGINS_ROOT" ] || die "PLUGINS_ROOT is required (checkout of the plugins repo)"

# The plugins commit this deploy ships. The workflow resolves it before it
# checks the plugins repo out, so the checkout IS that commit; the git
# fallback covers a deploy that runs from a checkout without the env. The
# commit is not decoration: it names the artifact and it is written into the
# installed package, so the lane can answer "which plugins commit am I
# running?" from a file.
PLUGINS_SHA="${PLUGINS_SHA:-}"
PLUGINS_BRANCH="${PLUGINS_BRANCH:-}"
if [ -z "$PLUGINS_SHA" ]; then
  PLUGINS_SHA="$(git -C "$PLUGINS_ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
[ -n "$PLUGINS_SHA" ] || die "the plugins commit is unknown: set PLUGINS_SHA or check the plugins repo out from git"
printf '%s' "$PLUGINS_SHA" | grep -Eq '^[0-9a-f]{7,40}$' \
  || die "PLUGINS_SHA is not a commit sha: '$PLUGINS_SHA'"
PLUGINS_SHORT_SHA="$(printf '%s' "$PLUGINS_SHA" | cut -c1-7)"

DSH_ROOT="${DSH_ROOT:-/mnt/workspace/clouds/dsh-$LANE}"
PROFILE_DIR="${PROFILE_DIR:-$DSH_ROOT/data/home/profiles/web}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$DSH_ROOT/artifacts}"

# The PROD lane is out of scope for this script under every spelling.
case "$DSH_ROOT" in *dsh-prod*) die "refusing to touch the PROD lane root: $DSH_ROOT" ;; esac
case "$PROFILE_DIR" in *dsh-prod*) die "refusing to touch the PROD profile: $PROFILE_DIR" ;; esac
case "$PORT" in 3080) die "refusing to use the PROD port $PORT" ;; esac

# In a rehearsal the inputs are reported, not enforced: the plan must be
# printable on a machine that has neither the plugins checkout nor the lane.
require_path() { # $1 = path, $2 = what it is
  if [ ! -e "$1" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      warn "$2 is missing: $1 (rehearsal only)"
      return 0
    fi
    die "$2 is missing: $1"
  fi
}
require_path "$PLUGINS_ROOT" "PLUGINS_ROOT"
require_path "$MANIFEST" "manifest"

# A manifest written before patches[] carries the legacy single 'patch' object.
# Do not translate it silently: a manifest the script only half-understands is
# exactly the failure mode this card exists to end. The check runs before
# read_manifest, so the migration line is the only thing this run prints.
LEGACY_PATCH="$(node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(m.patch && !m.patches ? "1" : "");
' "$MANIFEST")" || die "manifest is unreadable: $MANIFEST"
[ -z "$LEGACY_PATCH" ] || die "manifest uses the legacy single 'patch' key — migrate it to 'patches[]'"

require_path "$PROFILE_DIR/package.json" "lane profile package.json"

# The profile carries its own pnpm settings in `pnpm-workspace.yaml`
# (nodeLinker, storeDir, autoInstallPeers, allowBuilds, minimumReleaseAge-
# Exclude). pnpm reads them from there, so a profile without that file
# resolves with different settings than the lockfile was written with and the
# install dies with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH or
# ERR_PNPM_IGNORED_BUILDS. A lane profile that was not bootstrapped is a
# setup error, not a deploy error: fail before anything is written.
require_path "$PROFILE_DIR/pnpm-workspace.yaml" "the lane profile's pnpm settings (pnpm-workspace.yaml)"

# --- read the manifest ------------------------------------------------------
# The manifest is the single source of truth for what gets installed. It is
# read with node (no jq dependency on the deploy host).
read_manifest() {
  node -e '
    const fs = require("node:fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const repo = (m.repos || [])[0];
    if (!repo) { console.error("manifest has no repos[] entry"); process.exit(2); }
    for (const p of repo.packages || []) console.log(`${p.name}\t${p.dir}`);
    for (const patch of m.patches || []) console.log(`#PATCH\t${patch.target}\t${patch.script}\t${patch.maxVersionExclusive || "-"}`);
  ' "$MANIFEST"
}

MANIFEST_LINES="$(read_manifest)" || die "manifest is unreadable: $MANIFEST"
PATCH_LINES="$(printf '%s\n' "$MANIFEST_LINES" | awk -F'\t' '$1=="#PATCH" && NF==4 { print $2 "\t" $3 "\t" $4 }')"
PKG_LINES="$(printf '%s\n' "$MANIFEST_LINES" | awk -F'\t' '$1!="#PATCH" && NF==2')"
[ -n "$PKG_LINES" ] || die "manifest lists no packages"
[ -n "$PATCH_LINES" ] || die "the manifest names no patches"
# The package names are used as paths under the profile's node_modules (the
# install removes the installed copy before it re-links it), so a name that is
# not a plain package name must never reach a removal. A scoped name
# (@scope/name) is one path segment deeper and is fine.
while IFS=$'\t' read -r name _dir; do
  [ -n "$name" ] || continue
  base="${name#@*/}"
  case "$base" in
    */*|*..*) die "the manifest names an unsafe package: '$name'" ;;
  esac
done <<< "$PKG_LINES"
# The appliers are owned by the plugins repo; their paths are relative to
# that checkout.
PATCH_APPLIERS=""
while IFS=$'\t' read -r target script below; do
  [ -n "${target:-}" ] || continue
  PATCH_APPLIERS="${PATCH_APPLIERS}${target}	${PLUGINS_ROOT}/${script}	${below}
"
done <<< "$PATCH_LINES"

log "lane $LANE (service $SERVICE, port $PORT)"
log "plugins root: $PLUGINS_ROOT"
log "profile: $PROFILE_DIR"
log "artifacts: $ARTIFACTS_DIR"
log "packages: $(printf '%s\n' "$PKG_LINES" | cut -f1 | tr '\n' ' ')"
log "patches:"
while IFS=$'\t' read -r target applier below; do
  [ -n "${target:-}" ] || continue
  log "  $target <- $applier (only below ${below:--})"
done <<< "$PATCH_APPLIERS"

# --- build and pack (definitions) -------------------------------------------
# The plugins repo is a pnpm workspace whose root build script compiles the
# workspace packages; the standalone package under packages/ has its own build
# script. Each package is built with its own build script and packed with
# npm pack, so the tarball is exactly what the lane installs.
install_deps() {
  log "installing the plugins repo dependencies (pnpm install --frozen-lockfile)"
  ( cd "$PLUGINS_ROOT" && pnpm install --frozen-lockfile ) || die "pnpm install failed in $PLUGINS_ROOT"
}

# The profile's lockfile pins the integrity of every installed tarball. A
# tarball is rebuilt on every deploy, so its content — and therefore its
# checksum — changes, and the stale entry makes pnpm refuse the install with
# ERR_PNPM_TARBALL_INTEGRITY ("the downloaded tarball does not match the
# integrity recorded in the lockfile"). The entries of the manifest's
# packages are therefore removed from the lockfile before the install, so pnpm
# resolves them again and records the checksum of the tarball it just built.
# The rest of the lockfile is untouched: every other dependency stays pinned.
#
# Only the `packages:` and `snapshots:` entries are removed, together with
# their body. The `importers:` section keeps the manifest's packages: that
# section says which SPEC the profile asked for, and pnpm compares it with
# package.json — a changed spec is what makes pnpm resolve the dependency
# again. Dropping the importer's entry instead leaves its `specifier:` and
# `version:` lines orphaned under `dependencies:`, which is a lockfile pnpm
# cannot read (pnpm 11 fails on it with "Cannot read properties of undefined").
strip_lock_entries() { # $1 = lockfile path
  node -e '
    const fs = require("node:fs");
    const [lockPath, namesJson] = process.argv.slice(1);
    const names = new Set(JSON.parse(namesJson));
    const lines = fs.readFileSync(lockPath, "utf8").split("\n");
    const out = [];
    let section = null;
    let dropIndent = null;
    let removed = 0;
    for (const line of lines) {
      if (dropIndent !== null) {
        const indent = line.length - line.trimStart().length;
        if (line.trim() === "") { dropIndent = null; out.push(line); continue; }
        if (indent > dropIndent) continue; // the body of the dropped entry
        dropIndent = null;
      }
      const trimmed = line.trim();
      // A top-level section header: "packages:", "snapshots:", "importers:".
      if (/^[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(trimmed)) {
        section = trimmed.slice(0, -1);
        out.push(line);
        continue;
      }
      if (section !== "packages" && section !== "snapshots") {
        out.push(line);
        continue;
      }
      let key = null;
      if (trimmed.startsWith("'"'"'")) {
        const first = trimmed.indexOf("'"'"'");
        const last = trimmed.lastIndexOf("'"'"'");
        if (last > first) key = trimmed.slice(first + 1, last);
      } else if (trimmed.startsWith("@ddvnguyen/")) {
        key = trimmed.replace(/:$/, "");
      }
      if (key !== null) {
        const base = key.split("@file:")[0];
        if (names.has(base)) {
          const indent = line.length - line.trimStart().length;
          dropIndent = indent;
          removed++;
          console.log("removed the stale lockfile entry " + key);
          continue;
        }
      }
      out.push(line);
    }
    fs.writeFileSync(lockPath, out.join("\n"));
    console.log("removed " + removed + " stale lockfile entries");
  ' "$1" "$(printf '%s\n' "$PACKED" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      const out = [];
      for (const line of s.trim().split("\n")) {
        const [name] = line.split("\t");
        if (name) out.push(name);
      }
      process.stdout.write(JSON.stringify(out));
    });')"
}

# The plugins repo compiles against a sibling `deepseek-harness` checkout: its
# tsconfig facades point at that sibling's sources, and the sibling must be a
# REAL directory. A symlink to the product checkout resolves to its real path
# and the TypeScript rootDir check then fails with TS6059 ("file is not under
# rootDir"), because the facades and the program disagree about the root.
# The lane deploy therefore checks the product out as a real directory named
# `deepseek-harness`, next to the plugins checkout.
harness_sibling() {
  local name="${DSH_HARNESS_DIR:-deepseek-harness}"
  local dir
  dir="$(cd "$PLUGINS_ROOT/.." && pwd)/$name"
  [ -d "$dir" ] || die "the plugins repo needs its harness sibling '$name' at $dir (the lane deploy checks the product out there); it is missing"
  printf '%s' "$dir"
}

# The plugins repo's own build recipe, in the order its CI uses it: link the
# harness packages into the repo, regenerate the tsconfig facades against the
# sibling, then build.
prepare_plugins_repo() {
  local repo="$PLUGINS_ROOT"
  # The output goes to stderr: build_and_pack's stdout is its RESULT (the
  # "<name>\t<version>\t<tarball>" record the install loops parse), so a line
  # a child prints on stdout becomes a bogus package record - the first live
  # deploy read "linked 351 sibling packages into node_modules" as a package
  # name and died comparing a tarball that was the empty string.
  if [ -f "$repo/scripts/link-harness-packages.mjs" ]; then
    log "linking the harness packages into the plugins repo"
    ( cd "$repo" && node scripts/link-harness-packages.mjs ) >&2 || die "link-harness-packages.mjs failed"
  fi
  if [ -f "$repo/scripts/sync-paths.mjs" ]; then
    log "regenerating the tsconfig path facades against the harness sibling"
    ( cd "$repo" && node scripts/sync-paths.mjs ) >&2 || die "sync-paths.mjs failed"
  fi
}

build_and_pack() { # $1 = manifest dir, $2 = package name -> "<name>\t<version>\t<tarball>"
  local dir="$1" name="$2" pkg_dir="$PLUGINS_ROOT/$1" version tarball packed
  [ -d "$pkg_dir" ] || die "package directory not found: $pkg_dir (for $name)"
  [ -f "$pkg_dir/package.json" ] || die "no package.json in $pkg_dir (for $name)"
  version="$(node -p "require('$pkg_dir/package.json').version")" || die "cannot read the version of $name"
  # The repo root package builds the workspace (its own build script compiles
  # every workspace package, the Team Room bundle and the sidebar plugin), so
  # it runs the repo's recipe first.
  if [ "$dir" = "." ]; then
    prepare_plugins_repo
  fi
  if node -e 'const p=require(process.argv[1]);process.exit(p.scripts&&p.scripts.build?0:1)' "$pkg_dir/package.json"; then
    log "building $name ($dir)"
    ( cd "$pkg_dir" && npm run build ) >&2 || die "build failed for $name in $pkg_dir"
  else
    log "no build script for $name ($dir) - packing as is"
  fi
  mkdir -p "$ARTIFACTS_DIR"
  # npm pack prints the tarball name it wrote; the scripts are skipped because
  # the build above already produced the artifacts.
  #
  # The pack goes into a private dir INSIDE the artifacts dir, never into the
  # dir itself. `npm pack` writes `<name>-<version>.tgz`, and the profile may
  # still point at an artifact of exactly that name from the previous build of
  # the same version: packing in place overwrote it, and the rename below then
  # removed it. That destroyed the rollback's source - the first live deploy
  # failed, its rollback found no tarball to restore and left the lane's
  # profile missing packages. Only the sha-stamped name lands in the artifacts
  # dir, and an existing file is never touched.
  pack_dir="$(mktemp -d "$ARTIFACTS_DIR/.pkg-pack-XXXXXX")" || die "cannot create a pack dir in $ARTIFACTS_DIR"
  packed="$( cd "$pkg_dir" && npm pack --ignore-scripts --pack-destination "$pack_dir" | tail -n 1 )" \
    || { rm -rf "$pack_dir"; die "npm pack failed for $name in $pkg_dir"; }
  case "$packed" in
    *.tgz) : ;;
    *) rm -rf "$pack_dir"; die "npm pack did not report a tarball for $name (got '$packed')" ;;
  esac
  tarball="$pack_dir/$(basename "$packed")"
  [ -f "$tarball" ] || die "the packed tarball is missing: $tarball"
  # The artifact is named by the plugins COMMIT, not by the version alone.
  # The version of a plugin only moves on a release commit, so two different
  # builds would write the same path with different content - and the
  # profile's lockfile pins that path by integrity, so the lane would keep
  # serving the bytes of the previous build. The commit moves the path with
  # the content, so the lockfile can never pin a stale copy of a path whose
  # content changed.
  stamped="$ARTIFACTS_DIR/$(basename "$packed" .tgz)-$PLUGINS_SHORT_SHA.tgz"
  mv "$tarball" "$stamped" || die "cannot rename the tarball to $stamped"
  rm -rf "$pack_dir"
  tarball="$stamped"
  # The artifact carries the build it was made from: the marker is written
  # INTO the tarball, so the installed package carries it too and the lane
  # can answer "which plugins commit am I running?" from a file.
  build_info="$(mktemp)"
  node -e '
    const fs = require("node:fs");
    const [out, name, version, sha, branch, artifact] = process.argv.slice(1);
    fs.writeFileSync(out, JSON.stringify({
      package: name,
      version,
      pluginsSha: sha,
      pluginsShortSha: sha.slice(0, 7),
      pluginsBranch: branch || null,
      builtAt: new Date().toISOString(),
      artifact,
    }, null, 2) + "\n");
  ' "$build_info" "$name" "$version" "$PLUGINS_SHA" "$PLUGINS_BRANCH" "$(basename "$tarball")" \
    || die "cannot write the build info of $name"
  node "$SCRIPT_DIR/package-artifact.mjs" inject "$tarball" "$build_info" \
    || die "cannot write the build info into $tarball"
  rm -f "$build_info"
  log "packed $name $version (plugins $PLUGINS_SHORT_SHA) -> $tarball"
  printf '%s\t%s\t%s\n' "$name" "$version" "$tarball"
}

if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN=1 - plan only, nothing on disk changes"
  log "plugins commit: $PLUGINS_SHA"
  log "would install the plugins repo dependencies in $PLUGINS_ROOT"
  while IFS=$'\t' read -r name dir; do
    [ -n "$name" ] || continue
    log "would build and pack $name from $PLUGINS_ROOT/$dir into $ARTIFACTS_DIR as <name>-<version>-$PLUGINS_SHORT_SHA.tgz"
  done <<< "$PKG_LINES"
  log "would write the build info (plugins $PLUGINS_SHORT_SHA) into every artifact"
  log "would snapshot $PROFILE_DIR/package.json and pnpm-lock.yaml into $DSH_ROOT/data/backups/customizations-<timestamp>/"
  log "would rewrite the file: dependencies of: $(printf '%s\n' "$PKG_LINES" | cut -f1 | tr '\n' ' ')"
  log "would REMOVE the obsolete @ddvnguyen/* profile dependencies that the manifest does not list"
  log "would REMOVE the installed copies of the manifest's packages so pnpm re-links this build"
  log "would run pnpm install in $PROFILE_DIR"
  log "would compare every installed package with the artifact it was installed from"
  while IFS=$'\t' read -r target applier below; do
    [ -n "${target:-}" ] || continue
    log "would apply $applier (skipped when the installed $target is >= ${below:--}) to $PROFILE_DIR/node_modules/$target"
    log "would verify that $PROFILE_DIR/node_modules/$target carries its patch"
  done <<< "$PATCH_APPLIERS"
  log "would verify every package version and print the package -> version table"
  log "would print the plugins commit the lane runs"
  exit 0
fi

# --- 2. snapshot the profile ------------------------------------------------
# The snapshot is taken BEFORE the build and pack. The artifacts the profile
# points at are replaced by this run's build - a redeploy of the same plugins
# sha rewrites the same path - so the rollback source has to be a COPY, not
# the path. Taking it after the pack (as the first version did) meant the
# tarball had already been overwritten and renamed away, the copy was skipped,
# and the rollback had nothing to restore: the failed deploy left the lane's
# profile without its packages.
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$DSH_ROOT/data/backups/customizations-$TS"
mkdir -p "$BACKUP_DIR/artifacts" || die "cannot create the backup dir: $BACKUP_DIR"
cp "$PROFILE_DIR/package.json" "$BACKUP_DIR/package.json" || die "cannot snapshot package.json"
if [ -f "$PROFILE_DIR/pnpm-lock.yaml" ]; then
  cp "$PROFILE_DIR/pnpm-lock.yaml" "$BACKUP_DIR/pnpm-lock.yaml" || die "cannot snapshot pnpm-lock.yaml"
fi
# The tarballs themselves are part of the profile: the manifest points at
# them by path and the lockfile pins their checksum. A tarball the profile
# references but that is not on disk is an already-inconsistent profile (a
# previous run renamed the artifact away and died before rewriting the spec).
# The deploy still proceeds - replacing that dependency is exactly what it is
# for - but the warning is loud, because a rollback has no copy to restore.
: > "$BACKUP_DIR/tarballs.tsv"
node -e '
  const fs = require("node:fs");
  const [pkgPath, listPath] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies);
  const out = [];
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
    out.push(name + "\t" + spec.slice("file:".length));
  }
  fs.writeFileSync(listPath, out.join("\n") + (out.length ? "\n" : ""));
' "$PROFILE_DIR/package.json" "$BACKUP_DIR/tarballs.tsv" || die "cannot list the profile's tarballs"
while IFS=$'\t' read -r pkg_name tarball_path; do
  [ -n "${tarball_path:-}" ] || continue
  if [ ! -f "$tarball_path" ]; then
    warn "the profile references a tarball that does not exist: $tarball_path - this deploy replaces it, but a rollback cannot restore $pkg_name"
    continue
  fi
  cp "$tarball_path" "$BACKUP_DIR/artifacts/$(basename "$tarball_path")" \
    || die "cannot snapshot the tarball $tarball_path"
done < "$BACKUP_DIR/tarballs.tsv"
log "snapshot of the profile in $BACKUP_DIR"

install_deps

PACKED=""
while IFS=$'\t' read -r name dir; do
  [ -n "$name" ] || continue
  PACKED="$PACKED$(build_and_pack "$dir" "$name")
"
done <<< "$PKG_LINES"
[ -n "$PACKED" ] || die "no package was packed"
# build_and_pack's stdout is its RESULT. Anything else on it is a child that
# wrote to stdout, and parsing it as a package record is how the first live
# deploy compared an empty tarball path. Fail with the offending line instead.
BAD_RECORD="$(printf '%s\n' "$PACKED" | awk -F'\t' 'NF != 3 { print; exit }')"
[ -z "$BAD_RECORD" ] \
  || die "the pack step wrote a line that is not a package record (a child wrote to stdout?): '$BAD_RECORD'"

# --- rollback (definitions) -------------------------------------------------
# Wired to the EXIT trap, not ERR: `die` calls `exit 1` and bash does not run
# an ERR trap for `exit`, so an ERR-only rollback would miss every failure
# after the install step. The rollback decision lives in on_exit and it runs
# BEFORE the script returns, so the profile is never left half-installed.
INSTALLED=0
ROLLED_BACK=0
rollback() {
  [ "$INSTALLED" = "1" ] || return 0
  [ "$ROLLED_BACK" = "1" ] && return 0
  ROLLED_BACK=1
  log "ROLLING BACK: restoring package.json and pnpm-lock.yaml from $BACKUP_DIR"
  cp "$BACKUP_DIR/package.json" "$PROFILE_DIR/package.json" || log "FATAL: could not restore package.json"
  # The tarballs go back first: the restored manifest points at them by path
  # and the restored lockfile pins their checksum, so an install that sees the
  # new tarball under the old name would fail the integrity check.
  if [ -f "$BACKUP_DIR/tarballs.tsv" ]; then
    while IFS=$'\t' read -r pkg_name tarball_path; do
      [ -n "${tarball_path:-}" ] || continue
      saved="$BACKUP_DIR/artifacts/$(basename "$tarball_path")"
      [ -f "$saved" ] || continue
      cp "$saved" "$tarball_path" || log "FATAL: could not restore the tarball $tarball_path"
    done < "$BACKUP_DIR/tarballs.tsv"
  fi
  # A patch target may have been touched by a failed patch run: every one of
  # them is removed here and reinstalled from the restored lockfile, so the
  # profile carries the unpatched packages again.
  while IFS=$'\t' read -r target applier; do
    [ -n "${target:-}" ] || continue
    if [ -d "$PROFILE_DIR/node_modules/$target" ]; then
      rm -rf "$PROFILE_DIR/node_modules/$target" \
        || log "FATAL: could not remove the patched $target"
    fi
  done <<< "$PATCH_APPLIERS"
  # The manifest's packages are removed too: the install of this run removed
  # them before it linked the new build, and pnpm reuses an import whose path
  # did not move. Removing them makes the restoring install link the bytes of
  # the restored lockfile - the build the profile ran before this deploy.
  while IFS=$'\t' read -r name _rest; do
    [ -n "$name" ] || continue
    if [ -d "$PROFILE_DIR/node_modules/$name" ]; then
      rm -rf "$PROFILE_DIR/node_modules/$name" \
        || log "FATAL: could not remove the installed $name"
    fi
  done <<< "$PACKED"
  # pnpm's current-state lock describes the install THIS run made. When the
  # tarball path did not move - a redeploy of the same plugins sha rewrites
  # the same `-<sha7>.tgz` - it still records the new build's integrity for
  # that path, and a frozen install against the restored lockfile dies with
  # ERR_PNPM_TARBALL_INTEGRITY even though the restored tarball is correct.
  # Dropping it makes pnpm resolve the restored lockfile from scratch.
  rm -f "$PROFILE_DIR/node_modules/.pnpm/lock.yaml" \
    || log "FATAL: could not drop the current-state lock"
  if [ -f "$BACKUP_DIR/pnpm-lock.yaml" ]; then
    cp "$BACKUP_DIR/pnpm-lock.yaml" "$PROFILE_DIR/pnpm-lock.yaml" || log "FATAL: could not restore pnpm-lock.yaml"
    ( cd "$PROFILE_DIR" && pnpm install --frozen-lockfile ) \
      || log "FATAL: the rollback install failed - the profile must be repaired by hand"
  else
    # The profile had no lockfile before this run: the one the failed install
    # wrote describes the new tarballs and no longer matches the restored
    # package.json, so it goes away with them.
    rm -f "$PROFILE_DIR/pnpm-lock.yaml"
    ( cd "$PROFILE_DIR" && pnpm install --no-frozen-lockfile ) \
      || log "FATAL: the rollback install failed - the profile must be repaired by hand"
  fi
  # The rollback is only as good as what it left behind, so it asserts the
  # package set it restored instead of assuming the install did it.
  #
  # Every patched target must be back in the profile: the rollback removed it
  # before the restoring install, and a target that was only a transitive
  # dependency is NOT put back by pnpm - that profile cannot run the lane.
  RESTORE_OK=1
  while IFS=$'\t' read -r target applier; do
    [ -n "${target:-}" ] || continue
    if [ ! -d "$PROFILE_DIR/node_modules/$target" ]; then
      log "FATAL: rollback left $target missing from the profile"
      RESTORE_OK=0
    fi
  done <<< "$PATCH_APPLIERS"
  # The manifest's packages must be back when the profile ran them before
  # this deploy: the rollback removed them before the restoring install, so
  # a package that stayed missing means the profile cannot run the lane. A
  # package the profile did not depend on before this deploy is not expected
  # back - the snapshot says what the profile looked like.
  while IFS=$'\t' read -r name _rest; do
    [ -n "$name" ] || continue
    WAS_DEPENDED="$(node -e '
const fs = require("node:fs");
const [pkgPath, name] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies);
process.stdout.write(deps[name] ? "1" : "");
' "$BACKUP_DIR/package.json" 2>/dev/null || true)"
    [ "$WAS_DEPENDED" = "1" ] || continue
    if [ ! -d "$PROFILE_DIR/node_modules/$name" ]; then
      log "FATAL: rollback left $name missing from the profile"
      RESTORE_OK=0
    fi
  done <<< "$PACKED"
  # dshmarket is pinned exactly by the restored package.json, so the restored
  # version is a string compare against that pin. A pin that is not an exact
  # version (a range) cannot be compared with a string, and the check is
  # skipped for it rather than reporting a mismatch it cannot judge.
  WANT_DSHMARKET="$(node -e '
const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const spec = (p.dependencies && p.dependencies.dshmarket) || (p.devDependencies && p.devDependencies.dshmarket) || "";
process.stdout.write(spec);
' "$PROFILE_DIR/package.json" 2>/dev/null || true)"
  if [ -n "$WANT_DSHMARKET" ] && ! printf '%s' "$WANT_DSHMARKET" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+'; then
    warn "the profile pins dshmarket as '$WANT_DSHMARKET' - not an exact version, so the restored version is not compared"
    WANT_DSHMARKET=""
  fi
  if [ -n "$WANT_DSHMARKET" ]; then
    GOT_DSHMARKET="$(node -e '
const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(p.version || "");
' "$PROFILE_DIR/node_modules/dshmarket/package.json" 2>/dev/null || true)"
    if [ "$GOT_DSHMARKET" != "$WANT_DSHMARKET" ]; then
      log "FATAL: rollback restored dshmarket ${GOT_DSHMARKET:-<missing>}, package.json pins $WANT_DSHMARKET"
      RESTORE_OK=0
    fi
  fi
  if [ "$RESTORE_OK" = "1" ]; then
    log "rollback done: the profile is back at the state of $BACKUP_DIR"
  fi
}
on_exit() {
  local code=$?
  if [ "$code" != "0" ] && [ "$INSTALLED" = "1" ] && [ "$ROLLED_BACK" = "0" ]; then
    rollback
  fi
  return $code
}
trap on_exit EXIT

# --- rewrite the file: dependencies (definition) ----------------------------
# The profile pins the plugins as file: tarballs; the rewrite points them at
# the tarballs that were just built. A @ddvnguyen/* dependency the manifest
# does not list is obsolete (the old @ddvnguyen/dsh-side-menu and
# @ddvnguyen/dsh-hide-im-assistant entries) and is REMOVED: the profile must
# carry exactly the manifest's package set.
rewrite_deps() {
  node -e '
    const fs = require("node:fs");
    const [pkgPath, pairsJson] = process.argv.slice(1);
    const pairs = Object.entries(JSON.parse(pairsJson));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const wanted = new Set(pairs.map(([name]) => name));
    let changed = 0;
    let removed = 0;
    for (const [name, tarball] of pairs) {
      let hit = false;
      for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
        if (pkg[field] && typeof pkg[field][name] === "string") {
          pkg[field][name] = "file:" + tarball;
          hit = true;
          changed++;
        }
      }
      if (!hit) {
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies[name] = "file:" + tarball;
        changed++;
      }
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (!pkg[field]) continue;
      for (const name of Object.keys(pkg[field])) {
        if (!name.startsWith("@ddvnguyen/")) continue;
        if (wanted.has(name)) continue;
        delete pkg[field][name];
        removed++;
        console.log("removed obsolete dependency " + name + " from " + field);
      }
    }
    // The profile also lists its bundles: `dsh.profile.bundles` names the
    // packages the DSH loads at boot. An obsolete entry there is not a
    // warning-free leftover - the boot logs "skipping profile bundle" for it
    // and the plugin never loads. The bundle list is pruned with the
    // dependencies.
    const bundles = pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
    if (Array.isArray(bundles)) {
      const kept = bundles.filter((name) => {
        if (!name.startsWith("@ddvnguyen/")) return true;
        if (wanted.has(name)) return true;
        removed++;
        console.log("removed obsolete profile bundle " + name);
        return false;
      });
      // Every package of the manifest must also be listed as a bundle: the
      // DSH loads a plugin row from that list, and a package that is
      // installed but not listed never loads.
      for (const name of wanted) {
        if (!kept.includes(name)) {
          kept.push(name);
          changed++;
          console.log("added profile bundle " + name);
        }
      }
      pkg.dsh.profile.bundles = kept;
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log("rewrote " + changed + " dependency entries, removed " + removed + " obsolete ones");
  ' "$PROFILE_DIR/package.json" "$(printf '%s\n' "$PACKED" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      const out = {};
      for (const line of s.trim().split("\n")) {
        const [name, , tarball] = line.split("\t");
        if (name) out[name] = tarball;
      }
      process.stdout.write(JSON.stringify(out));
    });')"
}

# --- 3. rewrite the file: dependencies and install --------------------------
log "rewriting the file: dependency entries in $PROFILE_DIR/package.json"
rewrite_deps || die "could not rewrite the profile dependencies"
if [ -f "$PROFILE_DIR/pnpm-lock.yaml" ]; then
  log "dropping the stale lockfile entries of the manifest's packages"
  strip_lock_entries "$PROFILE_DIR/pnpm-lock.yaml" || die "could not strip the stale lockfile entries"
fi
INSTALLED=1
# The install must REPLACE the manifest's packages, not reuse what is
# installed. pnpm's import of a `file:` tarball is keyed by its PATH: a
# tarball whose path did not move keeps the previously imported bytes, so the
# lane runs the previous build while the lockfile and the artifact both look
# current. The installed copy is therefore removed before the install - the
# same thing the rollback path does - so pnpm re-links the bytes of the
# tarball that was just built. strip_lock_entries above makes pnpm resolve
# the dependency again; this makes it re-link it.
log "removing the installed copies so pnpm re-links this build"
while IFS=$'\t' read -r name _rest; do
  [ -n "$name" ] || continue
  installed_dir="$PROFILE_DIR/node_modules/$name"
  case "$installed_dir" in
    "$PROFILE_DIR"/node_modules/*) : ;;
    *) die "refusing to remove $installed_dir (outside the profile)" ;;
  esac
  if [ -e "$installed_dir" ]; then
    rm -rf "$installed_dir" || die "cannot remove the installed $name ($installed_dir)"
    log "removed the installed $name"
  fi
done <<< "$PACKED"
log "installing the profile"
( cd "$PROFILE_DIR" && pnpm install --no-frozen-lockfile ) || die "pnpm install failed in $PROFILE_DIR"

# The proof that the lane runs the build this deploy produced is the
# CONTENT: the installed package must carry the bytes of the artifact it was
# installed from. A version equality is not evidence of a correct deploy -
# the version of a plugin only moves on a release commit, so a stale install
# and a good one carry the same version. The check runs before the patches,
# which change the installed bytes on purpose and have their own --verify.
log "comparing the installed packages with the artifacts"
while IFS=$'\t' read -r name _version tarball; do
  [ -n "$name" ] || continue
  node "$SCRIPT_DIR/package-artifact.mjs" verify "$tarball" "$PROFILE_DIR/node_modules/$name" \
    || die "the installed $name does not carry the build in $(basename "$tarball") - the profile was restored to its previous state"
  log "$name carries the bytes of $(basename "$tarball")"
done <<< "$PACKED"

# --- 4. apply the patches ----------------------------------------------------
# Every patch in the manifest is applied in turn and then VERIFIED: the
# applier's --verify mode asserts that the installed package carries its
# patch. A package that was left half-patched - an applier that wrote one
# file and stopped, a package that was already patched in a way this applier
# does not recognise - fails the deploy here instead of reaching the lane.
while IFS=$'\t' read -r target applier below; do
  [ -n "${target:-}" ] || continue
  patch_dir="$PROFILE_DIR/node_modules/$target"
  [ -d "$patch_dir" ] || die "patch target not installed: $patch_dir"
  # A patch may declare maxVersionExclusive: the first target version it is
  # NOT written for. An installed target at or above it is skipped loudly
  # (the patch is for an older bundle layout); below it, a missing anchor
  # still fails the deploy.
  if [ "${below:--}" != "-" ]; then
    installed_version="$(node -p 'require(process.argv[1]).version' "$patch_dir/package.json")" \
      || die "cannot read the installed $target version"
    if node -e '
      const parse = (v) => String(v).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
      const [a, b] = [parse(process.argv[1]), parse(process.argv[2])];
      for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) process.exit((a[i] || 0) > (b[i] || 0) ? 0 : 1); }
      process.exit(0);
    ' "$installed_version" "$below"; then
      log "SKIPPING the $target patch: installed $target $installed_version is >= $below, the version this patch is not written for"
      continue
    fi
  fi
  require_path "$applier" "the patch applier for $target"
  log "applying the $target patch: $applier $patch_dir"
  case "$applier" in
    *.mjs|*.js) node "$applier" "$patch_dir" || die "the $target patch failed (moved anchor?) - the profile was restored to its previous state" ;;
    *) "$applier" "$patch_dir" || die "the $target patch failed (moved anchor?) - the profile was restored to its previous state" ;;
  esac
  log "verifying the $target patch"
  case "$applier" in
    *.mjs|*.js) node "$applier" "$patch_dir" --verify || die "the $target patch is not fully applied - the profile was restored to its previous state" ;;
    *) "$applier" "$patch_dir" --verify || die "the $target patch is not fully applied - the profile was restored to its previous state" ;;
  esac
  log "$target patch applied and verified"
done <<< "$PATCH_APPLIERS"

# --- 5. verify --------------------------------------------------------------
# Every package of the manifest must be in the profile package.json AND
# resolvable in the profile's node_modules at the expected version, the
# profile must carry NO @ddvnguyen/* dependency outside the manifest, and
# every installed package must name the plugins commit this deploy shipped.
verify() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [profile, pairsJson, sha] = process.argv.slice(1);
    const pairs = Object.entries(JSON.parse(pairsJson));
    const pkg = JSON.parse(fs.readFileSync(path.join(profile, "package.json"), "utf8"));
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies);
    let bad = 0;
    const rows = [];
    for (const [name, version] of pairs) {
      const spec = deps[name];
      const installedPath = path.join(profile, "node_modules", name, "package.json");
      let installed = null;
      if (fs.existsSync(installedPath)) installed = JSON.parse(fs.readFileSync(installedPath, "utf8")).version;
      // The build marker names the commit the installed package was built
      // from. It is the answer to "which plugins commit am I running?", and
      // a marker that names another commit means the profile still runs an
      // older build.
      const markerPath = path.join(profile, "node_modules", name, "build-info.json");
      let built = null;
      if (fs.existsSync(markerPath)) {
        try { built = JSON.parse(fs.readFileSync(markerPath, "utf8")).pluginsSha || null; } catch { built = null; }
      }
      const ok = installed === version && typeof spec === "string";
      const buildOk = built === sha;
      if (!ok) bad++;
      if (!buildOk) {
        bad++;
        console.log("STALE BUILD  " + name + " was built from " + (built || "an unknown commit") + ", this deploy ships " + sha);
      }
      rows.push([name, version, installed || "MISSING", (built || "MISSING").slice(0, 7), spec || "MISSING", ok && buildOk ? "ok" : "FAIL"]);
    }
    const w = [0,1,2,3,4,5].map(i => Math.max(...rows.map(r => r[i].length), 4));
    const fmt = r => r.map((c, i) => String(c).padEnd(w[i])).join("  ");
    console.log(fmt(["package", "expected", "installed", "build", "spec", "state"]));
    console.log(w.map(n => "-".repeat(n)).join("  "));
    for (const r of rows) console.log(fmt(r));
    // The @ddvnguyen scope must match the manifest exactly: an extra entry is
    // an obsolete package left in the profile, and that is a deploy failure.
    const wanted = new Set(pairs.map(([name]) => name));
    const extra = Object.keys(deps).filter(n => n.startsWith("@ddvnguyen/") && !wanted.has(n));
    for (const name of extra) {
      console.log("OBSOLETE  " + name + " is still in the profile and is not in the manifest");
      bad++;
    }
    // The bundle list names the packages the DSH loads at boot: an obsolete
    // entry there boots as "skipping profile bundle" and never loads.
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    for (const name of bundles) {
      if (!name.startsWith("@ddvnguyen/")) continue;
      if (wanted.has(name)) continue;
      console.log("OBSOLETE BUNDLE  " + name + " is still in dsh.profile.bundles and is not in the manifest");
      bad++;
    }
    for (const [name] of pairs) {
      if (!bundles.includes(name)) {
        console.log("MISSING BUNDLE  " + name + " is installed but not listed in dsh.profile.bundles");
        bad++;
      }
    }
    process.exit(bad ? 1 : 0);
  ' "$PROFILE_DIR" "$(printf '%s\n' "$PACKED" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      const out = {};
      for (const line of s.trim().split("\n")) {
        const [name, version] = line.split("\t");
        if (name) out[name] = version;
      }
      process.stdout.write(JSON.stringify(out));
    });')" "$PLUGINS_SHA"
}

verify || die "verification failed: a manifest package is not installed at the expected version, an obsolete @ddvnguyen package is still in the profile, or a package was not built from the plugins commit this deploy ships"
log "every manifest package is installed at the expected version and was built from $PLUGINS_SHORT_SHA"
log "the lane runs the plugins commit $PLUGINS_SHA"
log "customizations deploy complete for lane $LANE"
