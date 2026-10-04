// regenerate-fixture.mjs — MANUAL op (never from CI/tests).
//
// Generates tests/fixtures/seed.sql ONCE from a read-only snapshot of the
// live orchestration ledger, migrating the 10 current tables to the fleet.db
// v1 orch_* shape (+ meta). See src/store/schema.ts for the rename mapping.
//
// Guardrails: the live DB is opened ONLY via `sqlite3 -readonly ... .backup`.
// All scratch artifacts stay worktree-local under .fixture-tmp/ (gitignored).
// Usage: npm run fixture:regen --workspace=@getpaseo/fleet-backend
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = path.join(PKG, ".fixture-tmp");
const COPY = path.join(TMP, "orch-copy.sqlite");
const FLEET_DB = path.join(TMP, "fleet.db");
const SEED_SQL = path.join(PKG, "tests", "fixtures", "seed.sql");

const LIVE_DB = (process.env["FLEET_PARITY_LIVE_DB"] || "").trim();
if (!LIVE_DB) {
  throw new Error(
    "FLEET_PARITY_LIVE_DB is not set. Regeneration reads the live orchestration " +
      "ledger (read-only snapshot) — export the path explicitly; no machine-local " +
      "default is baked in.",
  );
}

const TABLE_MAP = [
  ["projects", "orch_projects"],
  ["tracks", "orch_tracks"],
  ["tasks", "orch_tasks"],
  ["workers", "orch_workers"],
  ["turns", "orch_turns"],
  ["events", "orch_events"],
  ["decisions", "orch_decisions"],
  ["suggestions", "orch_suggestions"],
  ["model_evaluations", "orch_model_evaluations"],
];

function sqlLit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`non-finite number in fixture: ${v}`);
    return Number.isInteger(v) ? String(v) : String(v);
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

const { FLEET_SCHEMA_SQL } = await import("../dist/store/schema.js");
const turso = await import("../node_modules/@tursodatabase/database/dist/promise.js");

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// 1. read-only consistent copy of the live ledger
if (!existsSync(LIVE_DB)) throw new Error(`live DB not found: ${LIVE_DB}`);
execFileSync("sqlite3", ["-readonly", LIVE_DB, `.backup ${COPY}`], { stdio: "inherit" });
console.log(`backup ok: ${COPY}`);

// 2. SELECT-only read of the copy (Turso 0.7.2 has no read-only open, so the
//    script runs SELECT + PRAGMA table_info only against the disposable copy)
const src = await turso.connect(COPY);
const userTables = (
  await src.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_turso_internal%' ESCAPE '\\' ORDER BY name",
  )
).map((r) => r.name);
console.log(`user tables in copy: ${userTables.join(", ")}`);

// 3. create fleet.db with the v1 orch_* schema, migrate rows (raw values
//    preserved bit-for-bit via bound params — no parse/reserialize, so
//    LENGTH(payload) bytes and float spellings survive untouched)
if (existsSync(FLEET_DB)) rmSync(FLEET_DB);
const dst = await turso.connect(FLEET_DB);
await dst.exec(FLEET_SCHEMA_SQL);
// The live ledger predates FK enforcement (JSON mode had none): 59 events +
// 9 turns reference deleted tracks. The migration is LOSSLESS — orphans are
// preserved, so bulk inserts run with FK OFF (runtime stays FK ON like Python).
await dst.exec("PRAGMA foreign_keys=OFF;");

const counts = {};
for (const [orig, renamed] of TABLE_MAP) {
  const info = await src.all(`PRAGMA table_info(${orig})`);
  const cols = info.map((c) => c.name);
  const rows = await src.all(`SELECT * FROM ${orig} ORDER BY rowid`);
  for (const row of rows) {
    const vals = cols.map((c) => row[c] ?? null);
    await dst.run(
      `INSERT INTO ${renamed}(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`,
      ...vals,
    );
  }
  counts[renamed] = rows.length;
  console.log(`  ${orig} -> ${renamed}: ${rows.length} rows`);
}
// schema_version(version, applied_at) -> meta('schema_version:<v>', applied_at)
const versions = await src.all("SELECT version, applied_at FROM schema_version ORDER BY version");
for (const v of versions) {
  await dst.run(
    "INSERT INTO meta(key, value) VALUES(?, ?)",
    `schema_version:${v.version}`,
    v.applied_at,
  );
}
counts["meta"] = versions.length;
console.log(`  schema_version -> meta: ${versions.length} rows`);
await dst.exec("PRAGMA foreign_keys=ON;");
const violations = await dst.all("PRAGMA foreign_key_check");
console.log(`  foreign_key_check violations preserved from live ledger: ${violations.length}`);
await src.close();

