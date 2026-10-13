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
 *   v3 (team domain, LLM-Agents-Orchestration#70)
 *                     -> teams / team_tracks / seats / seat_sessions
 *                        (new tables, no rename — they have no Python
 *                         counterpart, so nothing to un-prefix for parity)
 *   v6 (Team Room, contract moct-team-room v0.3 §2)
 *                     -> team_operations / team_session_runs / team_thread_summaries
 *                        (new tables, no Python counterpart). Versions 4 and 5 are
 *                        reserved for paseo #68 (room_messages) and #69 (task_attempts);
 *                        they are cherry-picked later and are NOT in this file yet.
 *   v7 (Team Room read models, additive)
 *                     -> team_turns / team_thread_bindings
 *                        (server-side projections of team_operations; derived, so
 *                         they can be dropped and rebuilt from the log)
 *   v8 (Team memory, additive)
 *                     -> team_memory_records / _tags / _links / _versions / _settings
 *                        (typed records with visibility tags; backend-owned state,
 *                         NOT a projection of the ledger: how_to_work spans
 *                         Workspaces and a purge must remove text, which an
 *                         append-only log cannot)
 */

export const SCHEMA_VERSION = 8;

/**
 * Versions whose DDL ships in FLEET_SCHEMA_SQL, oldest first. FLEET_SCHEMA_SQL
 * is idempotent (CREATE TABLE IF NOT EXISTS), so opening an older fleet.db
 * applies the missing tables; each version then gets its own `meta` row
 * (`schema_version:<n>` -> applied_at), which is how this DB records the
 * migration history. Never drop a version from this list.
 */
export const APPLIED_SCHEMA_VERSIONS: readonly number[] = [2, 3, 6, 7, 8];

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

-- teams (#70 team domain, schema v3). A team is long-lived and sits ABOVE
-- tracks: it owns the seats and spans many tracks over time (G6). There is no
-- project_id column — the project is reached through team_tracks ->
-- orch_tracks.project_id, so one team may span tracks in several projects.
CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mission TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

-- team_tracks: team -> track membership. No FK onto orch_tasks/orch_workers:
-- saveTrack() DELETEs and re-INSERTs those rows, so anything anchoring on them
-- would be wiped by an unrelated track save (#70 finding 9). orch_tracks rows
-- are upserted (INSERT .. ON CONFLICT DO UPDATE), so this FK is safe.
CREATE TABLE IF NOT EXISTS team_tracks (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES orch_tracks(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, track_id)
);

-- seats: the seat (position) IS the identity — sessions, models and Paseo
-- agent ids are disposable and attach to a seat. first_mate is DERIVED, never
-- caller-supplied: only 'lead' and 'architect' are first-mate (#70). role and
-- tier record the fleet position this seat maps onto.
CREATE TABLE IF NOT EXISTS seats (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    seat TEXT NOT NULL,
    role TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT '',
    first_mate INTEGER NOT NULL DEFAULT 0,
    persona_md TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (team_id, seat)
);

-- seat_sessions: seat -> agent-id history. 'ended_at IS NULL' = live. A
-- first-mate seat holds AT MOST ONE live row (its binding is a single identity);
-- a pooled worker seat may hold many (G4: role seats are pools). FK is on
-- team_id only, not (team_id, seat): a session row is ledger history and must
-- survive the seat being redefined, while dropping a team still cleans up.
CREATE TABLE IF NOT EXISTS seat_sessions (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    seat TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_seat_sessions_live ON seat_sessions(team_id, seat, ended_at);
CREATE INDEX IF NOT EXISTS idx_seat_sessions_agent ON seat_sessions(agent_id);
-- team_operations: the Team Room append-only operations log (contract §2).
-- One row per ledger operation. sequence is assigned by the ledger and is never
-- renumbered here: PRIMARY KEY (workspace_id, sequence) makes a duplicate a 409.
-- operation_id is globally unique so a retried POST is idempotent.
CREATE TABLE IF NOT EXISTS team_operations (
    workspace_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    record_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, sequence)
);

-- team_session_runs: SessionRun stats rows (contract §3.2), one per dsh session.
-- thread_refs_json is a JSON array; the per-thread lookup filters it in code.
CREATE TABLE IF NOT EXISTS team_session_runs (
    session_id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    parent_session_id TEXT,
    thread_refs_json TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    run_ms INTEGER NOT NULL DEFAULT 0,
    model_provider TEXT NOT NULL DEFAULT '',
    model_name TEXT NOT NULL DEFAULT '',
    last_assistant_at TEXT,
    state TEXT NOT NULL DEFAULT 'warm'
);
CREATE INDEX IF NOT EXISTS idx_team_session_runs_member ON team_session_runs(member_id);

-- team_thread_summaries: rolling and wrap-up summaries per thread (contract §3.3).
-- (thread_ref, generation) is unique; the latest generation is the seed.
CREATE TABLE IF NOT EXISTS team_thread_summaries (
    thread_ref TEXT NOT NULL,
    generation INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    text TEXT NOT NULL,
    covers_through_sequence INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    PRIMARY KEY (thread_ref, generation)
);
-- team_turns: read model of team/session-turn-recorded operations (v7). One row
-- per recorded Turn, keyed by the operation it came from. Token columns are NULL
-- when the Turn did not report that figure, so a sum never counts an unknown as 0.
-- Derived from team_operations; rebuildable.
CREATE TABLE IF NOT EXISTS team_turns (
    workspace_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    operation_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    turn INTEGER,
    started_at TEXT,
    ended_at TEXT NOT NULL,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    run_ms INTEGER NOT NULL DEFAULT 0,
    uncached_input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    reasoning_tokens INTEGER,
    thread_refs_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (workspace_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_team_turns_member ON team_turns(workspace_id, member_id, ended_at);
CREATE INDEX IF NOT EXISTS idx_team_turns_session ON team_turns(workspace_id, session_id);

-- team_thread_bindings: current Thread -> Session and Thread -> Instance-slot map
-- per Member (v7), folded from team/thread-session-bound and
-- team/thread-instance-bound. The *_sequence columns record which operation set
-- each half, so an older operation never overwrites a newer one.
CREATE TABLE IF NOT EXISTS team_thread_bindings (
    workspace_id TEXT NOT NULL,
    thread_ref TEXT NOT NULL,
    member_id TEXT NOT NULL,
    session_id TEXT,
    session_reason TEXT,
    session_sequence INTEGER,
    slot INTEGER,
    slot_bound_at TEXT,
    slot_sequence INTEGER,
    PRIMARY KEY (workspace_id, thread_ref, member_id)
);
CREATE INDEX IF NOT EXISTS idx_team_thread_bindings_member ON team_thread_bindings(workspace_id, member_id);

-- team_memory_records: one typed memory record (v8). Backend-owned state, not a
-- projection of the ledger: how_to_work follows an expert across Workspaces and a
-- purge must remove text, which an append-only log cannot.
--   type        rule | decision | convention | how_to_work | task | branch
--   home_*      the narrowest visibility tag (task < channel < team; expert apart),
--               kept in step with team_memory_tags by the store; it picks the
--               injection bucket and wins ties on conflict
--   unique_key  'task:<taskRef>' or 'branch:<repo>#<branch>', NULL for the other
--               types; NULLs are distinct, so only those two types are unique
--   title/body/attrs are NULL only after a purge. embedding is reserved.
CREATE TABLE IF NOT EXISTS team_memory_records (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('rule', 'decision', 'convention', 'how_to_work', 'task', 'branch')),
    title TEXT,
    body TEXT,
    attrs TEXT,
    home_kind TEXT NOT NULL CHECK (home_kind IN ('task', 'channel', 'team', 'expert')),
    home_ref TEXT NOT NULL,
    priority INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'superseded', 'retracted', 'expired', 'purged')),
    flag TEXT,
    supersedes TEXT,
    superseded_by TEXT,
    conflicts_with TEXT NOT NULL DEFAULT '[]',
    task_ref TEXT,
    unique_key TEXT,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('human', 'member')),
    author_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    use_count INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL,
    embedding BLOB,
    CHECK ((type = 'how_to_work') = (workspace_id IS NULL)),
    CHECK (
        (type IN ('rule', 'convention') AND home_kind IN ('team', 'channel'))
        OR (type = 'decision' AND home_kind IN ('channel', 'task'))
        OR (type = 'how_to_work' AND home_kind = 'expert')
        OR (type = 'task' AND home_kind = 'task')
        OR (type = 'branch' AND home_kind = 'channel')
    )
);
CREATE INDEX IF NOT EXISTS idx_team_memory_records_home ON team_memory_records(workspace_id, home_kind, home_ref, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_memory_records_unique_key ON team_memory_records(workspace_id, unique_key);

-- team_memory_tags: who and what a record belongs to (v8). team / channel / task /
-- expert grant visibility; repo / branch only describe and never widen it.
CREATE TABLE IF NOT EXISTS team_memory_tags (
    record_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('team', 'channel', 'task', 'expert', 'repo', 'branch')),
    ref TEXT NOT NULL,
    PRIMARY KEY (record_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_team_memory_tags_ref ON team_memory_tags(kind, ref);

-- team_memory_links: the task picture (v8). Created by the store from a cited
-- taskRef only; a model never names a link target.
CREATE TABLE IF NOT EXISTS team_memory_links (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('on_branch', 'decided_in', 'blocks', 'relates')),
    PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_team_memory_links_to ON team_memory_links(to_id);

-- team_memory_versions: every change to a record, with who and when (v8). All
-- versions are kept. Insert-only, except that a purge may scrub title, body and
-- attrs: first overwrite in place with '#' filler of the same byte length, then
-- set NULL. tags_json snapshots the tags, so a widen keeps the old scope on record.
CREATE TABLE IF NOT EXISTS team_memory_versions (
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'edit', 'pin', 'unpin', 'priority', 'widen', 'approve', 'supersede',
        'retract', 'restore', 'expire', 'purge')),
    workspace_id TEXT,
    type TEXT NOT NULL,
    home_kind TEXT NOT NULL,
    home_ref TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    title TEXT,
    body TEXT,
    attrs TEXT,
    priority INTEGER NOT NULL,
    pinned INTEGER NOT NULL,
    status TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    PRIMARY KEY (memory_id, version)
);
CREATE INDEX IF NOT EXISTS idx_team_memory_versions_feed ON team_memory_versions(workspace_id, type, at);
CREATE TRIGGER IF NOT EXISTS team_memory_versions_no_delete BEFORE DELETE ON team_memory_versions BEGIN
    SELECT RAISE(ABORT, 'team_memory_versions is INSERT-ONLY');
END;
CREATE TRIGGER IF NOT EXISTS team_memory_versions_purge_only BEFORE UPDATE ON team_memory_versions
WHEN (NEW.title IS NOT OLD.title AND NEW.title IS NOT NULL
        AND NOT (length(CAST(NEW.title AS BLOB)) = length(CAST(OLD.title AS BLOB)) AND trim(NEW.title, '#') = ''))
    OR (NEW.body IS NOT OLD.body AND NEW.body IS NOT NULL
        AND NOT (length(CAST(NEW.body AS BLOB)) = length(CAST(OLD.body AS BLOB)) AND trim(NEW.body, '#') = ''))
    OR (NEW.attrs IS NOT OLD.attrs AND NEW.attrs IS NOT NULL
        AND NOT (length(CAST(NEW.attrs AS BLOB)) = length(CAST(OLD.attrs AS BLOB)) AND trim(NEW.attrs, '#') = ''))
    OR NEW.memory_id IS NOT OLD.memory_id OR NEW.version IS NOT OLD.version OR NEW.action IS NOT OLD.action
    OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.type IS NOT OLD.type
    OR NEW.home_kind IS NOT OLD.home_kind OR NEW.home_ref IS NOT OLD.home_ref OR NEW.tags_json IS NOT OLD.tags_json
    OR NEW.priority IS NOT OLD.priority OR NEW.pinned IS NOT OLD.pinned OR NEW.status IS NOT OLD.status
    OR NEW.actor_kind IS NOT OLD.actor_kind OR NEW.actor_id IS NOT OLD.actor_id
    OR NEW.reason IS NOT OLD.reason OR NEW.at IS NOT OLD.at
BEGIN
    SELECT RAISE(ABORT, 'team_memory_versions is INSERT-ONLY except purge');
END;

-- team_memory_settings: human-set memory switches (v8). expert_approval
-- ('required' | 'off'), orchestrators (JSON list of member ids with full memory
-- access and control), inject_layer_tokens (auto-load target per layer, <= 2000).
-- A missing row means the default.
CREATE TABLE IF NOT EXISTS team_memory_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

`;
