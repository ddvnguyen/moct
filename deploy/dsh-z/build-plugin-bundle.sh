#!/usr/bin/env bash
# deploy/dsh-z/build-plugin-bundle.sh — package @multica/dsh-plugin for the lane
# web profile.
#
# deploy/dsh-z/ does not build the monorepo (a pnpm workspace install is heavier
# than any lane phase should pay), so the plugin ships the way the runtime does
# in phase 9b: as a directory bundle on the lane disk that `dsh plugin --profile
# web add` consumes. This script produces that bundle from any multica-x
# checkout that already has node_modules installed: it copies the built lib/
# into DSH_Z_PLUGIN_BUNDLE and rewrites the package manifest so the bundle only
# declares what the built code needs at runtime (ws — the client half already
# bundles React 19 for the browser).
#
# The compiled output is shipped as tsc and Vite emitted it. Nothing here edits
# lib/: import specifiers, including the `ws` load, are correct at the source
# (packages/dsh-plugin/src), so a bundle is only ever a copy plus the vendored
# runtime dependency. The load check at the end is what holds that line.
#
# Run once per plugin version: bash deploy/dsh-z/build-plugin-bundle.sh <checkout-root>
#
# The output directory is DSH_Z_PLUGIN_BUNDLE (the lane's live bundle) unless a
# third argument names another one — CI passes a staging directory so the same
# script packages the `dsh-plugin-<sha>` artifact the auto-deploy installs
# (M-151). Same code path means the artifact and a hand-built bundle cannot
# drift apart.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/dsh-z.env"
die() { echo "ERROR: $*" >&2; exit 1; }

SRC="${1:-}"
[ -n "$SRC" ] || die "usage: $0 <multica-x checkout root> [base-version] [out-dir]"
for f in package.json cordis.patch.yml FORK.md README.md; do
  [ -f "$SRC/packages/dsh-plugin/$f" ] || die "missing packages/dsh-plugin/$f in $SRC"
done
[ -f "$SRC/packages/dsh-plugin/lib/index.js" ] || die "packages/dsh-plugin is not built in $SRC (run: pnpm --filter @multica/dsh-plugin build)"
[ -d "$SRC/packages/dsh-plugin" ] || die "$SRC has no pnpm install; run pnpm install in the checkout first"

OUT="${3:-${DSH_Z_PLUGIN_BUNDLE:-}}"
[ -n "$OUT" ] || die "set DSH_Z_PLUGIN_BUNDLE in dsh-z.env or pass an output directory"

VER="$(node -p "require('$SRC/packages/dsh-plugin/package.json').version")"
if [ -n "${2:-}" ]; then VER="$2"; fi
rm -rf "$OUT"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

cp -a "$SRC/packages/dsh-plugin/lib" "$OUT/lib"
cp "$SRC/packages/dsh-plugin/cordis.patch.yml" \
   "$SRC/packages/dsh-plugin/FORK.md" \
   "$SRC/packages/dsh-plugin/README.md" \
   "$OUT/"

# Runtime manifest only: workspace devDeps ("@multica/core": "workspace:*",
# ...) are compiled into lib/ and must not be resolved again by the profile's
# own pnpm install — there is no workspace in the profile to resolve them
# from. The same rule drops the build/test tooling.
node - "$SRC/packages/dsh-plugin/package.json" "$OUT/package.json" "$VER" <<'EOF'
const fs = require("node:fs");
const [src, out, ver] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(src, "utf8"));
const bundle = {
  name: p.name,
  version: `${ver}+lanez`,
  private: p.private,
  description: p.description,
  type: p.type,
  license: p.license,
  main: p.main,
  types: p.types,
  files: p.files,
  exports: p.exports,
  dsh: p.dsh,
  dependencies: p.dependencies,
};
fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n");
EOF

# The profile installs this bundle by symlink (link:), and Node resolves
# imports from the link TARGET's real path — so the `ws` that lib/ws.js loads
# has to exist inside the bundle itself; nothing above the bundle on disk has
# it. Vendor it from packages/dsh-plugin's own resolution, not the checkout
# root: the root cache can carry an older hoisted copy (ws@7 here — export
# shape has no WebSocketServer and it breaks the host half at startup), while
# packages/dsh-plugin pins ws ^8.18.3 through its own link.
# -L: the ws path in a pnpm tree is a symlink into .pnpm; the vendor copy must
# materialize real files or the bundle ships a dangling link.
# Resolve ws through Node module resolution (handles pnpm hoisting) rather than
# assuming packages/dsh-plugin/node_modules/ws exists.
WS_SRC="$(node -e 'const p=require.resolve("ws/package.json",{paths:[process.argv[1]]}); console.log(require("node:path").dirname(p))' "$SRC/packages/dsh-plugin")"
[ -n "$WS_SRC" ] && [ -f "$WS_SRC/package.json" ] || die "could not resolve ws from $SRC/packages/dsh-plugin"
mkdir -p "$OUT/node_modules"
cp -aL "$WS_SRC" "$OUT/node_modules/ws"
node -e 'require(process.argv[1])' "$OUT/node_modules/ws/package.json" >/dev/null \
  || die "vendored ws is unusable"
if [ "$(node -p "require('$OUT/node_modules/ws/package.json').version.startsWith('8.')")" != "true" ]; then
  die "vendored ws is not v8 — the host half is compiled against the ws v8 export shape"
fi

# Load the shipped bundle the way the dsh host does: lib/index.js as ESM from
# the bundle root, which is also the first place the `ws` lookup can succeed.
# This is the check that fails loudly for the two shapes that broke boot before
# (a relative import without its extension, a `ws` load that resolves to the
# browser build), instead of surfacing them as a dead rail row.
node --input-type=module -e '
  const { pathToFileURL } = await import("node:url");
  const load = (file) => import(pathToFileURL(file).href);
  const root = process.argv[1];
  const { WebSocket, WebSocketServer } = await load(`${root}/lib/ws.js`);
  if (typeof WebSocket !== "function" || typeof WebSocketServer !== "function") {
    throw new Error("lib/ws.js did not resolve the ws constructors from the bundle");
  }
  const plugin = await load(`${root}/lib/index.js`);
  if (typeof plugin.default !== "function" && typeof plugin.apply !== "function") {
    throw new Error("lib/index.js did not export the host plugin");
  }
' "$OUT" || die "bundled lib/ does not load as ESM from $OUT"

echo "wrote $OUT (built from $SRC @ $(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo unknown))"
