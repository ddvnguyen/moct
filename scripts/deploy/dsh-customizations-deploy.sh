#!/usr/bin/env bash
# DSH customizations deploy — installs the DSH plugin packages into ONE lane's
# web profile and applies the codex-ui sidebar patch.
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
# The plugins repo resolves its sibling harness checkout through that name (the
# type facades point at the sibling's sources). The sibling must be a real
# directory — see harness_sibling() below.
#
# The manifest (deploy/dsh-customizations.json) is the single source of truth:
# it lists the packages, the patch target and the patch script. The codex-ui
# applier is owned by the PLUGINS repo (scripts/codex-ui-sidebar-patch/
# apply.mjs) and its path is resolved against $PLUGINS_ROOT.
#
# The installed version of each package is the version of the tarball that was
# just built, and the profile is restored from the snapshot whenever anything
# fails after the install step.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MANIFEST="${MANIFEST:-$REPO_ROOT/deploy/dsh-customizations.json}"

log() { printf '[dsh-customizations %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
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
    const patch = m.patch || {};
    console.log(`#PATCH\t${patch.target || "@michengai/dsh-codex-ui"}`);
    console.log(`#PATCHSCRIPT\t${patch.script || ""}`);
  ' "$MANIFEST"
}

MANIFEST_LINES="$(read_manifest)" || die "manifest is unreadable: $MANIFEST"
PATCH_TARGET="$(printf '%s\n' "$MANIFEST_LINES" | awk -F'\t' '$1=="#PATCH"{print $2}')"
PATCH_TARGET="${PATCH_TARGET:-@michengai/dsh-codex-ui}"
PATCH_SCRIPT="$(printf '%s\n' "$MANIFEST_LINES" | awk -F'\t' '$1=="#PATCHSCRIPT"{print $2}')"
PKG_LINES="$(printf '%s\n' "$MANIFEST_LINES" | awk -F'\t' '$1!="#PATCH" && $1!="#PATCHSCRIPT" && NF==2')"
[ -n "$PKG_LINES" ] || die "manifest lists no packages"
[ -n "$PATCH_SCRIPT" ] || die "the manifest names no patch script"
# The applier is owned by the plugins repo; its path is relative to that
# checkout.
PATCH_APPLIER="$PLUGINS_ROOT/$PATCH_SCRIPT"

log "lane $LANE (service $SERVICE, port $PORT)"
log "plugins root: $PLUGINS_ROOT"
log "profile: $PROFILE_DIR"
log "artifacts: $ARTIFACTS_DIR"
log "packages: $(printf '%s\n' "$PKG_LINES" | cut -f1 | tr '\n' ' ')"
log "patch target: $PATCH_TARGET"
log "patch script: $PATCH_APPLIER"

# --- 2. build and pack ------------------------------------------------------
# The plugins repo is a pnpm workspace whose root build script compiles the
# workspace packages; the standalone package under packages/ has its own build
# script. Each package is built with its own build script and packed with
# npm pack, so the tarball is exactly what the lane installs.
install_deps() {
  log "installing the plugins repo dependencies (pnpm install --frozen-lockfile)"
  ( cd "$PLUGINS_ROOT" && pnpm install --frozen-lockfile ) || die "pnpm install failed in $PLUGINS_ROOT"
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
  if [ -f "$repo/scripts/link-harness-packages.mjs" ]; then
    log "linking the harness packages into the plugins repo"
    ( cd "$repo" && node scripts/link-harness-packages.mjs ) || die "link-harness-packages.mjs failed"
  fi
  if [ -f "$repo/scripts/sync-paths.mjs" ]; then
    log "regenerating the tsconfig path facades against the harness sibling"
    ( cd "$repo" && node scripts/sync-paths.mjs ) || die "sync-paths.mjs failed"
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
    ( cd "$pkg_dir" && npm run build ) || die "build failed for $name in $pkg_dir"
  else
    log "no build script for $name ($dir) - packing as is"
  fi
  mkdir -p "$ARTIFACTS_DIR"
  # npm pack prints the tarball name it wrote; the scripts are skipped because
  # the build above already produced the artifacts.
  packed="$( cd "$pkg_dir" && npm pack --ignore-scripts --pack-destination "$ARTIFACTS_DIR" | tail -n 1 )" \
    || die "npm pack failed for $name in $pkg_dir"
  case "$packed" in
    *.tgz) : ;;
    *) die "npm pack did not report a tarball for $name (got '$packed')" ;;
  esac
  tarball="$ARTIFACTS_DIR/$(basename "$packed")"
  [ -f "$tarball" ] || die "the packed tarball is missing: $tarball"
  log "packed $name $version -> $tarball"
  printf '%s\t%s\t%s\n' "$name" "$version" "$tarball"
}

