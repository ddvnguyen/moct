-- S1-A1 (M-118) ask/plan queries: question cards (585) and revisioned plans
-- (586/587). All state transitions are compare-and-set on the row's current
-- status (and, for plans, on the revision fence), so a stale tool call or a
-- double verdict is a business 409, never a lost update. No foreign keys
-- (538 house style); teardown is application-owned via the task-cancel settle
-- below.

-- name: CreateAgentQuestionCard :one
INSERT INTO agent_question_card (
    id, workspace_id, issue_id, task_id, agent_id,
    status, context, questions
) VALUES (
    @id, @workspace_id, @issue_id, @task_id, @agent_id,
    'open', sqlc.narg('context'), @questions
)
RETURNING *;

-- name: GetAgentQuestionCard :one
SELECT * FROM agent_question_card WHERE id = $1;

-- name: ListOpenQuestionCardsByIssue :many
SELECT * FROM agent_question_card
WHERE issue_id = $1 AND status = 'open'
ORDER BY created_at DESC;

-- name: AnswerAgentQuestionCard :one
-- Single-answer enforcement (team-room assertDecisionOpen): the CAS on
-- status='open' means a second answer matches no row → pgx.ErrNoRows → the
-- handler maps it to 409. answers is stored verbatim in question order.
UPDATE agent_question_card
SET status = 'answered',
    answers = @answers,
    answered_by = @answered_by,
    answered_at = now(),
    updated_at = now()
WHERE id = $1 AND status = 'open'
RETURNING *;

-- name: WithdrawQuestionCardsByTask :exec
-- Cancel-while-parked settle (Architect amendment 3): withdrawing every open
-- card of a task batch just moved to a terminal status. No-op for tasks that
-- never parked (they own no open card).
UPDATE agent_question_card
SET status = 'withdrawn',
    withdrawn_at = now(),
    updated_at = now()
WHERE task_id = ANY(@task_ids::uuid[]) AND status = 'open';

-- name: CreateAgentPlan :one
INSERT INTO agent_plan (
    id, workspace_id, issue_id, task_id, agent_id, title, status, sections
) VALUES (
    @id, @workspace_id, @issue_id, @task_id, @agent_id, @title, 'draft', @sections
)
RETURNING *;

-- name: GetAgentPlan :one
SELECT * FROM agent_plan WHERE id = $1;

-- name: GetOpenAgentPlanByIssue :one
SELECT * FROM agent_plan
WHERE issue_id = $1 AND status IN ('draft', 'in_review', 'changes_requested')
LIMIT 1;

