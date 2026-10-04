/**
 * TursoRepository — THE ONLY FILE in this package importing
 * @tursodatabase/database (hard rule, CI-gated).
 *
 * SQL-mode port of mcp-orchestration/state/store.py against fleet.db v1
 * (orch_* tables + meta; see store/schema.ts for the rename mapping).
 * Single connection, single writer; lock() serializes read-modify-write
 * critical sections with an async mutex (intra-process) inside a real
 * SQLite transaction — BEGIN IMMEDIATE / COMMIT / ROLLBACK, SAVEPOINT for
 * nesting (cross-process, mirroring Python Store.lock's SQL mode).
 */
import { connect } from "@tursodatabase/database";
import type { Database } from "@tursodatabase/database";
import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import { FLEET_SCHEMA_SQL } from "./schema.js";
import { StateError, makeRowFilter, type RowFilter, type Store } from "./store-interface.js";
import {
  coerceTrack,
  defaultHandoff,
  defaultHeartbeatBinding,
  newId,
  pyDumps,
  pyInt,
  pyRepr,
  slugify,
  utcnowIso,
  type Decision,
  type FleetEvent,
  type Project,
  type Track,
  type TurnDelta,
} from "../domain/models.js";
import { SYSTEM_PROJECT_SLUG } from "../domain/models.js";

const EVENT_COLUMNS = "id, project_id, track_id, type, ts, payload";
const DECISION_COLUMNS =
  "id, project_id, track_id, ts, decision, rationale, source, irreversible, author, payload";

function jload(v: unknown): unknown {
  if (v === null || v === undefined || v === "") return null;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

function decodeAmendments(raw: unknown): Record<string, unknown>[] {
  if (raw === null || raw === undefined || raw === "") return [];
  if (Array.isArray(raw))
    return raw.filter((e) => e !== null && typeof e === "object" && !Array.isArray(e));
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e !== null && typeof e === "object" && !Array.isArray(e));
  } catch {
    return [];
  }
}

function encodeAmendments(entries: unknown): string {
  if (!entries) return "[]";
  return pyDumps(entries);
}

function filterWhere(filter: RowFilter | null): [string, unknown[]] {
  const f = filter ?? makeRowFilter();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.types && f.types.size) {
    const types = [...f.types].sort();
    clauses.push(`type IN (${types.map(() => "?").join(",")})`);
    params.push(...types);
  }
  if (f.trackIds && f.trackIds.size) {
    const ids = [...f.trackIds].sort();
    let group = `track_id IN (${ids.map(() => "?").join(",")})`;
    if (f.includeNullTrack) group = `(${group} OR track_id IS NULL)`;
    clauses.push(group);
    params.push(...ids);
  }
  if (f.since) {
    clauses.push("ts >= ?");
    params.push(f.since);
  }
  return [clauses.join(" AND "), params];
}

function eventFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row["payload"];
  let payload: Record<string, unknown> = {};
  if (raw) {
    try {
      const decoded: unknown = JSON.parse(String(raw));
      if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
        payload = decoded as Record<string, unknown>;
      }
    } catch (exc) {
      throw new StateError(
        `corrupt event payload (events.id=${row["id"]}): ${(exc as Error).message}`,
      );
    }
  }
  return {
    project_id: row["project_id"],
    track_id: row["track_id"],
    type: row["type"],
    ts: row["ts"],
    payload,
  };
}

function decisionFromRow(row: Record<string, unknown>): Record<string, unknown> {
  let full: Record<string, unknown> = {};
  if (row["payload"]) {
    try {
      const decoded: unknown = JSON.parse(String(row["payload"]));
      if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) {
        full = decoded as Record<string, unknown>;
      }
    } catch {
      full = {};
    }
  }
  if (Object.keys(full).length) return full;
  return {
    id: row["id"],
    project_id: row["project_id"],
    track_id: row["track_id"],
    ts: row["ts"],
    decision: row["decision"],
    rationale: row["rationale"],
    source: row["source"],
    irreversible: Boolean(row["irreversible"]),
    author: row["author"],
  };
}

export class TursoRepository implements Store {
  readonly root: string;
  private readonly dbPath: string;
  private db: Database | null = null;
  private mutex: Promise<void> = Promise.resolve();
  /**
   * AsyncLocalStorage marks the async call chain currently inside this
   * repo's transaction. A nested lock() on the SAME repo (e.g. turn_report
   * calling worker_report) takes a SAVEPOINT instead of re-acquiring the
   * mutex (which would deadlock) or double-BEGIN-ing (which would fail).
   * A concurrent rival runs in a different async chain, sees no context,
   * and serializes on the mutex + BEGIN IMMEDIATE as usual. Mirrors
   * Python Store.lock's `conn.in_transaction` outer/inner split.
   */
  private readonly txContext = new AsyncLocalStorage<true>();