if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN=1 - plan only, nothing on disk changes"
  log "would install the plugins repo dependencies in $PLUGINS_ROOT"
  while IFS=$'\t' read -r name dir; do
    [ -n "$name" ] || continue
    log "would build and pack $name from $PLUGINS_ROOT/$dir into $ARTIFACTS_DIR"
  done <<< "$PKG_LINES"
  log "would snapshot $PROFILE_DIR/package.json and pnpm-lock.yaml into $DSH_ROOT/data/backups/customizations-<timestamp>/"
  log "would rewrite the file: dependencies of: $(printf '%s\n' "$PKG_LINES" | cut -f1 | tr '\n' ' ')"
  log "would REMOVE the obsolete @ddvnguyen/* profile dependencies that the manifest does not list"
  log "would run pnpm install in $PROFILE_DIR"
  log "would apply $PATCH_APPLIER to $PROFILE_DIR/node_modules/$PATCH_TARGET"
  log "would verify every package version and print the package -> version table"
  exit 0
fi

install_deps

PACKED=""
while IFS=$'\t' read -r name dir; do
  [ -n "$name" ] || continue
  PACKED="$PACKED$(build_and_pack "$dir" "$name")
"
done <<< "$PKG_LINES"
[ -n "$PACKED" ] || die "no package was packed"

# --- 3. snapshot the profile ------------------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$DSH_ROOT/data/backups/customizations-$TS"
mkdir -p "$BACKUP_DIR" || die "cannot create the backup dir: $BACKUP_DIR"
cp "$PROFILE_DIR/package.json" "$BACKUP_DIR/package.json" || die "cannot snapshot package.json"
if [ -f "$PROFILE_DIR/pnpm-lock.yaml" ]; then
  cp "$PROFILE_DIR/pnpm-lock.yaml" "$BACKUP_DIR/pnpm-lock.yaml" || die "cannot snapshot pnpm-lock.yaml"
fi
log "snapshot of the profile in $BACKUP_DIR"

# --- rollback ---------------------------------------------------------------
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
  # The patch target may have been touched by a failed patch run: it is
  # removed here and reinstalled from the restored lockfile, so the profile
  # carries the unpatched package again.
  if [ -d "$PROFILE_DIR/node_modules/$PATCH_TARGET" ]; then
    rm -rf "$PROFILE_DIR/node_modules/$PATCH_TARGET" \
      || log "FATAL: could not remove the patched $PATCH_TARGET"
  fi
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
  log "rollback done: the profile is back at the state of $BACKUP_DIR"
}
on_exit() {
  local code=$?
  if [ "$code" != "0" ] && [ "$INSTALLED" = "1" ] && [ "$ROLLED_BACK" = "0" ]; then
    rollback
  fi
  return $code
}
trap on_exit EXIT

# --- 4. rewrite the file: dependencies and install --------------------------
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

log "rewriting the file: dependency entries in $PROFILE_DIR/package.json"
rewrite_deps || die "could not rewrite the profile dependencies"
INSTALLED=1
log "installing the profile"
( cd "$PROFILE_DIR" && pnpm install --no-frozen-lockfile ) || die "pnpm install failed in $PROFILE_DIR"

# --- 5. apply the codex-ui patch -------------------------------------------
PATCH_DIR="$PROFILE_DIR/node_modules/$PATCH_TARGET"
[ -d "$PATCH_DIR" ] || die "patch target not installed: $PATCH_DIR"
require_path "$PATCH_APPLIER" "the codex-ui patch applier"
log "applying the codex-ui patch: $PATCH_APPLIER $PATCH_DIR"
case "$PATCH_APPLIER" in
  *.mjs|*.js) node "$PATCH_APPLIER" "$PATCH_DIR" || die "the codex-ui patch failed (moved anchor?) - the profile was restored to its previous state" ;;
  *) "$PATCH_APPLIER" "$PATCH_DIR" || die "the codex-ui patch failed (moved anchor?) - the profile was restored to its previous state" ;;
esac
log "codex-ui patch applied"

# --- 6. verify --------------------------------------------------------------
# Every package of the manifest must be in the profile package.json AND
# resolvable in the profile's node_modules at the expected version, and the
# profile must carry NO @ddvnguyen/* dependency outside the manifest.
verify() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [profile, pairsJson] = process.argv.slice(1);
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
      const ok = installed === version && typeof spec === "string";
      if (!ok) bad++;
      rows.push([name, version, installed || "MISSING", spec || "MISSING", ok ? "ok" : "FAIL"]);
    }
    const w = [0,1,2,3,4].map(i => Math.max(...rows.map(r => r[i].length), 4));
    const fmt = r => r.map((c, i) => String(c).padEnd(w[i])).join("  ");
    console.log(fmt(["package", "expected", "installed", "spec", "state"]));
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
    });')"
}

verify || die "verification failed: not every manifest package is installed at the expected version, or an obsolete @ddvnguyen package is still in the profile"
log "every manifest package is installed at the expected version"
log "customizations deploy complete for lane $LANE"
