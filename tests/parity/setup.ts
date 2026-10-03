/**
 * Parity setup: live-DB guard, deterministic DB builds from the checked-in
 * seed.sql, and booting both MCP servers over stdio.
 *
 * python.db is derived from the SAME seed.sql by mechanical un-prefixing
 * (reverse of the store/schema.ts rename mapping), so both engines start
 * from identical rows without ever touching the live ledger.
 */
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "./rpc.js";
import { TursoRepository } from "../../src/store/turso-repository.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG_DIR = path.dirname(path.dirname(HERE));
export const SEED_SQL = path.join(PKG_DIR, "tests", "fixtures", "seed.sql");
export const LIVE_DB =
  "/mnt/WorkDisk/Workplace/LLM-Agents-Orchestration/orchestration/state/mcp/orchestration.sqlite";
const PY_SRC = "/mnt/WorkDisk/Workplace/LLM-Agents-Orchestration/mcp-orchestration/src";
const VENV_PY =
  "/mnt/WorkDisk/Workplace/LLM-Agents-Orchestration/mcp-orchestration/.venv-cd/bin/python";
const LAO_ROOT = "/mnt/WorkDisk/Workplace/LLM-Agents-Orchestration";

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
  const liveReal = realpathSync(LIVE_DB);
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
    FLEET_FORBIDDEN_DB_PATHS: liveReal,
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
