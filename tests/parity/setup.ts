/**
 * Parity setup: live-DB guard, deterministic DB builds from the checked-in
 * seed.sql, and booting both MCP servers over stdio.
 *
 * python.db is derived from the SAME seed.sql by mechanical un-prefixing
 * (reverse of the store/schema.ts rename mapping), so both engines start
 * from identical rows without ever touching the live ledger.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "./rpc.js";
import { TursoRepository } from "../../src/store/turso-repository.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG_DIR = path.dirname(path.dirname(HERE));
export const SEED_SQL = path.join(PKG_DIR, "tests", "fixtures", "seed.sql");

/**
 * Pinned Python baseline (owner should-fix #1, round 3).
 *
 * origin/hydra/orchestration at this SHA contains LAO #68 (runbook 1.11.0:
 * dev reuse at 200K, <=3 compactions, wrong-direction kill, orchestrator
 * flags) + #69 (holder-reconfirm/history ordering, _agent_cwd fallback,
 * _detect_repo_root fail-open). The TS domain ports exactly this tree; the
 * harness VERIFIES the files under PY_SRC match the pin byte-for-byte and
 * FAILS LOUDLY on mismatch — hydra progress must never silently move the
 * baseline. To move the pin: port the new deltas, update LAO_PIN_SHA, re-run
 * parity, and record the new SHA + case count in HARNESS.md and the PR body.
 */
export const LAO_PIN_SHA = "13fc0cb0f789965e64e34b541fa5e14fb7b37cf2";
const PINNED_FILES = [
  "mcp-orchestration/src/mcp_orchestration/runbook.py",
  "mcp-orchestration/src/mcp_orchestration/config.py",
  "mcp-orchestration/src/mcp_orchestration/state/timings.py",
  "mcp-orchestration/src/mcp_orchestration/tools/leader.py",
];

function requiredEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(
      `PARITY SETUP: env var ${name} is not set. ` +
        `Parity needs the live LAO checkout for the Python baseline only — ` +
        `export ${name} explicitly (no machine-local defaults are baked in). ` +
        `See tests/parity/HARNESS.md for the exact export block.`,
    );
  }
  return value;
}

export const LAO_ROOT = requiredEnv("FLEET_PARITY_LAO_ROOT");
export const PY_SRC =
  (process.env["FLEET_PARITY_PY_SRC"] || "").trim() ||
  path.join(LAO_ROOT, "mcp-orchestration", "src");
export const VENV_PY = requiredEnv("FLEET_PARITY_VENV_PY");
// Optional: an extra forbidden path for the live-DB guard (the LAO-derived
// ledger path below is always forbidden). Fixtures/tests never need it.
const LIVE_DB_ENV = (process.env["FLEET_PARITY_LIVE_DB"] || "").trim();
export const LIVE_DB = LIVE_DB_ENV;
const LIVE_LEDGER_RELPATH = path.join("orchestration", "state", "mcp", "orchestration.sqlite");