  private constructor(root: string, dbPath: string) {
    this.root = root;
    this.dbPath = dbPath;
  }

  /**
   * One-shot script execution against a database file (fixture loading,
   * harness setup). Keeps ALL driver contact inside this module so the
   * turso-import gate holds for every other file in the package.
   */
  static async execScript(dbPath: string, sql: string): Promise<void> {
    const db = await TursoRepository.connectWithRetry(path.resolve(dbPath));
    try {
      await db.exec(sql);
    } finally {
      await db.close();
    }
  }

  /** One-shot row query (harness verification reads). */
  static async queryRows(
    dbPath: string,
    sql: string,
    ...params: unknown[]
  ): Promise<Record<string, unknown>[]> {
    const db = await TursoRepository.connectWithRetry(path.resolve(dbPath));
    try {
      return (await db.all(sql, ...params)) as Record<string, unknown>[];
    } finally {
      await db.close();
    }
  }

  private static async connectWithRetry(dbPath: string, tries = 5): Promise<Database> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        return await connect(dbPath);
      } catch (exc) {
        lastError = exc;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  static async open(root: string, dbPath: string): Promise<TursoRepository> {
    const repo = new TursoRepository(path.resolve(root), path.resolve(dbPath));
    // Turso 0.7.2 releases file locks asynchronously: retry the open so a
    // server booting right behind setup never fails on a stale lock.
    repo.db = await TursoRepository.connectWithRetry(repo.dbPath);
    try {
      await repo.db.exec("PRAGMA journal_mode=WAL;");
    } catch {
      /* best-effort, mirrors db.get_connection */
    }
    try {
      await repo.db.exec("PRAGMA synchronous=NORMAL;");
    } catch {
      /* best-effort */
    }
    try {
      await repo.db.exec("PRAGMA foreign_keys=ON;");
    } catch {
      /* best-effort */
    }
    // Deliberate deviation from Python (which sets busy_timeout=5000):
    // busy_timeout=0 FAILS FAST on a held lock instead of blocking the Node
    // event loop inside the native call (measured: a 5000-budget BEGIN blocks
    // the loop for the full budget, starving the holder's own COMMIT past the
    // waiter's deadline). Waiting is done cooperatively in
    // beginImmediateWithRetry, which yields between attempts so the holder
    // progresses — same observable behavior (~5s wait, then the original
    // error) without freezing the server.
    try {
      await repo.db.exec("PRAGMA busy_timeout=0;");
    } catch {
      /* best-effort */
    }
    await repo.db.exec(FLEET_SCHEMA_SQL);
    // record schema version (idempotent)
    const existing = (await repo.db.get(
      "SELECT value FROM meta WHERE key=?",
      "schema_version:2",
    )) as Record<string, unknown> | undefined;
    if (!existing) {
      await repo.db.run(
        "INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)",
        "schema_version:2",
        utcnowIso(),
      );
    }
    return repo;
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  private conn(): Database {
    if (!this.db) throw new StateError("repository is closed");
    return this.db;
  }

  /**
   * BEGIN IMMEDIATE with bounded retry-with-backoff.
   *
   * Python honors busy_timeout=5000 and WAITS on a contended ledger; Turso
   * 0.7.2 fresh connects fail fast on busy|locked instead (the PRAGMA is set
   * but not honored for the initial lock grab). Without this retry, TS tool
   * calls error wherever Python waits — the failure mode that matters in the
   * M3 dual-alive window with both backends on one DB. Total budget ~5s to
   * match Python's observable behavior; afterwards the ORIGINAL (last busy)
   * error is thrown, never synthesized. Non-busy errors throw immediately.
   */
  private static async beginImmediateWithRetry(db: Database): Promise<void> {
    const budgetMs = 5000;
    const deadline = Date.now() + budgetMs;
    let backoffMs = 20;
    let lastError: unknown = null;
    for (;;) {
      try {
        await db.exec("BEGIN IMMEDIATE");
        return;
      } catch (exc) {
        if (!/busy|locked/i.test((exc as Error)?.message ?? String(exc))) throw exc;
        lastError = exc;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw lastError;
        await new Promise((r) => setTimeout(r, Math.min(backoffMs, remaining)));
        backoffMs = Math.min(250, Math.floor(backoffMs * 1.5));
      }
    }
  }

  async lock<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    // Nested lock on the same repo inside an open transaction: SAVEPOINT,
    // mirroring Python Store.lock's inner arm (RELEASE / ROLLBACK TO +
    // RELEASE). The name is advisory only in SQL mode, as in Python.
    if (this.txContext.getStore() === true) {
      const db = this.conn();
      await db.exec("SAVEPOINT store_lock");
      try {
        const out = await fn();
        await db.exec("RELEASE SAVEPOINT store_lock");
        return out;
      } catch (exc) {
        try {
          await db.exec("ROLLBACK TO SAVEPOINT store_lock");
          await db.exec("RELEASE SAVEPOINT store_lock");
        } catch {
          /* best-effort, mirrors Python's except-pass */
        }
        throw exc;
      }
    }
    // Outermost boundary: intra-process serialization via the mutex plus
    // cross-process exclusion via BEGIN IMMEDIATE on the single connection
    // (mirrors Python Store.lock's SQL mode: BEGIN IMMEDIATE, commit on
    // success, rollback on error). Every lock body — saveTrack's
    // DELETE-then-N-INSERTs, turn read-compute-write triples — is atomic.
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      const db = this.conn();
      await TursoRepository.beginImmediateWithRetry(db);
      try {
        const out = await this.txContext.run(true, fn);
        await db.exec("COMMIT");
        return out;
      } catch (exc) {
        try {
          await db.exec("ROLLBACK");
        } catch {
          /* best-effort, mirrors Python's except-pass */
        }
        throw exc;
      }
    } finally {
      release();
    }
  }

  projectFile(projectId: string): string {
    return path.join(this.root, "projects", projectId, "project.json");
  }

  async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    // Always file-based (mirrors Store.write_json_atomic: tmp + os.replace,
    // json.dumps(indent=2) + "\n"). Used for sidecar files even in SQL mode.
    const { mkdirSync, writeFileSync, renameSync } = await import("node:fs");
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, filePath);
  }

  // -- projects --

  async createProject(
    name: string,
    repos?: Record<string, unknown>[] | string[] | null,
    harness = "omp",
    system = false,
  ): Promise<Project> {
    const slug = slugify(name);
    if (slug.trim().toLowerCase() === SYSTEM_PROJECT_SLUG && !system) {
      throw new StateError(
        `project slug ${pyRepr(slug)} is reserved for the system and may not be ` +
          `user-created (it identifies the ${pyRepr("Orchestration System")} project); pick another name`,
      );
    }
    return this.createProjectInner(name, slug, repos, harness, system);
  }

  private async createProjectInner(
    name: string,
    slug: string,
    repos: Record<string, unknown>[] | string[] | null | undefined,
    harness: string,
    system: boolean,
  ): Promise<Project> {
    const db = this.conn();
    const dup = (await db.get("SELECT id, slug FROM orch_projects WHERE slug=?", slug)) as
      | Record<string, unknown>
      | undefined;
    if (dup) throw new StateError(`project slug already exists: ${slug} (${dup["id"]})`);
    const project: Project = {
      id: newId("p"),
      name,
      slug,
      harness,
      created_at: utcnowIso(),
      system,
      repos: [],
    };
    for (const repo of repos || []) {
      let repoName: string;
      if (repo !== null && typeof repo === "object" && !Array.isArray(repo)) {
        const rec = repo as Record<string, unknown>;
        repoName = "name" in rec ? String(rec["name"]) : pyDictStr(rec);
      } else {
        repoName = String(repo);
      }
      project.repos.push({ name: repoName, validated: false, validated_at: null });
    }
    const reposJson = pyDumps(project.repos);
    await db.run(
      "INSERT INTO orch_projects(id, slug, name, harness, repos, created_at, system) VALUES(?, ?, ?, ?, ?, ?, ?)",
      project.id,
      project.slug,
      project.name,
      project.harness,
      reposJson,
      project.created_at,
      project.system ? 1 : 0,
    );
    await this.appendEvent(
      {
        ts: utcnowIso(),
        type: "project_created",
        project_id: project.id,
        track_id: null,
        payload: { name, repos: project.repos.map((r) => r.name), system: project.system },
      },
      project.id,
    );
    return project;
  }

  private rowToProject(row: Record<string, unknown>): Project {
    const reposRaw = row["repos"] ? JSON.parse(String(row["repos"])) : [];
    const proj: Project = {
      id: String(row["id"]),
      name: String(row["name"]),
      slug: String(row["slug"]),
      harness: String(row["harness"]),
      created_at: String(row["created_at"]),
      system: Boolean(row["system"] ?? false),
      repos: [],
    };
    proj.repos = (reposRaw as Record<string, unknown>[]).map((r) => ({
      name: String(r["name"] ?? ""),
      validated: Boolean(r["validated"] ?? false),
      validated_at: (r["validated_at"] as string | null) ?? null,
    }));
    return proj;
  }

  async getProject(projectId: string): Promise<Project> {
    const row = (await this.conn().get("SELECT * FROM orch_projects WHERE id=?", projectId)) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new StateError(`not found: ${this.projectFile(projectId)}`);
    return this.rowToProject(row);
  }

  async findProjectBySlug(slug: string): Promise<Project | null> {
    const target = String(slug || "").trim();
    if (!target) return null;
    const row = (await this.conn().get("SELECT * FROM orch_projects WHERE slug=?", target)) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return this.rowToProject(row);
  }

  async findSystemProject(slug: string): Promise<Project | null> {
    const project = await this.findProjectBySlug(slug);
    if (!project || !project.system) return null;
    return project;
  }

  async listProjects(): Promise<Project[]> {
    const rows = (await this.conn().all(
      "SELECT * FROM orch_projects ORDER BY created_at ASC",
    )) as Record<string, unknown>[];
    const out: Project[] = [];
    for (const row of rows) {
      try {
        out.push(this.rowToProject(row));
      } catch {
        /* skip corrupt rows */
      }
    }
    return out;
  }

  // -- tracks --

  async createTrack(
    projectId: string,
    epic: string,
    goal: string,
    repo = "",
    branch = "",
  ): Promise<Track> {
    await this.getProject(projectId);
    const cleanEpic = String(epic).trim();
    const cleanGoal = String(goal).trim();
    if (!cleanEpic || !cleanGoal) throw new StateError("must be a non-empty string");
    const now = utcnowIso();
    const track: Track = {
      id: newId("t"),
      project_id: projectId,
      epic: cleanEpic,
      goal: cleanGoal,
      repo,
      branch,
      status: "active",
      leader: null,
      heartbeats: defaultHeartbeatBinding(),
      workers: [],
      queue: [],
      handoff: defaultHandoff(),
      turn_count: 0,
      created_at: now,
      updated_at: now,
      overrides: {},
      overrides_provenance: {},
    };
    const db = this.conn();
    await db.run(
      `INSERT INTO orch_tracks(id, project_id, epic, goal, repo, branch, status, leader_binding, heartbeats, handoff, overrides, overrides_provenance, turn_count, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      track.id,
      track.project_id,
      track.epic,
      track.goal,
      track.repo,
      track.branch,
      track.status,
      null,
      pyDumps(track.heartbeats),
      pyDumps(track.handoff),
      pyDumps(track.overrides),
      pyDumps(track.overrides_provenance),
      track.turn_count,
      track.created_at,
      track.updated_at,
    );
    await this.appendEvent(
      {
        ts: utcnowIso(),
        type: "track_created",
        project_id: projectId,
        track_id: track.id,
        payload: { epic, repo, branch },
      },
      projectId,
    );
    return track;
  }

  async saveTrack(track: Track): Promise<void> {
    track.updated_at = utcnowIso();
    const db = this.conn();
    const leaderJson = track.leader ? pyDumps(track.leader) : null;
    const heartbeatsJson = track.heartbeats
      ? pyDumps(track.heartbeats)
      : pyDumps({ checkup_id: null, deep_id: null, confirmed_at: null });
    const handoffJson = track.handoff ? pyDumps(track.handoff) : pyDumps({ state: "none" });
    await db.run(
      `INSERT INTO orch_tracks(id, project_id, epic, goal, repo, branch, status, leader_binding, heartbeats, handoff, overrides, overrides_provenance, turn_count, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         epic=excluded.epic, goal=excluded.goal, repo=excluded.repo, branch=excluded.branch,
         status=excluded.status, leader_binding=excluded.leader_binding, heartbeats=excluded.heartbeats,
         handoff=excluded.handoff, overrides=excluded.overrides, overrides_provenance=excluded.overrides_provenance,
         turn_count=excluded.turn_count, updated_at=excluded.updated_at`,
      track.id,
      track.project_id,
      track.epic,
      track.goal,
      track.repo,
      track.branch,
      track.status,
      leaderJson,
      heartbeatsJson,
      handoffJson,
      pyDumps(track.overrides || {}),
      pyDumps(track.overrides_provenance || {}),
      track.turn_count,
      track.created_at,
      track.updated_at,
    );
    await db.run("DELETE FROM orch_tasks WHERE track_id=?", track.id);
    for (const item of track.queue) {
      await db.run(
        `INSERT INTO orch_tasks(id, track_id, project_id, title, detail, gate, status, progress, assignee, added_at, updated_at, note, detail_amendments)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        item.id,
        track.id,
        track.project_id,
        item.title,
        item.detail,
        item.gate,
        item.status,
        item.progress,
        item.assignee,
        item.added_at,
        item.updated_at,
        item.note,
        encodeAmendments(item.detail_amendments),
      );
    }
    await db.run("DELETE FROM orch_workers WHERE track_id=?", track.id);
    for (const w of track.workers) {
      const evalJson = w.evaluation ? pyDumps(w.evaluation) : null;
      const telemetryJson =
        w.evaluation && w.evaluation.telemetry ? pyDumps(w.evaluation.telemetry) : null;
      await db.run(
        `INSERT INTO orch_workers(track_id, agent_id, role, model, dispatched_at, status, evaluation, telemetry)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        track.id,
        w.agent_id,
        w.role,
        w.model,
        w.dispatched_at,
        w.status,
        evalJson,
        telemetryJson,
      );
    }
  }

  private trackRowToModel(
    row: Record<string, unknown>,
    tasks: Record<string, unknown>[] | null,
    workers: Record<string, unknown>[] | null,
  ): Track {
    return coerceTrackFull({
      id: row["id"],
      project_id: row["project_id"],
      epic: row["epic"],
      goal: row["goal"],
      repo: row["repo"],
      branch: row["branch"],
      status: row["status"],
      leader: jload(row["leader_binding"]),
      heartbeats: jload(row["heartbeats"]),
      handoff: jload(row["handoff"]),
      overrides: jload(row["overrides"]),
      overrides_provenance: jload(row["overrides_provenance"]),
      workers: workers ?? [],
      queue: tasks ?? [],
      turn_count: row["turn_count"],
      created_at: row["created_at"],
      updated_at: row["updated_at"],
    });
  }

  async getTrack(trackId: string): Promise<Track> {
    const db = this.conn();
    const row = (await db.get("SELECT * FROM orch_tracks WHERE id=?", trackId)) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new StateError(`track not found: ${trackId}`);
    const taskRows = (await db.all(
      "SELECT * FROM orch_tasks WHERE track_id=? ORDER BY added_at ASC",
      trackId,
    )) as Record<string, unknown>[];
    const tasks = taskRows.map((tr) => ({
      id: tr["id"],
      title: tr["title"],
      detail: tr["detail"],
      gate: tr["gate"],
      status: tr["status"],
      progress: Number(tr["progress"] ?? 0),
      assignee: tr["assignee"],
      added_at: tr["added_at"],
      updated_at: tr["updated_at"],
      note: (tr["note"] as string) || "",
      detail_amendments: decodeAmendments(tr["detail_amendments"]),
    }));
    const workerRows = (await db.all(
      "SELECT * FROM orch_workers WHERE track_id=? ORDER BY dispatched_at ASC",
      trackId,
    )) as Record<string, unknown>[];
    const workers = workerRows.map((wr) => ({
      agent_id: wr["agent_id"],
      role: wr["role"],
      model: wr["model"],
      dispatched_at: wr["dispatched_at"],
      status: wr["status"],
      evaluation: wr["evaluation"] ? JSON.parse(String(wr["evaluation"])) : null,
    }));
    return this.trackRowToModel(row, tasks, workers);
  }

  async listTracks(projectId?: string | null): Promise<Track[]> {
    const db = this.conn();
    const rows = (
      projectId
        ? await db.all(
            "SELECT * FROM orch_tracks WHERE project_id=? ORDER BY created_at ASC",
            projectId,
          )
        : await db.all("SELECT * FROM orch_tracks ORDER BY created_at ASC")
    ) as Record<string, unknown>[];
    const out: Track[] = [];
    for (const row of rows) {
      try {
        const tid = String(row["id"]);
        const taskRows = (await db.all(
          "SELECT * FROM orch_tasks WHERE track_id=? ORDER BY added_at ASC",
          tid,
        )) as Record<string, unknown>[];
        const tasks = taskRows.map((tr) => ({
          id: tr["id"],
          title: tr["title"],
          detail: tr["detail"],
          gate: tr["gate"],
          status: tr["status"],
          progress: Number(tr["progress"] ?? 0),
          assignee: tr["assignee"],
          added_at: tr["added_at"],
          updated_at: tr["updated_at"],
          note: (tr["note"] as string) || "",
          detail_amendments: decodeAmendments(tr["detail_amendments"]),
        }));
        const workerRows = (await db.all(
          "SELECT * FROM orch_workers WHERE track_id=? ORDER BY dispatched_at ASC",
          tid,
        )) as Record<string, unknown>[];
        const workers = workerRows.map((wr) => ({
          agent_id: wr["agent_id"],
          role: wr["role"],
          model: wr["model"],
          dispatched_at: wr["dispatched_at"],
          status: wr["status"],
          evaluation: wr["evaluation"] ? JSON.parse(String(wr["evaluation"])) : null,
        }));
        out.push(this.trackRowToModel(row, tasks, workers));
      } catch {
        /* skip corrupt rows */
      }
    }
    return out;
  }

  // -- events --

  async appendEvent(event: FleetEvent, projectId: string): Promise<void> {
    await this.conn().run(
      "INSERT INTO orch_events(project_id, track_id, type, ts, payload) VALUES(?, ?, ?, ?, ?)",
      projectId,
      event.track_id,
      event.type,
      event.ts,
      pyDumps(event.payload),
    );
  }

  async readEvents(projectId: string): Promise<Record<string, unknown>[]> {
    const rows = (await this.conn().all(
      "SELECT project_id, track_id, type, ts, payload FROM orch_events WHERE project_id=? ORDER BY ts ASC, id ASC",
      projectId,
    )) as Record<string, unknown>[];
    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = row["payload"]
          ? (JSON.parse(String(row["payload"])) as Record<string, unknown>)
          : {};
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) payload = {};
      } catch {
        payload = {};
      }
      return {
        project_id: row["project_id"],
        track_id: row["track_id"],
        type: row["type"],
        ts: row["ts"],
        payload,
      };
    });
  }

  // -- decisions --

  async appendDecision(decision: Decision, projectId: string): Promise<void> {
    await this.conn().run(
      "INSERT INTO orch_decisions(id, project_id, track_id, ts, decision, rationale, source, irreversible, author, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      decision.id,
      projectId,
      decision.track_id,
      decision.ts,
      decision.decision,
      decision.rationale,
      decision.source,
      decision.irreversible ? 1 : 0,
      decision.author,
      pyDumps(decision),
    );
  }

  async readDecisions(projectId: string): Promise<Record<string, unknown>[]> {
    const rows = (await this.conn().all(
      "SELECT payload FROM orch_decisions WHERE project_id=? ORDER BY ts ASC, id ASC",
      projectId,
    )) as Record<string, unknown>[];
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(String(row["payload"])));
      } catch {
        /* skip corrupt rows */
      }
    }
    return out;
  }

  // -- turns --

  async nextTurnNumber(projectId: string, trackId: string): Promise<number> {
    const row = (await this.conn().get(
      "SELECT COALESCE(MAX(n), 0) as mx FROM orch_turns WHERE project_id=? AND track_id=?",
      projectId,
      trackId,
    )) as Record<string, unknown> | undefined;
    const mx = row && row["mx"] !== null && row["mx"] !== undefined ? Number(row["mx"]) : 0;
    return mx + 1;
  }

  async saveTurn(projectId: string, trackId: string, delta: TurnDelta): Promise<void> {
    const raw = pyDumps(delta);
    await this.conn().run(
      `INSERT INTO orch_turns(n, project_id, track_id, ts, summary, status, done, next, blockers, decisions, knowledge, author_agent, author_model, raw)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      delta.n,
      projectId,
      trackId,
      delta.ts,
      delta.summary,
      delta.status,
      pyDumps(delta.done),
      pyDumps(delta.next),
      pyDumps(delta.blockers),
      pyDumps(delta.decisions),
      pyDumps(delta.knowledge),
      delta.author_agent,
      delta.author_model,
      raw,
    );
  }

  async readTurns(projectId: string, trackId: string): Promise<Record<string, unknown>[]> {
    const rows = (await this.conn().all(
      "SELECT raw FROM orch_turns WHERE project_id=? AND track_id=? ORDER BY n ASC",
      projectId,
      trackId,
    )) as Record<string, unknown>[];
    return rows.map((row) => {
      try {
        return JSON.parse(String(row["raw"]));
      } catch (exc) {
        throw new StateError(`corrupt turn: ${(exc as Error).message}`);
      }
    });
  }

  // -- bounded reads --

  private boundedSelect(
    table: string,
    columns: string,
    projectId: string,
    filter: RowFilter | null,
    order: string,
    limit: number,
    offset: number,
  ): Promise<Record<string, unknown>[]> {
    const [whereSql, whereParams] = filterWhere(filter);
    const clauses = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (whereSql) {
      clauses.push(whereSql);
      params.push(...whereParams);
    }
    const sql = `SELECT ${columns} FROM ${table} WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`;
    params.push(Math.max(0, Math.trunc(limit)), Math.max(0, Math.trunc(offset)));
    return this.conn().all(sql, ...params) as Promise<Record<string, unknown>[]>;
  }

  private clampLimit(v: unknown, dflt: number): number {
    try {
      return Math.max(1, pyInt(v as number));
    } catch {
      return dflt;
    }
  }

  private clampOffset(v: unknown): number {
    try {
      return Math.max(0, pyInt(v as number));
    } catch {
      return 0;
    }
  }

  async tailEvents(
    projectId: string,
    limit: number,
    offset: number,
    filter: RowFilter | null,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.boundedSelect(
      "orch_events",
      EVENT_COLUMNS,
      projectId,
      filter,
      "ts DESC, id DESC",
      this.clampLimit(limit, 50),
      this.clampOffset(offset),
    );
    return rows.map(eventFromRow);
  }

  async tailDecisions(
    projectId: string,
    limit: number,
    offset: number,
    filter: RowFilter | null,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.boundedSelect(
      "orch_decisions",
      DECISION_COLUMNS,
      projectId,
      filter,
      "ts DESC, id DESC",
      this.clampLimit(limit, 50),
      this.clampOffset(offset),
    );
    return rows.map(decisionFromRow);
  }

  async streamDecisions(
    projectId: string,
    filter: RowFilter | null,
  ): Promise<Record<string, unknown>[]> {
    const [whereSql, whereParams] = filterWhere(filter);
    const clauses = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (whereSql) {
      clauses.push(whereSql);
      params.push(...whereParams);
    }
    const rows = (await this.conn().all(
      `SELECT ${DECISION_COLUMNS} FROM orch_decisions WHERE ${clauses.join(" AND ")} ORDER BY ts ASC, id ASC`,
      ...params,
    )) as Record<string, unknown>[];
    return rows.map(decisionFromRow);
  }

  async resolveTurnNumberAt(
    projectId: string,
    trackId: string,
    since: string,
  ): Promise<number | null> {
    const rows = (await this.conn().all(
      "SELECT n, ts FROM orch_turns WHERE project_id=? AND track_id=? ORDER BY n ASC",
      projectId,
      trackId,
    )) as Record<string, unknown>[];
    for (const row of rows) {
      if (String(row["ts"] || "") >= since) return Number(row["n"]);
    }
    return null;
  }

  async readTurnsPaged(
    projectId: string,
    trackId: string,
    limit: number,
    offset: number,
    since?: string | null,
  ): Promise<Record<string, unknown>[]> {
    let lim: number;
    try {
      lim = pyInt(limit);
    } catch {
      lim = 10;
    }
    lim = Math.max(1, Math.min(100, lim));
    let off: number;
    try {
      off = pyInt(offset);
    } catch {
      off = 0;
    }
    off = Math.max(0, off);
    let minN: number | null = null;
    if (since) {
      minN = await this.resolveTurnNumberAt(projectId, trackId, since);
      if (minN === null) return [];
    }
    const clauses = ["project_id = ?", "track_id = ?"];
    const args: unknown[] = [projectId, trackId];
    if (minN !== null) {
      clauses.push("n >= ?");
      args.push(minN);
    }
    const rows = (await this.conn().all(
      `SELECT raw FROM orch_turns WHERE ${clauses.join(" AND ")} ORDER BY n DESC LIMIT ? OFFSET ?`,
      ...args,
      lim,
      off,
    )) as Record<string, unknown>[];
    return rows.map((row) => {
      try {
        return JSON.parse(String(row["raw"]));
      } catch (exc) {
        throw new StateError(`corrupt turn json: ${(exc as Error).message}`);
      }
    });
  }

  async eventsBytes(projectId: string): Promise<number> {
    const row = (await this.conn().get(
      "SELECT COALESCE(SUM(LENGTH(payload) + LENGTH(type) + LENGTH(ts)), 0) as sz FROM orch_events WHERE project_id=?",
      projectId,
    )) as Record<string, unknown> | undefined;
    return row && row["sz"] !== null && row["sz"] !== undefined ? Number(row["sz"]) : 0;
  }

  async decisionsBytes(projectId: string): Promise<number> {
    const row = (await this.conn().get(
      "SELECT COALESCE(SUM(LENGTH(payload)), 0) as sz FROM orch_decisions WHERE project_id=?",
      projectId,
    )) as Record<string, unknown> | undefined;
    return row && row["sz"] !== null && row["sz"] !== undefined ? Number(row["sz"]) : 0;
  }

  // -- suggestions --

  async readSuggestions(projectId: string): Promise<Record<string, unknown>[]> {
    const rows = (await this.conn().all(
      "SELECT * FROM orch_suggestions WHERE project_id=? ORDER BY created_at ASC",
      projectId,
    )) as Record<string, unknown>[];
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      try {
        out.push({
          id: row["id"],
          track_id: row["track_id"],
          project_id: row["project_id"],
          agent_id: row["agent_id"],
          kind: row["kind"],
          title: row["title"],
          body: row["body"],
          tags: row["tags"] ? JSON.parse(String(row["tags"])) : [],
          status: row["status"],
          slug: row["slug"],
          created_at: row["created_at"],
          reviewed_at: row["reviewed_at"],
          reviewer: row["reviewer"],
          note: row["note"],
          result: row["result"] ? JSON.parse(String(row["result"])) : {},
        });
      } catch {
        /* skip corrupt rows */
      }
    }
    return out;
  }

  async writeSuggestions(projectId: string, suggestions: Record<string, unknown>[]): Promise<void> {
    const db = this.conn();
    await db.run("DELETE FROM orch_suggestions WHERE project_id=?", projectId);
    for (const s of suggestions) {
      await db.run(
        `INSERT INTO orch_suggestions(id, track_id, project_id, agent_id, kind, title, body, tags, status, slug, created_at, reviewed_at, reviewer, note, result)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s["id"],
        s["track_id"],
        s["project_id"],
        s["agent_id"],
        s["kind"],
        s["title"],
        s["body"],
        pyDumps(s["tags"] || []),
        s["status"],
        s["slug"],
        s["created_at"],
        s["reviewed_at"],
        s["reviewer"],
        (s["note"] as string) || "",
        pyDumps(s["result"] || {}),
      );
    }
  }

  // -- model evaluations --

  async readModelEvaluations(projectId: string): Promise<Record<string, unknown>[]> {
    const rows = (await this.conn().all(
      "SELECT * FROM orch_model_evaluations WHERE project_id=? ORDER BY evaluated_at ASC",
      projectId,
    )) as Record<string, unknown>[];
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      try {
        out.push({
          id: row["id"],
          track_id: row["track_id"],
          project_id: row["project_id"],
          agent_id: row["agent_id"],
          model: row["model"],
          scores: row["scores"] ? JSON.parse(String(row["scores"])) : {},
          task_complexity: row["task_complexity"],
          task_size: row["task_size"],
          telemetry: row["telemetry"] ? JSON.parse(String(row["telemetry"])) : null,
          notes: (row["notes"] as string) || "",
          reviewer: row["reviewer"],
          evaluated_at: row["evaluated_at"],
          history: row["history"] ? JSON.parse(String(row["history"])) : [],
        });
      } catch {
        /* skip corrupt rows */
      }
    }
    return out;
  }

  async writeModelEvaluations(
    projectId: string,
    evaluations: Record<string, unknown>[],
  ): Promise<void> {
    const db = this.conn();
    await db.run("DELETE FROM orch_model_evaluations WHERE project_id=?", projectId);
    for (const e of evaluations) {
      await db.run(
        `INSERT INTO orch_model_evaluations(id, track_id, project_id, agent_id, model, scores, task_complexity, task_size, telemetry, notes, reviewer, evaluated_at, history)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e["id"],
        e["track_id"],
        e["project_id"],
        e["agent_id"],
        e["model"],
        pyDumps(e["scores"] || {}),
        orZeroInt(e["task_complexity"]),
        orZeroInt(e["task_size"]),
        e["telemetry"] !== null && e["telemetry"] !== undefined ? pyDumps(e["telemetry"]) : null,
        (e["notes"] as string) || "",
        (e["reviewer"] as string) || "",
        (e["evaluated_at"] as string) || "",
        pyDumps(e["history"] || []),
      );
    }
  }
}