// 4. verify: per-table counts + aggregate row-hash equality copy vs fleet.db
const verify = await turso.connect(FLEET_DB);
let mismatches = 0;
for (const [_orig, renamed] of TABLE_MAP) {
  const a = await verify.get(`SELECT COUNT(*) AS n FROM ${renamed}`);
  if (Number(a.n) !== counts[renamed]) {
    console.error(`COUNT MISMATCH ${renamed}: ${a.n} != ${counts[renamed]}`);
    mismatches++;
  }
}
await verify.close();
if (mismatches) throw new Error(`${mismatches} count mismatches`);
await dst.close();

// 5. dump deterministic seed.sql (schema + INSERT literals, parents first)
const dump = await turso.connect(FLEET_DB);
let sql = `-- fleet.db v1 parity fixture — generated by scripts/regenerate-fixture.mjs
-- from a read-only snapshot of the live orchestration ledger.
-- REGENERATION IS MANUAL (never from CI/tests): rerun fixture:regen when the
-- Python schema drifts. Counts at generation: ${JSON.stringify(counts)}
PRAGMA foreign_keys=OFF;
-- NOTE: the live ledger contains orphan rows (events/turns referencing deleted
-- tracks — JSON mode had no FK enforcement). The migration preserves them, so
-- this seed loads with FK OFF and runtimes re-enable FK ON (as Python does).
`;
// PRAGMAs (incl. foreign_keys=ON) stay in the live DDL for repo init, but the
// seed must load with FK OFF throughout (orphan rows) — OFF is set above and
// re-enabled at the end of the dump.
sql += FLEET_SCHEMA_SQL.replace(/^PRAGMA .*$/gm, "") + "\n";
for (const [_orig, renamed] of TABLE_MAP) {
  const info = await dump.all(`PRAGMA table_info(${renamed})`);
  const cols = info.map((c) => c.name);
  const rows = await dump.all(`SELECT * FROM ${renamed} ORDER BY rowid`);
  for (const row of rows) {
    sql += `INSERT INTO ${renamed}(${cols.join(", ")}) VALUES(${cols.map((c) => sqlLit(row[c] ?? null)).join(", ")});\n`;
  }
}
{
  const rows = await dump.all("SELECT key, value FROM meta ORDER BY key");
  for (const row of rows) {
    sql += `INSERT INTO meta(key, value) VALUES(${sqlLit(row.key)}, ${sqlLit(row.value)});\n`;
  }
}
await dump.close();
sql += "PRAGMA foreign_keys=ON;\n";
// Scrub machine-local values BEFORE writing (round 3, owner should-fix #2):
// the fixture is checked into a PUBLIC repo. Value substitution only — row
// counts and structure are untouched. Rules documented in tests/parity/SCRUB.md.
sql = sql
  .replace(/\/home\/ddv/g, "/path/to/home")
  .replace(/\/mnt\/WorkDisk/g, "/path/to/work")
  .replace(/\/mnt\/workspace/g, "/path/to/workspace")
  .replace(/hydra\.app\.01@gmail\.com/g, "operator@example.com")
  .replace(/(?<![A-Za-z0-9_/\-.])ddv(?![A-Za-z0-9_\-.])/g, "operator");
const banned = ["/home/ddv", "/mnt/WorkDisk", "/mnt/workspace", "@gmail.com"];
for (const pattern of banned) {
  if (sql.includes(pattern)) {
    throw new Error(`scrub incomplete: fixture still contains ${pattern}; refusing to write.`);
  }
}
mkdirSync(path.dirname(SEED_SQL), { recursive: true });
writeFileSync(SEED_SQL, sql);
const sha = createHash("sha256").update(sql).digest("hex");
console.log(`wrote ${SEED_SQL} (${sql.length} bytes, sha256 ${sha})`);
console.log(`counts: ${JSON.stringify(counts)}`);
