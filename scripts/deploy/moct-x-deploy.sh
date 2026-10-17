#!/usr/bin/env bash
# MOCT-X deploy — Pipeline 1 (ddvnguyen/moct -> /mnt/workspace/clouds/moct-x).
#
# Runs on the self-hosted "clouds" runner as the ddv user. Never uses sudo, never
# touches TEST (3081/8110) or PROD (3080), and never writes ~/.moct/test.
# No token is read, printed or logged anywhere in this script.
#
# Env (all optional, defaults shown):
#   RELEASE_SHA   git sha to deploy          default: HEAD of the checkout
#   REPO_ROOT     repo checkout root         default: $PWD
#   CLOUDS_ROOT   clouds root                default: /mnt/workspace/clouds
#   SERVICE       user unit to restart       default: moct-x
#   PORT          service port               default: 8210
#   KEEP_RELEASES releases to keep           default: 2
#   KEEP_BACKUPS  db backups to keep         default: 3
#   DRY_RUN       set to 1 to stop after the rehearsal and skip the live switch
#
# Order matches the spec's pipeline 1: package to releases/<sha>/ -> migrate
# against a COPY first -> back up the live db -> switch current -> restart ->
# smoke -> roll back on failure -> prune.
set -euo pipefail

RELEASE_SHA="${RELEASE_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
REPO_ROOT="${REPO_ROOT:-$PWD}"
CLOUDS_ROOT="${CLOUDS_ROOT:-/mnt/workspace/clouds}"
SERVICE="${SERVICE:-moct-x}"
PORT="${PORT:-8210}"
KEEP_RELEASES="${KEEP_RELEASES:-2}"
KEEP_BACKUPS="${KEEP_BACKUPS:-3}"

RELDIR="$CLOUDS_ROOT/$SERVICE/releases/$RELEASE_SHA"
CURRENT="$CLOUDS_ROOT/$SERVICE/current"
DB="$CLOUDS_ROOT/$SERVICE/data/moct.db"
BACKUPS="$CLOUDS_ROOT/$SERVICE/data/backups"
SCRATCH="$CLOUDS_ROOT/$SERVICE/.scratch/$RELEASE_SHA"
LOGDIR="$CLOUDS_ROOT/$SERVICE/logs"
BASE_URL="http://127.0.0.1:$PORT"
UNIT_FILE="/home/ddv/.config/systemd/user/$SERVICE.service"

PKG_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
PREV_RELEASE="$(readlink -f "$CURRENT" 2>/dev/null || true)"
TOOK_BACKUP=0
SWITCHED=0
PREMIG_PID=""

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
die() { printf '[deploy %s] FATAL: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit 1; }

rollback() {
  log "ROLLBACK: stopping $SERVICE"
  systemctl --user stop "$SERVICE" 2>/dev/null || true
  if [ -n "$PREV_RELEASE" ] && [ -d "$PREV_RELEASE" ]; then
    ln -sfn "releases/$(basename "$PREV_RELEASE")" "$CURRENT.new"
    mv -T "$CURRENT.new" "$CURRENT"
    log "ROLLBACK: current -> $PREV_RELEASE"
  fi
  if [ "$TOOK_BACKUP" = "1" ]; then
    LATEST="$(ls -1t "$BACKUPS"/moct-*.db 2>/dev/null | head -1 || true)"
    if [ -n "$LATEST" ]; then
      rm -f "$DB" "$DB-wal" "$DB-shm"
      cp -a "$LATEST" "$DB"
      log "ROLLBACK: restored db from $LATEST"
    fi
  fi
  systemctl --user restart "$SERVICE" 2>/dev/null || systemctl --user start "$SERVICE" 2>/dev/null || true
  log "ROLLBACK: done"
}
on_error() {
  rc=$?
  set +e
  if [ "$SWITCHED" = "1" ]; then
    rollback
    log "deploy failed (exit $rc) and was rolled back; run marked failed"
  else
    log "deploy failed (exit $rc) before the switch; nothing live was changed"
  fi
  exit $rc
}
trap on_error ERR

cleanup() { [ -n "$PREMIG_PID" ] && kill "$PREMIG_PID" 2>/dev/null; rm -rf "$SCRATCH"; return 0; }
trap cleanup EXIT

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>process.stdout.write(String(p)))})'
}

