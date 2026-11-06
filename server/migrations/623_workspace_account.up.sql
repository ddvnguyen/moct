-- M-153: per-workspace accounts (freebuff-desktop) + agent account selection.
-- Account credentials never live in the DB; a row holds a reference the daemon
-- resolves on its own machine (credential_ref).

CREATE TABLE workspace_account (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    endpoint TEXT,
    credential_ref TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES "user"(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, provider, label)
);

CREATE INDEX idx_workspace_account_workspace ON workspace_account(workspace_id);

ALTER TABLE agent
    ADD COLUMN account_mode TEXT NOT NULL DEFAULT 'default'
        CHECK (account_mode IN ('default', 'specific', 'any')),
    ADD COLUMN account_id UUID REFERENCES workspace_account(id) ON DELETE SET NULL;

ALTER TABLE agent
    ADD CONSTRAINT agent_account_mode_consistent
        CHECK ((account_mode = 'specific') = (account_id IS NOT NULL));

ALTER TABLE agent_task_queue
    ADD COLUMN account_id UUID REFERENCES workspace_account(id) ON DELETE SET NULL;