/** Fail loudly unless every ported Python file matches the pinned SHA. */
export function verifyPin(): void {
  // LAO_ROOT is usually the live checkout (a git repo carrying the pin
  // object). When it is a plain read-only extract (e.g. the .parity-pin/
  // tree, used because the live working tree has already drifted past the
  // pin), FLEET_PARITY_LAO_GIT points at a checkout that has the object.
  let gitDir = "";
  try {
    execFileSync("git", ["-C", LAO_ROOT, "cat-file", "-e", `${LAO_PIN_SHA}^{commit}`], {
      stdio: "pipe",
    });
    gitDir = LAO_ROOT;
  } catch {
    gitDir = "";
  }
  if (!gitDir) {
    const fallback = (process.env["FLEET_PARITY_LAO_GIT"] || "").trim();
    if (fallback) {
      try {
        execFileSync("git", ["-C", fallback, "cat-file", "-e", `${LAO_PIN_SHA}^{commit}`], {
          stdio: "pipe",
        });
        gitDir = fallback;
      } catch {
        gitDir = "";
      }
    }
  }
  if (!gitDir) {
    throw new Error(
      `PARITY PIN: commit ${LAO_PIN_SHA} is not present in the LAO checkout at ${LAO_ROOT}. ` +
        `Run: git -C <lao-checkout> fetch origin hydra/orchestration (or the ref carrying the pin), ` +
        `then re-run parity. If FLEET_PARITY_LAO_ROOT points at a plain (non-git) extract, ` +
        `set FLEET_PARITY_LAO_GIT to a checkout carrying the pin object. ` +
        `Do NOT point the env vars at a different tree to make this pass.`,
    );
  }
  for (const rel of PINNED_FILES) {
    let pinned: string;
    try {
      pinned = execFileSync("git", ["-C", gitDir, "show", `${LAO_PIN_SHA}:${rel}`], {
        encoding: "utf-8",
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (exc) {
      throw new Error(
        `PARITY PIN: cannot read ${rel} at ${LAO_PIN_SHA} from ${gitDir}: ${(exc as Error).message}`,
        { cause: exc },
      );
    }
    const livePath = path.join(PY_SRC, rel.replace("mcp-orchestration/src/", ""));
    let live: string;
    try {
      live = readFileSync(livePath, "utf-8");
    } catch (exc) {
      throw new Error(
        `PARITY PIN: cannot read baseline file ${livePath}: ${(exc as Error).message}. ` +
          `Check FLEET_PARITY_PY_SRC (defaults to $FLEET_PARITY_LAO_ROOT/mcp-orchestration/src).`,
        { cause: exc },
      );
    }
    if (live !== pinned) {
      throw new Error(
        `PARITY PIN MISMATCH: ${livePath} differs from ${LAO_PIN_SHA}:${rel}. ` +
          `The baseline moved (or PY_SRC points at the wrong tree) — parity against a drifted ` +
          `baseline proves nothing. Either check out the pinned tree, or port the new deltas, ` +
          `update LAO_PIN_SHA in tests/parity/setup.ts, and re-run. Refusing to run.`,
      );
    }
  }
}

const TABLE_UNMAP: [string, string][] = [
  ["orch_model_evaluations", "model_evaluations"],
  ["orch_suggestions", "suggestions"],
  ["orch_decisions", "decisions"],
  ["orch_projects", "projects"],
  ["orch_workers", "workers"],
  ["orch_tracks", "tracks"],
  ["orch_tasks", "tasks"],
  ["orch_turns", "turns"],
  ["orch_events", "events"],
];

const TRIGGER_UNMAP: [string, string][] = [
  ["orch_events_no_update", "events_no_update"],
  ["orch_events_no_delete", "events_no_delete"],
  ["orch_decisions_no_update", "decisions_no_update"],
  ["orch_decisions_no_delete", "decisions_no_delete"],
];

const INDEX_UNMAP: [string, string][] = [
  ["idx_orch_model_evals_project_ts", "idx_model_evals_project_ts"],
  ["idx_orch_model_evals_track_ts", "idx_model_evals_track_ts"],
  ["idx_orch_model_evals_agent", "idx_model_evals_agent"],
  ["idx_orch_suggestions_project_ts", "idx_suggestions_project_ts"],
  ["idx_orch_suggestions_track_ts", "idx_suggestions_track_ts"],
  ["idx_orch_suggestions_status", "idx_suggestions_status"],
  ["idx_orch_suggestions_kind", "idx_suggestions_kind"],
  ["idx_orch_decisions_project_ts", "idx_decisions_project_ts"],
  ["idx_orch_decisions_track_ts", "idx_decisions_track_ts"],
  ["idx_orch_events_project_ts", "idx_events_project_ts"],
  ["idx_orch_events_track_ts", "idx_events_track_ts"],
  ["idx_orch_events_type", "idx_events_type"],
  ["idx_orch_turns_track_n", "idx_turns_track_n"],
  ["idx_orch_turns_project_ts", "idx_turns_project_ts"],
  ["idx_orch_workers_track_id", "idx_workers_track_id"],
  ["idx_orch_tasks_track_id", "idx_tasks_track_id"],
  ["idx_orch_tasks_project_id", "idx_tasks_project_id"],
  ["idx_orch_tracks_project_id", "idx_tracks_project_id"],
];

/** Split a VALUES(...) tuple on top-level commas (no nested commas/quotes inside ids). */
export function splitSqlValues(tuple: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inStr = false;
  for (let i = 0; i < tuple.length; i++) {
    const ch = tuple[i];
    if (inStr) {
      current += ch;
      if (ch === "'") {
        if (tuple[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inStr = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inStr = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** Reverse the fleet.db v1 rename mapping (mechanical identifier rewrite). */
export function unmigrateSeed(seedSql: string): string {
  let sql = seedSql;
  for (const [orch, orig] of [...TRIGGER_UNMAP, ...INDEX_UNMAP]) {
    sql = sql.split(orch).join(orig);
  }
  for (const [orch, orig] of TABLE_UNMAP) {
    sql = sql.split(orch).join(orig);
  }
  // meta(key, value) -> schema_version(version, applied_at)
  sql = sql.replace(
    /CREATE TABLE IF NOT EXISTS meta \(\s*key TEXT PRIMARY KEY,\s*value TEXT NOT NULL\s*\);/,
    `CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);`,
  );
  sql = sql.replace(
    /INSERT INTO meta\(key, value\) VALUES\('schema_version:(\d+)', ('(?:[^']|'')*')\);/g,
    "INSERT INTO schema_version(version, applied_at) VALUES($1, $2);",
  );
  if (sql.includes("INSERT INTO meta(")) {
    throw new Error("unmigrate: unhandled meta INSERT remains");
  }
  return sql;
}

export interface ParityWorld {
  runDir: string;
  pyDir: string;
  tsDir: string;
  py: RpcClient;
  ts: RpcClient;
  fixtureProjectId: string;
  fixtureTrackId: string;
}

function loudGuard(label: string, candidate: string, liveReal: string): void {
  let resolved = candidate;
  try {
    resolved = realpathSync(candidate);
  } catch {
    resolved = path.resolve(candidate);
  }
  if (resolved === liveReal) {
    throw new Error(
      `PARITY GUARD: ${label} resolves to the LIVE ledger (${liveReal}). Refusing to run.`,
    );
  }
}

export async function setupParity(
  tier: string | null,
  opts?: { seed: boolean },
): Promise<ParityWorld> {
  // Pin first: fail before building anything when the baseline drifted.
  verifyPin();
  // Forbidden ledger paths: the LAO-derived ledger inside LAO_ROOT (always)
  // plus FLEET_PARITY_LIVE_DB when the operator sets it. Fixtures/tests never
  // need the live DB — both engines' DBs are built from the checked-in seed.
  const forbidden: string[] = [];
  const derivedLedger = path.join(LAO_ROOT, LIVE_LEDGER_RELPATH);
  for (const candidate of [derivedLedger, LIVE_DB_ENV]) {
    if (!candidate) continue;
    try {
      forbidden.push(realpathSync(candidate));
    } catch {
      forbidden.push(path.resolve(candidate));
    }
  }
  if (!forbidden.length) {
    throw new Error("PARITY GUARD: no forbidden ledger path resolved; refusing to run.");
  }
  const liveReal = forbidden[0];
  const runDir = path.join(
    PKG_DIR,
    ".tmp",
    `parity-${process.pid}${tier === "all" ? "-all" : "-tier"}`,
  );
  const pyDir = path.join(runDir, "py");
  const tsDir = path.join(runDir, "ts");
  mkdirSync(path.join(pyDir, "state"), { recursive: true });
  mkdirSync(path.join(tsDir, "state"), { recursive: true });

  const fleetDb = path.join(tsDir, "fleet.db");
  const pyDb = path.join(pyDir, "orch.db");
  loudGuard("FLEET_DB_PATH", fleetDb, liveReal);
  loudGuard("MCP_ORCH_DB_PATH", pyDb, liveReal);

  const withSeed = opts?.seed ?? true;
  const seedSql = withSeed ? readFileSync(SEED_SQL, "utf-8") : "";
  const pySql = withSeed ? unmigrateSeed(seedSql) : "";
  // ONE connection per DB file for the whole setup: Turso 0.7.2 takes a
  // process-wide file lock that close() releases asynchronously, so any
  // reopen in the same process races ("locked by another process").
  // fleet.db from the checked-in seed; python.db from the un-prefixed seed.
  // All driver contact goes through TursoRepository statics (the gate holds).
  await TursoRepository.execScript(
    fleetDb,
    withSeed ? `PRAGMA foreign_keys=OFF;\n${seedSql}` : "PRAGMA foreign_keys=ON;",
  );
  await TursoRepository.execScript(
    pyDb,
    withSeed ? `PRAGMA foreign_keys=OFF;\n${pySql}` : "PRAGMA foreign_keys=ON;",
  );
  // sanity: per-table counts agree across the mapping
  if (withSeed) {
    for (const [orch, orig] of TABLE_UNMAP) {
      const a = await TursoRepository.queryRows(fleetDb, `SELECT COUNT(*) AS n FROM ${orch}`);
      const b = await TursoRepository.queryRows(pyDb, `SELECT COUNT(*) AS n FROM ${orig}`);
      if (Number(a[0].n) !== Number(b[0].n)) {
        throw new Error(`setup count mismatch ${orch}/${orig}: ${a[0].n} != ${b[0].n}`);
      }
    }
  }
  // let file locks release before the servers (child processes) open the DBs
  await new Promise((r) => setTimeout(r, 2000));

  const pyEnv: Record<string, string | undefined> = {
    PYTHONPATH: PY_SRC,
    MCP_ORCH_DB_PATH: pyDb,
    MCP_ORCH_STATE_DIR: path.join(pyDir, "state"),
    MCP_ORCH_SUMMARY_PATH: path.join(pyDir, "summary.md"),
    MCP_ORCH_LESSONS_DIR: path.join(pyDir, "lessons"),
    MCP_ORCH_REFERENCES_DIR: path.join(pyDir, "references"),
  };
  const tsEnv: Record<string, string | undefined> = {
    FLEET_DB_PATH: fleetDb,
    MCP_ORCH_STATE_DIR: path.join(tsDir, "state"),
    MCP_ORCH_SUMMARY_PATH: path.join(tsDir, "summary.md"),
    MCP_ORCH_LESSONS_DIR: path.join(tsDir, "lessons"),
    MCP_ORCH_REFERENCES_DIR: path.join(tsDir, "references"),
    FLEET_REPO_ROOT: LAO_ROOT,
    FLEET_FORBIDDEN_DB_PATHS: forbidden.join(","),
  };
  if (tier === "all") {
    pyEnv["MCP_ORCH_TIER"] = "all";
    tsEnv["MCP_ORCH_TIER"] = "all";
  }

  const py = new RpcClient(VENV_PY, ["-m", "mcp_orchestration.server"], { cwd: pyDir, env: pyEnv });
  const ts = new RpcClient(process.execPath, [path.join(PKG_DIR, "dist", "mcp.js")], {
    cwd: tsDir,
    env: tsEnv,
  });
  await py.start();
  await ts.start();
  await py.initialize();
  await ts.initialize();

  // resolve stable fixture ids WITHOUT reopening fleet.db: parse the first
  // project/track ids from the seed text (seed.sql is fixed, so these are
  // stable across runs).
  let fixtureProjectId = "p-seedless";
  let fixtureTrackId = "t-seedless";
  if (withSeed) {
    const projRow = /^INSERT INTO orch_projects\(([^)]+)\) VALUES\((.*)\);$/m.exec(seedSql);
    const trackRow = /^INSERT INTO orch_tracks\(([^)]+)\) VALUES\((.*)\);$/m.exec(seedSql);
    if (!projRow || !trackRow)
      throw new Error("setup: cannot find first project/track rows in seed.sql");
    fixtureProjectId = splitSqlValues(projRow[2])[0].replace(/^'(.*)'$/, "$1");
    fixtureTrackId = splitSqlValues(trackRow[2])[0].replace(/^'(.*)'$/, "$1");
  }

  return { runDir, pyDir, tsDir, py, ts, fixtureProjectId, fixtureTrackId };
}

export async function teardownParity(world: ParityWorld): Promise<void> {
  await world.py.stop().catch(() => undefined);
  await world.ts.stop().catch(() => undefined);
}
