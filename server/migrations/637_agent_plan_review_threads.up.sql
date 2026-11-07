-- M-275: the plan view's review threads.
--
-- S1-A1 (619/620) modelled a plan review as one flat list of strings on
-- agent_plan_review.comments. The Claude Code style plan page needs what the
-- team-room Doc page has: a comment anchored to a passage of one section, a
-- reply under it, a resolve, and a section history the Human can read and
-- restore.
--
-- Additive only: agent_plan, agent_plan_review and every existing endpoint keep
-- their contract, and the flat comment list stays the record the Answered view
-- reads. No foreign keys (538 house style) — teardown is application-owned.
CREATE TABLE agent_plan_comment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    plan_id UUID NOT NULL,
    -- The section the passage sits in, '' for a note with no anchor.
    section_id TEXT NOT NULL DEFAULT '',
    -- The selected passage, whitespace collapsed and capped at 280 characters
    -- by the edge (team-room docQuote). '' when nothing was selected.
    quote TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    -- A reply names its thread's comment; NULL is a thread root.
    parent_comment_id UUID,
    author_user_id UUID NOT NULL,
    resolved_at TIMESTAMPTZ,
    resolved_by UUID,
    -- Delivery to the agent: stamped once by the verdict that sends it, so a
    -- comment reaches the resumed run exactly once and no verdict re-sends it.
    delivered_at TIMESTAMPTZ,
    delivered_verdict TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The plan read loads a plan's whole thread set in creation order.
CREATE INDEX idx_apc_plan ON agent_plan_comment (plan_id, created_at);
-- The verdict settles the undelivered ones; the partial index keeps that scan
-- to the rows actually waiting.
CREATE INDEX idx_apc_pending ON agent_plan_comment (plan_id)
    WHERE delivered_at IS NULL;

-- One row per accepted write to a section, by the agent or by a Human. MMX
-- rewrites the sections JSONB wholesale, so this ledger is the only history it
-- has; a version is keyed by the plan revision the write produced, which makes
-- a replay of the same write a no-op instead of a duplicate.
CREATE TABLE agent_plan_section_version (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    plan_id UUID NOT NULL,
    section_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    markdown TEXT NOT NULL DEFAULT '',
    writer_type TEXT NOT NULL CHECK (writer_type IN ('agent', 'member')),
    writer_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (plan_id, section_id, revision)
);

CREATE INDEX idx_apsv_section ON agent_plan_section_version (plan_id, section_id, revision DESC);