function orZeroInt(v: unknown): number {
  try {
    if (!v) return 0;
    return pyInt(v);
  } catch {
    return 0;
  }
}

function pyDictStr(rec: Record<string, unknown>): string {
  // str(dict) for a repo entry without a name key (matches CPython str()).
  const parts = Object.entries(rec).map(([k, val]) => `'${k}': ${pyValStr(val)}`);
  return `{${parts.join(", ")}}`;
}

function pyValStr(val: unknown): string {
  if (typeof val === "string") return `'${val}'`;
  if (val === null || val === undefined) return "None";
  if (typeof val === "boolean") return val ? "True" : "False";
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) return `[${val.map(pyValStr).join(", ")}]`;
  if (typeof val === "object") return pyDictStr(val as Record<string, unknown>);
  return String(val);
}

/** Full-fallback port of Store._track_row_to_model (null/empty/{} JSON cols). */
function coerceTrackFull(raw: Record<string, unknown>): import("../domain/models.js").Track {
  const hbRaw = raw["heartbeats"] as Record<string, unknown> | null;
  const hoRaw = raw["handoff"] as Record<string, unknown> | null;
  const ovRaw = raw["overrides"] as Record<string, unknown> | null;
  const opRaw = raw["overrides_provenance"] as Record<string, unknown> | null;
  const hb = hbRaw && Object.keys(hbRaw).length ? hbRaw : null;
  const ho = hoRaw && Object.keys(hoRaw).length ? hoRaw : null;
  return coerceTrack({
    ...raw,
    heartbeats: Object.assign(
      {
        checkup_id: null,
        deep_id: null,
        confirmed_at: null,
        schedule_id: null,
        orchestrator_checkup_id: null,
        generation_started_at: null,
        digest_last_written_at: null,
        checkup_history: [],
      },
      hb ?? {},
    ),
    handoff: Object.assign(
      {
        state: "none",
        from_agent: null,
        to_agent: null,
        reason: "",
        started_at: null,
        completed_at: null,
      },
      ho ?? {},
    ),
    overrides: ovRaw && Object.keys(ovRaw).length ? ovRaw : {},
    overrides_provenance: opRaw && Object.keys(opRaw).length ? opRaw : {},
  });
}