wait_health() { # $1 = base url, $2 = attempts (0.5s apart)
  local i
  for ((i=0; i<${2:-60}; i++)); do
    curl -fsS "$1/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

check_health() { # $1 = json, $2 = expected version, $3 = expected sha
  node -e '
    const h = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const [want, sha] = process.argv.slice(1);
    if (h.ok !== true) throw new Error("health.ok is not true");
    if (h.service !== "orchestration-backend") throw new Error("unexpected service " + h.service);
    if (h.version !== want) throw new Error("version " + h.version + " != " + want);
    if (h.build.git_sha !== sha) throw new Error("build.git_sha " + h.build.git_sha + " != " + sha);
    if (h.state_writable !== true) throw new Error("state_writable is false");
    if (!Array.isArray(h.tools) || h.tools.length === 0) throw new Error("no tools in health");
  ' "$2" "$3" <<<"$1"
}

# --- 0. preflight -----------------------------------------------------------
[ -f "$UNIT_FILE" ] || die "unit file missing: $UNIT_FILE (create it first)"
[ -d "$REPO_ROOT/dist" ] || die "no dist/ in $REPO_ROOT — run the build step first"
case "$PORT" in 3080|3081|8099|8110|18081|18789|4097) die "refusing to use protected port $PORT";; esac
mkdir -p "$CLOUDS_ROOT/$SERVICE/releases" "$CLOUDS_ROOT/$SERVICE/data" "$BACKUPS" "$LOGDIR"
log "deploying sha $RELEASE_SHA (package version $PKG_VERSION)"
[ "${DRY_RUN:-0}" = "1" ] && log "DRY_RUN=1 — will stop after the rehearsal, nothing live changes"

# --- 1. package the release ------------------------------------------------
if [ -f "$RELDIR/.complete" ]; then
  log "release already packaged, reusing $RELDIR"
else
  rm -rf "$RELDIR"; mkdir -p "$RELDIR"
  cp -a "$REPO_ROOT/dist" "$RELDIR/dist"
  cp -a "$REPO_ROOT/package.json" "$RELDIR/package.json"
  # node_modules is hardlinked, never copied: the shared pnpm store already holds
  # every file, so this costs inodes and no disk.
  cp -al "$REPO_ROOT/node_modules" "$RELDIR/node_modules"
  # Build identity: rewrite the compiled BUILD_INFO literals to this sha so the
  # smoke can prove which sha is actually serving.
  sed -i "s/number: \"dev\"/number: \"${RELEASE_SHA:0:7}\"/; s/date: \"unknown\"/date: \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"/; s/git_sha: \"unknown\"/git_sha: \"$RELEASE_SHA\"/" "$RELDIR/dist/surfaces/http/health.js"
  grep -q "git_sha: \"$RELEASE_SHA\"" "$RELDIR/dist/surfaces/http/health.js" || die "BUILD_INFO rewrite failed"
  printf '{"sha":"%s","version":"%s","packagedAt":"%s"}\n' "$RELEASE_SHA" "$PKG_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RELDIR/release.json"
  : > "$RELDIR/.complete"
  log "packaged: $(du -sh "$RELDIR" | cut -f1) total, dist $(du -sh "$RELDIR/dist" | cut -f1), node_modules hardlinked"
fi

# --- 2. migrate against a COPY first ---------------------------------------
# The schema is idempotent DDL applied on open, so the rehearsal is: boot the NEW
# release against a COPY of the live db on an ephemeral port and let it migrate.
log "migration rehearsal against a copy of the live db"
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/state" "$SCRATCH/backups"
if [ -f "$DB" ]; then
  cp -a "$DB" "$SCRATCH/moct.db"
  [ -f "$DB-wal" ] && cp -a "$DB-wal" "$SCRATCH/moct.db-wal" || true
  log "copy of the live db staged in $SCRATCH"
else
  log "no live db yet — rehearsal will create a fresh one"
fi
PREMIG_PORT="$(free_port)"
(
  cd "$RELDIR"
  ORCHESTRATION_BIND=127.0.0.1 ORCHESTRATION_PORT="$PREMIG_PORT" \
    FLEET_DB_PATH="$SCRATCH/moct.db" MCP_ORCH_STATE_DIR="$SCRATCH/state" \
    MOCT_BACKUP_DIR="$SCRATCH/backups" exec node dist/daemon.js
) >"$LOGDIR/premig-$RELEASE_SHA.log" 2>&1 &
PREMIG_PID=$!
if ! wait_health "http://127.0.0.1:$PREMIG_PORT" 60; then
  kill "$PREMIG_PID" 2>/dev/null || true
  die "migration rehearsal failed to boot; see $LOGDIR/premig-$RELEASE_SHA.log"
