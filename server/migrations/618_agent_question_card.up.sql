-- S1-A1 (M-118): question cards for the agent ask tool.
--
-- One card is one ask: 1..6 questions, answered at most once. The card is
-- created by the agent's ask call (task-token authenticated) and carries the
-- parked task's id so the answer path can re-queue a run resuming that task's
-- session. Deliberately no foreign keys (house style, migration 538): task,
-- issue and workspace teardown stay application-owned and never acquire a new
-- cascade/lock tree. questions/answers are JSONB because the shape is owned by
-- the tool contract (M-119), not by SQL — the server validates lengths
-- (team-room limits: 6 questions, 2-4 options, prompt <=300, context <=1200,
-- label <=40, description <=200, answer text <=2000) but stores the arrays
-- verbatim so a tool-side shape change needs no migration.
CREATE TABLE agent_question_card (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    task_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'answered', 'withdrawn')),
    context TEXT,
    questions JSONB NOT NULL,
    answers JSONB,
    answered_by UUID,
    answered_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Issue view: newest cards first.
CREATE INDEX idx_aqc_issue ON agent_question_card (issue_id, created_at DESC);
-- The island reads "is there an open card on this issue" on every issue load;
-- a partial index keeps that off the full history.
CREATE INDEX idx_aqc_open ON agent_question_card (issue_id) WHERE status = 'open';
-- Answer/withdraw and cancel-while-parked reach cards by parked task.
CREATE INDEX idx_aqc_task ON agent_question_card (task_id) WHERE status = 'open';
