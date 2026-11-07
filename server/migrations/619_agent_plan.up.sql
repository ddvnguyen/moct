-- S1-A1 (M-118): revisioned plans for the agent plan tool.
--
-- One plan per issue while it is open (draft/in_review/changes_requested);
-- approval and cancellation are final and free the issue for a new plan
-- (team-room semantics @ fefa9c3: one plan per task unless cancelled).
-- revision increments on every section write and fences submit/verdict —
-- a stale fence is a 409 business outcome, never a server error.
-- submitted_revision records the revision currently under review so a verdict
-- on an older revision can be refused. sections is JSONB ([{sectionId,
-- heading, markdown}]) for the same tool-contract reason as 585.
-- approved_by/approved_at carry the provenance that additive-only forbids us
-- from putting on the issue row.
CREATE TABLE agent_plan (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    task_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'in_review', 'changes_requested', 'approved', 'cancelled')),
    revision INTEGER NOT NULL DEFAULT 1,
    submitted_revision INTEGER,
    sections JSONB NOT NULL DEFAULT '[]',
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The one-open-plan-per-issue rule, enforced by the database rather than a
-- read-then-write race: a second create/submit while a plan is open collides
-- here and the handler maps the violation to its business error. Approved and
-- cancelled plans are outside the predicate, so they never block a new plan.
CREATE UNIQUE INDEX idx_ap_one_open ON agent_plan (issue_id)
    WHERE status IN ('draft', 'in_review', 'changes_requested');

-- Issue view / island read.
CREATE INDEX idx_ap_issue ON agent_plan (issue_id, created_at DESC);
-- Cancel-while-parked reaches the open plan by parked task.
CREATE INDEX idx_ap_task ON agent_plan (task_id)
    WHERE status IN ('draft', 'in_review', 'changes_requested');