fi
check_health "$(curl -fsS "http://127.0.0.1:$PREMIG_PORT/health")" "$PKG_VERSION" "$RELEASE_SHA" \
  || { kill "$PREMIG_PID" 2>/dev/null || true; die "migration rehearsal health mismatch"; }
# Verify the migrated COPY through a daemon snapshot, never the live file: Turso
# holds an exclusive lock, so sqlite3 can only read a snapshot the daemon wrote.
SNAP="$(curl -fsS -X POST "http://127.0.0.1:$PREMIG_PORT/team/v1/backup" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')"
[ -n "$SNAP" ] && [ -f "$SNAP" ] || { kill "$PREMIG_PID" 2>/dev/null || true; die "rehearsal daemon wrote no snapshot"; }
sqlite3 -readonly "$SNAP" 'PRAGMA integrity_check;' | grep -qx ok \
  || { kill "$PREMIG_PID" 2>/dev/null || true; die "rehearsal snapshot integrity_check failed"; }
HAVE_V8="$(sqlite3 -readonly "$SNAP" "SELECT COUNT(*) FROM meta WHERE key='schema_version:8'")"
[ "$HAVE_V8" = "1" ] || { kill "$PREMIG_PID" 2>/dev/null || true; die "rehearsal snapshot did not reach schema_version:8 (got '$HAVE_V8')"; }
rm -f "$SNAP" "$SNAP-wal" "$SNAP-shm"
kill "$PREMIG_PID" 2>/dev/null || true; wait "$PREMIG_PID" 2>/dev/null || true; PREMIG_PID=""
log "migration rehearsal green on port $PREMIG_PORT (schema_version:8 present, integrity_check ok, snapshot $SNAP verified and discarded)"

# --- 3. back up the live db before anything can change it ------------------
if systemctl --user is-active --quiet "$SERVICE"; then
  log "service is active: taking a db snapshot first"
  curl -fsS -X POST "$BASE_URL/team/v1/backup" >/dev/null || die "pre-deploy backup failed"
  TOOK_BACKUP=1
  log "snapshot written under $BACKUPS"
else
  log "service not active yet (first deploy): no live db to back up"
fi

# --- 3b. dry run stops here -------------------------------------------------
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY_RUN: rehearsal and packaging green; not switching, not restarting, exiting 0"
  exit 0
fi

# --- 4. switch current + restart -------------------------------------------
log "switching current -> releases/$RELEASE_SHA"
ln -sfn "releases/$RELEASE_SHA" "$CURRENT.new"
mv -T "$CURRENT.new" "$CURRENT"
SWITCHED=1
log "restarting $SERVICE"
systemctl --user restart "$SERVICE"
if ! wait_health "$BASE_URL" 60; then
  die "service did not answer /health after restart (see $LOGDIR)"
fi

# --- 5. smoke ---------------------------------------------------------------
log "smoke on $BASE_URL"
check_health "$(curl -fsS "$BASE_URL/health")" "$PKG_VERSION" "$RELEASE_SHA" || die "smoke: /health mismatch"
curl -fsS "$BASE_URL/schema" | node -e 'const s=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if(!s.ok||!s.tools.length) throw new Error("bad /schema payload"); process.stdout.write("[deploy] /schema tools: "+s.tools.length+"\n")' || die "smoke: /schema failed"
curl -fsS "$BASE_URL/team/v1/operations/head" >/dev/null || die "smoke: /team/v1/operations/head failed"
log "smoke green: version $PKG_VERSION, git_sha $RELEASE_SHA"

# --- 6. prune ---------------------------------------------------------------
CUR_NAME="$(basename "$(readlink -f "$CURRENT")")"
ls -1t "$CLOUDS_ROOT/$SERVICE/releases" | tail -n +"$((KEEP_RELEASES + 1))" | while read -r r; do
  [ "$r" = "$CUR_NAME" ] && continue
  rm -rf "$CLOUDS_ROOT/$SERVICE/releases/$r"; log "pruned release $r"
done
ls -1t "$BACKUPS"/moct-*.db 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm --
log "deploy complete: $RELEASE_SHA live on $BASE_URL"