-- name: WriteAgentPlanSection :one
-- Section write with the revision fence: base_revision must equal the row's
-- current revision or the CAS matches no row (handler → 409 + current
-- revision, the port of team-room's stale_doc_revision business outcome).
-- The whole sections array is rewritten (single-writer tool contract); the
-- revision bumps on every accepted write, which is what fences the next
-- write, the submit and the verdict.
UPDATE agent_plan
SET sections = @sections,
    revision = revision + 1,
    updated_at = now()
WHERE id = $1 AND revision = @base_revision
  AND status IN ('draft', 'changes_requested')
RETURNING *;

-- name: SubmitAgentPlan :one
-- submit: draft or changes_requested -> in_review, fenced by revision.
-- Refusing a double submit at the same revision falls out of the CAS (a plan
-- already in_review matches neither status). Re-checking the planning gate is
-- the handler's job (it needs issue status + active tasks).
-- task_id is refreshed to the submitting task: after a changes_requested →
-- resume cycle the caller is a NEW task row, and both the block transition
-- and the cancel-while-parked settle must reach the plan through the task
-- that is parking NOW, not the original proposer.
UPDATE agent_plan
SET status = 'in_review',
    submitted_revision = @revision,
    task_id = @task_id,
    updated_at = now()
WHERE id = $1 AND revision = @revision
  AND status IN ('draft', 'changes_requested')
RETURNING *;

-- name: RecordAgentPlanReview :one
-- Verdict history append (587). Nothing here is ever updated.
INSERT INTO agent_plan_review (
    id, plan_id, plan_revision, verdict, comments, note, reviewed_by
) VALUES (
    @id, @plan_id, @plan_revision, @verdict, @comments, sqlc.narg('note'), @reviewed_by
)
RETURNING *;

-- name: ApproveAgentPlan :one
-- approve: in_review -> approved, fenced on the reviewed revision. Provenance
-- (approved_by/at) lives here because additive-only forbids an issue column.
UPDATE agent_plan
SET status = 'approved',
    approved_by = @reviewed_by,
    approved_at = now(),
    updated_at = now()
WHERE id = $1 AND status = 'in_review' AND submitted_revision = @revision
RETURNING *;

-- name: RequestAgentPlanChanges :one
-- changes_requested: in_review -> changes_requested. The revision does NOT
-- bump (team-room rule): the agent revises the same plan and resubmits at the
-- new revision its own write produced.
UPDATE agent_plan
SET status = 'changes_requested',
    updated_at = now()
WHERE id = $1 AND status = 'in_review' AND submitted_revision = @revision
RETURNING *;

-- name: CancelAgentPlan :one
-- cancel: any open state -> cancelled; final; frees the issue for a new plan
-- (idx_ap_one_open only covers the open statuses).
UPDATE agent_plan
SET status = 'cancelled',
    cancelled_at = now(),
    updated_at = now()
WHERE id = $1 AND status IN ('draft', 'in_review', 'changes_requested')
RETURNING *;

-- name: CancelPlansByTask :exec
-- Cancel-while-parked settle (amendment 3): same shape as
-- WithdrawQuestionCardsByTask. No-op for tasks with no open plan.
UPDATE agent_plan
SET status = 'cancelled',
    cancelled_at = now(),
    updated_at = now()
WHERE task_id = ANY(@task_ids::uuid[]) AND status IN ('draft', 'in_review', 'changes_requested');

-- name: CountActiveTasksForIssueExcluding :one
-- The plan-creation gate: "no other active task" (Architect-endorsed reading —
-- the caller is excluded because it is by definition running while it calls
-- plan create). 'blocked' is NOT active (parked holds no slot) and 'deferred'
-- is scheduled work, not executing work; both stay out of the tuple.
SELECT count(*) AS active
FROM agent_task_queue
WHERE issue_id = $1
  AND status IN ('queued', 'dispatched', 'running', 'waiting_local_directory')
  AND id <> sqlc.narg('excluded_task_id')::uuid;

-- name: ListParkedAskPlanSweepCandidates :many
-- M-131 timeout sweep candidate set. A parked ask/plan task is 'blocked' with
-- wait_reason 'awaiting human answer' (BlockTaskForAskPlan), but so is every
-- ANSWERED park — the parked row keeps the session after the resume enqueues —
-- so only rows whose evidence is still LIVE qualify: an open card or an
-- in_review plan. The park clock is the evidence row's own stamp: the card is
-- created immediately before the block, and SubmitAgentPlan sets the plan's
-- updated_at as its last write before the block. Both joins ride their partial
-- indexes (idx_aqc_task WHERE status='open', idx_ap_task WHERE status IN
-- ('draft','in_review','changes_requested')), so the scan touches live evidence
-- only. Settings come along because the effective timeout is per project; the
-- expiry judgment itself happens in Go, one row at a time.
SELECT
    t.id AS task_id,
    t.issue_id,
    i.workspace_id,
    i.project_id,
    w.settings AS workspace_settings,
    p.settings AS project_settings,
    COALESCE(c.created_at, pl.updated_at) AS parked_at
FROM agent_task_queue t
JOIN issue i ON i.id = t.issue_id
LEFT JOIN workspace w ON w.id = i.workspace_id
LEFT JOIN project p ON p.id = i.project_id
LEFT JOIN agent_question_card c ON c.task_id = t.id AND c.status = 'open'
LEFT JOIN agent_plan pl ON pl.task_id = t.id AND pl.status = 'in_review'
WHERE t.status = 'blocked'
  AND t.wait_reason = 'awaiting human answer'
  AND (c.id IS NOT NULL OR pl.id IS NOT NULL)
ORDER BY COALESCE(c.created_at, pl.updated_at) ASC
LIMIT $1;

-- name: GetAgentQuestionCardForUpdate :one
-- M-131 expiry gate (amendment 2): the sweep transaction locks the evidence
-- row ITSELF, keyed by the parked task's trigger_evidence_ref_id. A concurrent
-- AnswerQuestionCard then blocks on this lock, and once the sweep commits its
-- status='open' CAS matches no row -> ErrQuestionCardClosed -> 409. First
-- answer wins with no double outcome, in either interleaving.
SELECT * FROM agent_question_card WHERE id = $1 FOR UPDATE;

-- name: GetAgentPlanForUpdate :one
-- M-131 expiry gate: same guarantee for ReviewPlan — a verdict arriving after
-- the sweep's plan-row lock fails its own status/revision CAS against the plan
-- this transaction already cancelled.
SELECT * FROM agent_plan WHERE id = $1 FOR UPDATE;

-- M-275: the plan page's review threads and section history.
--
-- A comment is anchored to a passage of one section (section_id + quote) and
-- may be a reply (parent_comment_id); it stays pending until a verdict sends
-- it, which stamps delivered_at/delivered_verdict once. The flat
-- agent_plan_review.comments list keeps its contract: the plan page's
-- comments are appended to it as their bodies.

-- name: CreateAgentPlanComment :one
INSERT INTO agent_plan_comment (
    id, workspace_id, plan_id, section_id, quote, body,
    parent_comment_id, author_user_id
) VALUES (
    @id, @workspace_id, @plan_id, @section_id, @quote, @body,
    sqlc.narg('parent_comment_id'), @author_user_id
)
RETURNING *;

-- name: GetAgentPlanComment :one
-- A reply is validated against the plan it lands on before it is written.
SELECT * FROM agent_plan_comment WHERE id = $1;

-- name: ListAgentPlanComments :many
-- The plan page and the decision detail read a plan's whole thread set. Its
-- index is (plan_id, created_at), so this is the index order.
SELECT * FROM agent_plan_comment
WHERE plan_id = $1
ORDER BY created_at ASC;

-- name: ListUndeliveredAgentPlanComments :many
-- The verdict settles exactly the comments still waiting; idx_apc_pending
-- keeps this to the rows that are actually pending.
SELECT * FROM agent_plan_comment
WHERE plan_id = $1 AND delivered_at IS NULL
ORDER BY created_at ASC;

-- name: DeliverAgentPlanComments :exec
-- Stamped by the verdict that sends them, so a comment reaches the resumed
-- run exactly once and a replayed verdict re-sends nothing.
UPDATE agent_plan_comment
SET delivered_at = now(),
    delivered_verdict = @verdict
WHERE id = ANY(@ids::uuid[]) AND delivered_at IS NULL;

-- name: ResolveAgentPlanComment :one
-- Human-only, and a CAS on resolved_at IS NULL: resolving twice matches no row
-- (handler → 409), and the agent's text is never rewritten by a resolve.
UPDATE agent_plan_comment
SET resolved_at = now(),
    resolved_by = @resolved_by
WHERE id = $1 AND plan_id = $2 AND resolved_at IS NULL
RETURNING *;

-- name: CreateAgentPlanSectionVersion :exec
-- One row per accepted section write, by the agent or by a Human. ON CONFLICT
-- DO NOTHING makes a replay (the same plan revision writing the same section
-- twice) a no-op instead of a duplicate, and lets the lazy seed probe without
-- a read-then-write race.
INSERT INTO agent_plan_section_version (
    id, workspace_id, plan_id, section_id, revision, heading, markdown,
    writer_type, writer_id
) VALUES (
    @id, @workspace_id, @plan_id, @section_id, @revision, @heading, @markdown,
    @writer_type, sqlc.narg('writer_id')
)
ON CONFLICT (plan_id, section_id, revision) DO NOTHING;

-- name: ListAgentPlanSectionVersions :many
-- Newest first: the section history panel and the lazy seed's existence check.
SELECT * FROM agent_plan_section_version
WHERE plan_id = $1 AND section_id = $2
ORDER BY revision DESC;

-- name: UpdateAgentPlanSection :one
-- The Human's edit: rewrite the whole sections array and bump the revision,
-- fenced on base_revision AND on the statuses an edit is allowed in. When the
-- plan is in review the submitted_revision advances with the edit (M-275
-- decision 1), so the reviewer's own verdict rides their edit instead of
-- 409-ing against a revision their save produced.
UPDATE agent_plan
SET sections = @sections,
    submitted_revision = CASE WHEN status = 'in_review' THEN revision + 1 ELSE submitted_revision END,
    revision = revision + 1,
    updated_at = now()
WHERE id = $1 AND revision = @base_revision
  AND status IN ('draft', 'in_review', 'changes_requested')
RETURNING *;
