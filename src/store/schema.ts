/**
 * fleet.db v1 schema — renamed from mcp-orchestration/state/db.py SCHEMA_SQL.
 *
 * Mapping (recorded for the parity harness, which compares after un-prefixing):
 *   projects          -> orch_projects            (columns identical)
 *   tracks            -> orch_tracks              (columns identical)
 *   tasks             -> orch_tasks                (columns identical)
 *   workers           -> orch_workers              (columns identical)
 *   turns             -> orch_turns                (columns identical)
 *   events            -> orch_events               (columns identical)
 *   decisions         -> orch_decisions            (columns identical)
 *   suggestions       -> orch_suggestions          (columns identical)
 *   model_evaluations -> orch_model_evaluations    (columns identical)
 *   schema_version(version, applied_at)
 *                     -> meta(key, value)          (rows: 'schema_version:<n>' -> applied_at)
 *   idx_*             -> idx_orch_*                (same columns)
 *   events_no_update / events_no_delete
 *                     -> orch_events_no_update / orch_events_no_delete
 *                        (same RAISE(ABORT, 'events is INSERT-ONLY') payload)
 *   decisions_no_update / decisions_no_delete
 *                     -> orch_decisions_no_update / orch_decisions_no_delete
 *                        (same RAISE(ABORT, 'decisions is INSERT-ONLY') payload)
 */

export const SCHEMA_VERSION = 2;

export const FLEET_SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

-- meta (replaces schema_version): one row per applied version,
-- key 'schema_version:<n>' -> applied_at ISO timestamp
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- orch_projects
CREATE TABLE IF NOT EXISTS orch_projects (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    harness TEXT NOT NULL,
    repos TEXT NOT NULL,
    created_at TEXT NOT NULL,
    system INTEGER NOT NULL DEFAULT 0
);

-- orch_tracks
CREATE TABLE IF NOT EXISTS orch_tracks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES orch_projects(id) ON DELETE CASCADE,
    epic TEXT NOT NULL,
    goal TEXT NOT NULL,
    repo TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    leader_binding TEXT,
    heartbeats TEXT,
    handoff TEXT,
    overrides TEXT,
    overrides_provenance TEXT,
    turn_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orch_tracks_project_id ON orch_tracks(project_id);

-- orch_tasks
CREATE TABLE IF NOT EXISTS orch_tasks (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES orch_tracks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES orch_projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    gate TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    assignee TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    detail_amendments TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_orch_tasks_track_id ON orch_tasks(track_id);
CREATE INDEX IF NOT EXISTS idx_orch_tasks_project_id ON orch_tasks(project_id);

-- orch_workers
CREATE TABLE IF NOT EXISTS orch_workers (
    track_id TEXT NOT NULL REFERENCES orch_tracks(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    dispatched_at TEXT NOT NULL,
    status TEXT NOT NULL,
    evaluation TEXT,
    telemetry TEXT,
    PRIMARY KEY (track_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_orch_workers_track_id ON orch_workers(track_id);

-- orch_events: INSERT-ONLY
CREATE TABLE IF NOT EXISTS orch_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES orch_projects(id) ON DELETE CASCADE,
    track_id TEXT,
    type TEXT NOT NULL,
    ts TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS orch_events_no_update BEFORE UPDATE ON orch_events BEGIN
    SELECT RAISE(ABORT, 'events is INSERT-ONLY');
END;
CREATE TRIGGER IF NOT EXISTS orch_events_no_delete BEFORE DELETE ON orch_events BEGIN
    SELECT RAISE(ABORT, 'events is INSERT-ONLY');
END;
CREATE INDEX IF NOT EXISTS idx_orch_events_project_ts ON orch_events(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_orch_events_track_ts ON orch_events(track_id, ts);
CREATE INDEX IF NOT EXISTS idx_orch_events_type ON orch_events(type);

-- orch_decisions: INSERT-ONLY immutable
CREATE TABLE IF NOT EXISTS orch_decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES orch_projects(id) ON DELETE CASCADE,
    track_id TEXT,
    ts TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    irreversible INTEGER NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS orch_decisions_no_update BEFORE UPDATE ON orch_decisions BEGIN
    SELECT RAISE(ABORT, 'decisions is INSERT-ONLY');
END;
CREATE TRIGGER IF NOT EXISTS orch_decisions_no_delete BEFORE DELETE ON orch_decisions BEGIN
    SELECT RAISE(ABORT, 'decisions is INSERT-ONLY');
END;
CREATE INDEX IF NOT EXISTS idx_orch_decisions_project_ts ON orch_decisions(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_orch_decisions_track_ts ON orch_decisions(track_id, ts);

-- orch_turns
CREATE TABLE IF NOT EXISTS orch_turns (
    n INTEGER NOT NULL,
    project_id TEXT NOT NULL REFERENCES orch_projects(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES orch_tracks(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    done TEXT NOT NULL,
    next TEXT NOT NULL,
    blockers TEXT NOT NULL,
    decisions TEXT NOT NULL,
    knowledge TEXT NOT NULL,
    author_agent TEXT NOT NULL DEFAULT '',
    author_model TEXT NOT NULL DEFAULT '',
    raw TEXT NOT NULL,
    PRIMARY KEY (track_id, n)
);
CREATE INDEX IF NOT EXISTS idx_orch_turns_track_n ON orch_turns(track_id, n);
CREATE INDEX IF NOT EXISTS idx_orch_turns_project_ts ON orch_turns(project_id, ts);

-- orch_suggestions
CREATE TABLE IF NOT EXISTS orch_suggestions (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES orch_tracks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES orch_projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT NOT NULL,
    status TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewer TEXT,
    note TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orch_suggestions_project_ts ON orch_suggestions(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orch_suggestions_track_ts ON orch_suggestions(track_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orch_suggestions_status ON orch_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_orch_suggestions_kind ON orch_suggestions(kind);

-- orch_model_evaluations
CREATE TABLE IF NOT EXISTS orch_model_evaluations (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL REFERENCES orch_tracks(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES orch_projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    scores TEXT NOT NULL,
    task_complexity INTEGER NOT NULL,
    task_size INTEGER NOT NULL,
    telemetry TEXT,
    notes TEXT NOT NULL DEFAULT '',
    reviewer TEXT NOT NULL,
    evaluated_at TEXT NOT NULL,
    history TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orch_model_evals_project_ts ON orch_model_evaluations(project_id, evaluated_at);
CREATE INDEX IF NOT EXISTS idx_orch_model_evals_track_ts ON orch_model_evaluations(track_id, evaluated_at);
CREATE INDEX IF NOT EXISTS idx_orch_model_evals_agent ON orch_model_evaluations(agent_id);
`;
