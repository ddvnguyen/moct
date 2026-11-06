-- S1-A1 (M-118): plan verdict history.
--
-- Every verdict on a plan (approve / changes_requested / cancel) appends one
-- row; nothing here is updated or deleted, so the review trail survives plan
-- status changes and a later "changes requested → revise → resubmit" cycle.
-- plan_revision is the revision the verdict was rendered against — the same
-- value the handler fences on, kept for audit so a verdict can never be
-- misread as applying to a later revision. comments are the human's delivered
-- comments (JSONB array of strings); note is the optional verdict note.
-- No FK to agent_plan (538 house style).
CREATE TABLE agent_plan_review (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL,
    plan_revision INTEGER NOT NULL,
    verdict TEXT NOT NULL
        CHECK (verdict IN ('approve', 'changes_requested', 'cancel')),
    comments JSONB NOT NULL DEFAULT '[]',
    note TEXT,
    reviewed_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_apr_plan ON agent_plan_review (plan_id, created_at DESC);
