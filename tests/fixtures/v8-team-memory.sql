CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS team_memory_tags (
    record_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('team', 'channel', 'task', 'expert', 'repo', 'branch')),
    ref TEXT NOT NULL,
    PRIMARY KEY (record_id, kind, ref)
);

CREATE INDEX IF NOT EXISTS idx_team_memory_tags_ref ON team_memory_tags(kind, ref);

CREATE TABLE IF NOT EXISTS team_memory_links (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('on_branch', 'decided_in', 'blocks', 'relates')),
    PRIMARY KEY (from_id, to_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_team_memory_links_to ON team_memory_links(to_id);

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
