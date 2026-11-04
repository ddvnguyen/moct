-- name: StartAgentTaskWithSupplement :one
-- Starting the task and recording the exact daemon/server capability handshake
-- are one state transition. A missing row is the fail-closed value for old
-- daemons, old servers, unsupported providers and application rollback.
WITH candidate AS MATERIALIZED (
    SELECT t.id, t.issue_id, r.workspace_id, r.provider
    FROM agent_task_queue t
    JOIN agent_runtime r ON r.id = t.runtime_id
    WHERE t.id = @task_id
      AND t.status IN ('dispatched', 'waiting_local_directory')
    FOR UPDATE OF t
), capability AS (
    INSERT INTO task_supplement_capability (task_id, workspace_id, issue_id, capability)
    SELECT id, workspace_id, issue_id, 'task-supplement-v1'
    FROM candidate
    WHERE @enable_task_supplement::boolean
      AND provider IN ('codex', 'claude', 'grok', 'cursor', 'kiro', 'dsh')
      AND issue_id IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING task_id
)
UPDATE agent_task_queue t
SET status = 'running',
    started_at = now(),
    wait_reason = NULL,
    prepare_lease_expires_at = NULL,
    result = CASE WHEN @enable_process_cleanup::boolean AND candidate.provider IN ('pi', 'omp')
                  THEN COALESCE(t.result, '{}'::jsonb) || '{"process_cleanup_capability":"pi-process-cleanup-v1"}'::jsonb
                  ELSE t.result END
FROM candidate
WHERE t.id = candidate.id
  -- Reference the data-modifying CTE explicitly: capability persistence and
  -- the returned running row are one indivisible statement.
  AND (SELECT count(*) FROM capability) >= 0
RETURNING t.*;

-- name: CreateTaskSupplement :one
-- Locking the exact task serializes against terminal transitions.
-- Comment creation, explicit task binding and run coverage then
-- commit as one statement: a terminal-race loser creates nothing.
WITH locked_task AS MATERIALIZED (
    SELECT t.id, t.issue_id, t.agent_id, t.trigger_comment_id
    FROM agent_task_queue t
    JOIN agent_runtime r ON r.id = t.runtime_id
    JOIN task_supplement_capability cap ON cap.task_id = t.id
    WHERE t.id = @task_id
      AND t.issue_id = @issue_id
      AND r.workspace_id = @workspace_id
      AND t.status = 'running'
      AND cap.capability = 'task-supplement-v1'
      AND r.provider IN ('codex', 'claude', 'grok', 'cursor', 'kiro', 'dsh')
    FOR UPDATE OF t
), touched_issue AS (
    UPDATE issue i SET
        updated_at = now(),
        revision = revision + 1,
        last_activity_at = GREATEST(COALESCE(last_activity_at, updated_at), now())
    FROM locked_task t
    WHERE i.id = t.issue_id AND i.workspace_id = @workspace_id
    RETURNING i.id, i.workspace_id, i.revision
), inserted_comment AS (
    INSERT INTO comment (
        issue_id, workspace_id, author_type, author_id, content, type, parent_id
    )
    SELECT i.id, i.workspace_id, 'member', @author_id, @content, 'comment', t.trigger_comment_id
    FROM touched_issue i
    JOIN locked_task t ON t.issue_id = i.id
    RETURNING *
), inserted_supplement AS (
    INSERT INTO task_supplement (
        task_id, workspace_id, issue_id, comment_id, author_id,
        client_request_id, status, mode
    )
    SELECT t.id, i.workspace_id, i.id, c.id, @author_id,
           @client_request_id,
           'pending',
           @mode
    FROM locked_task t
    JOIN touched_issue i ON i.id = t.issue_id
    JOIN inserted_comment c ON c.issue_id = i.id
    RETURNING *
)
SELECT c.*, i.revision AS issue_revision,
       s.task_id AS supplement_task_id, s.status AS supplement_status,
       s.failure_reason AS supplement_failure_reason,
       s.delivered_at AS supplement_delivered_at
FROM inserted_comment c
JOIN touched_issue i ON i.id = c.issue_id
JOIN inserted_supplement s ON s.comment_id = c.id;

-- name: CreateNativeQuestionAnswer :one
-- One statement answers a native question: the comment, its steer binding, the
-- answer binding and the issue revision land together or not at all. The
-- guards restate the shipped UI predicate (isAgentQuestionPending): the answer
-- names the newest transcript row, that row still carries a question, and no
-- delivered steer has reached the turn since the ask. The pending-ask gate sits
-- on touched_issue so an ask the run already left writes nothing at all. The
-- unique (task_id, question_seq) index is the last word: a second window's
-- answer aborts this whole statement.
WITH locked_task AS MATERIALIZED (
    SELECT t.id, t.issue_id, t.agent_id, t.trigger_comment_id
    FROM agent_task_queue t
    JOIN agent_runtime r ON r.id = t.runtime_id
    JOIN task_supplement_capability cap ON cap.task_id = t.id
    WHERE t.id = @task_id
      AND t.issue_id = @issue_id
      AND r.workspace_id = @workspace_id
      AND t.status = 'running'
      AND cap.capability = 'task-supplement-v1'
      AND r.provider IN ('codex', 'claude', 'grok', 'cursor', 'kiro', 'dsh')
    FOR UPDATE OF t
), pending_ask AS MATERIALIZED (
    SELECT m.seq
    FROM task_message m
    WHERE m.task_id = @task_id
      AND m.seq = @question_seq
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(m.input->'questions') = 'array' THEN m.input->'questions' ELSE '[]'::jsonb END
          ) q WHERE jsonb_typeof(q->'question') = 'string'
            AND length(btrim(q->>'question', U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) > 0)
      AND NOT EXISTS (SELECT 1 FROM task_message later WHERE later.task_id = m.task_id AND later.seq > m.seq)
      AND NOT EXISTS (SELECT 1 FROM task_supplement s WHERE s.task_id = m.task_id
          AND s.workspace_id = @workspace_id AND s.status = 'delivered'
          AND date_trunc('milliseconds', s.delivered_at) >= date_trunc('milliseconds', m.created_at))
), touched_issue AS (
    UPDATE issue i SET
        updated_at = now(),
        revision = revision + 1,
        last_activity_at = GREATEST(COALESCE(last_activity_at, updated_at), now())
    FROM locked_task t, pending_ask a
    WHERE i.id = t.issue_id AND i.workspace_id = @workspace_id
    RETURNING i.id, i.workspace_id, i.revision
), inserted_comment AS (
    INSERT INTO comment (
        issue_id, workspace_id, author_type, author_id, content, type, parent_id
    )
    SELECT i.id, i.workspace_id, 'member', @author_id, @content, 'comment', t.trigger_comment_id
    FROM touched_issue i
    JOIN locked_task t ON t.issue_id = i.id
    RETURNING *
), inserted_supplement AS (
    INSERT INTO task_supplement (
        task_id, workspace_id, issue_id, comment_id, author_id,
        client_request_id, status, mode
    )
    SELECT t.id, i.workspace_id, i.id, c.id, @author_id,
           @client_request_id, 'pending', 'steer'
    FROM locked_task t
    JOIN touched_issue i ON i.id = t.issue_id
    JOIN inserted_comment c ON c.issue_id = i.id
    RETURNING *
), inserted_binding AS (
    INSERT INTO native_question_answer (
        task_id, workspace_id, issue_id, question_seq, comment_id, author_id, client_request_id
    )
    SELECT t.id, i.workspace_id, i.id, a.seq, c.id, @author_id, @client_request_id
    FROM locked_task t
    JOIN pending_ask a ON true
    JOIN touched_issue i ON i.id = t.issue_id
    JOIN inserted_comment c ON c.issue_id = i.id
    RETURNING *
)
SELECT c.*, i.revision AS issue_revision, b.question_seq,
       s.status AS supplement_status, s.failure_reason AS supplement_failure_reason,
       s.delivered_at AS supplement_delivered_at
FROM inserted_binding b
JOIN inserted_comment c ON c.id = b.comment_id
JOIN touched_issue i ON i.id = b.issue_id
JOIN inserted_supplement s ON s.comment_id = b.comment_id;

-- name: GetNativeQuestionAnswerByRequest :one
SELECT * FROM native_question_answer
WHERE task_id = @task_id
  AND workspace_id = @workspace_id
  AND author_id = @author_id
  AND client_request_id = @client_request_id;

-- name: GetNativeQuestionAnswerBySeq :one
SELECT * FROM native_question_answer
WHERE task_id = @task_id AND question_seq = @question_seq;

-- name: GetTaskSupplementByRequest :one
SELECT s.*
FROM task_supplement s
WHERE s.task_id = @task_id
  AND s.workspace_id = @workspace_id
  AND s.author_id = @author_id
  AND s.client_request_id = @client_request_id;

-- name: LockTaskForSupplementBind :one
-- Taken in its own statement before BindCommentTaskSupplement, in the same
-- transaction. BindCommentTaskSupplement counts an agent author's earlier
-- bindings; a count inside the locking statement would keep that statement's
-- snapshot across the lock wait, so two binders racing for the last slot
-- would both see the old count. Counting in the next statement sees what the
-- previous lock holder committed.
SELECT id FROM agent_task_queue WHERE id = @task_id FOR UPDATE;

-- name: BindCommentTaskSupplement :one
-- Binds an ordinary comment, already created through the normal comment path,
-- to the exact running turn its author chose. Locking the task serializes
-- against terminal transitions: when that turn ended first nothing is bound —
-- never a later turn of the same agent — and the caller keeps the comment's
-- normal trigger instead. Agent-authored bindings are capped per turn and per
-- authoring agent so two agents cannot keep steering each other; a member's
-- binding is not capped.
WITH locked_task AS MATERIALIZED (
    SELECT t.id, t.issue_id, t.runtime_id
    FROM agent_task_queue t
    JOIN agent_runtime r ON r.id = t.runtime_id
    JOIN task_supplement_capability cap ON cap.task_id = t.id
    WHERE t.id = @task_id
      AND t.issue_id = @issue_id
      AND t.agent_id = @agent_id
      AND r.workspace_id = @workspace_id
      AND t.status = 'running'
      AND cap.capability = 'task-supplement-v1'
      AND r.provider IN ('codex', 'claude', 'grok', 'cursor', 'kiro', 'dsh')
      AND (@author_type::text <> 'agent' OR (
          (SELECT count(*) FROM task_supplement s
           JOIN comment c ON c.id = s.comment_id
           WHERE s.task_id = t.id AND c.author_type = 'agent') < @max_agent_bindings::int
          AND (SELECT count(*) FROM task_supplement s
               JOIN comment c ON c.id = s.comment_id
               WHERE s.task_id = t.id AND c.author_type = 'agent'
                 AND s.author_id = @author_id) < @max_bindings_per_agent::int
      ))
    FOR UPDATE OF t
), inserted AS (
    INSERT INTO task_supplement (
        task_id, workspace_id, issue_id, comment_id, author_id,
        client_request_id, status
    )
    SELECT t.id, @workspace_id, t.issue_id, @comment_id, @author_id,
           @client_request_id, 'pending'
    FROM locked_task t
    RETURNING *
)
SELECT inserted.*, locked_task.runtime_id
FROM inserted
JOIN locked_task ON locked_task.id = inserted.task_id;

-- name: GetRunningTaskForAgentOnIssue :one
-- The turn a comment sent with steer=true is added to for one recipient. The
-- bind re-checks that it is still running and can take additional input.
SELECT id FROM agent_task_queue
WHERE issue_id = @issue_id AND agent_id = @agent_id AND status = 'running'
ORDER BY started_at DESC NULLS LAST, id DESC
LIMIT 1;

-- name: ListUndeliveredTaskSupplementCommentIDs :many
-- Comments bound to this run that it never read. Completion replays the
-- agent-authored ones as the mention they replaced.
SELECT comment_id FROM task_supplement
WHERE task_id = @task_id AND status <> 'delivered';

-- name: DeleteUndeliveredTaskSupplementForRun :execrows
-- Drops the receipt of an agent comment that completion replayed: the comment
-- is now handled by the follow-up run like any other mention, so no client
-- should offer to resend it.
DELETE FROM task_supplement
WHERE comment_id = @comment_id AND task_id = @task_id AND status <> 'delivered';

-- name: GetTaskSupplementForRun :one
SELECT * FROM task_supplement
WHERE comment_id = @comment_id AND task_id = @task_id AND workspace_id = @workspace_id;

-- name: CommentHasTaskSupplement :one
SELECT EXISTS (
    SELECT 1 FROM task_supplement
    WHERE comment_id = @comment_id AND workspace_id = @workspace_id
) AS bound;

-- name: GetTaskSupplementCapability :one
SELECT * FROM task_supplement_capability WHERE task_id = @task_id;

-- name: ListTaskSupplementsByCommentIDs :many
-- One comment may steer several runs; receipts carry the run's agent so a
-- client can say whose turn received it.
SELECT s.*, t.agent_id
FROM task_supplement s
LEFT JOIN agent_task_queue t ON t.id = s.task_id
WHERE s.workspace_id = @workspace_id
  AND s.comment_id = ANY(@comment_ids::uuid[])
ORDER BY s.created_at, s.task_id;

-- name: ListTaskSupplementMetadata :many
SELECT cap.task_id, cap.capability,
       COALESCE(array_agg(s.comment_id ORDER BY s.created_at, s.comment_id)
                FILTER (WHERE s.comment_id IS NOT NULL), '{}'::uuid[])::uuid[] AS comment_ids
FROM task_supplement_capability cap
LEFT JOIN task_supplement s ON s.task_id = cap.task_id
WHERE cap.workspace_id = @workspace_id
  AND cap.task_id = ANY(@task_ids::uuid[])
GROUP BY cap.task_id, cap.capability;

-- name: SettleTerminalTaskSupplements :execrows
-- Application terminal transitions call this in the same transaction as the
-- agent_task_queue update. Re-checking the persisted task status makes an
-- accidental early call a no-op while preserving the task-row -> supplement
-- lock order used by creation and delivery acknowledgement.
--
-- S1-A1: 'blocked' joins the re-check set — the daemon interrupted the parked
-- run, so its pending supplements can never be delivered (CreateTaskSupplement
-- requires running). Settling them here, in the block transaction, keeps the
-- same "commit atomically with the status change or not at all" invariant the
-- terminal paths hold; the later cancel settles them as a no-op.
UPDATE task_supplement AS supplement
SET status = 'failed',
    failure_reason = 'turn_ended',
    updated_at = now()
FROM agent_task_queue AS task
WHERE supplement.task_id = task.id
  AND task.id = ANY(@task_ids::uuid[])
  AND task.status IN ('completed', 'failed', 'cancelled', 'blocked')
  AND supplement.status IN ('pending', 'delivering');

-- name: ClaimNextTaskSupplement :one
WITH next AS MATERIALIZED (
    SELECT s.comment_id, s.task_id
    FROM task_supplement s
    JOIN agent_task_queue t ON t.id = s.task_id
    JOIN task_supplement_capability cap ON cap.task_id = t.id
    WHERE s.task_id = @task_id
      AND s.status = 'pending'
      AND t.status = 'running'
      AND cap.capability = 'task-supplement-v1'
      -- A daemon that cannot present an agent's message as an agent's never
      -- receives one: it stays pending until the turn ends, and completion
      -- replays it as an ordinary mention.
      AND (@include_agent_authored::bool OR NOT EXISTS (
          SELECT 1 FROM comment ac WHERE ac.id = s.comment_id AND ac.author_type = 'agent'
      ))
    ORDER BY s.created_at, s.comment_id
    FOR UPDATE OF s SKIP LOCKED
    LIMIT 1
), claimed AS (
    UPDATE task_supplement s
    SET status = 'delivering',
        attempt_count = attempt_count + 1,
        failure_reason = NULL,
        updated_at = now()
    FROM next
    WHERE s.comment_id = next.comment_id
      AND s.task_id = next.task_id
    RETURNING s.*
)
SELECT claimed.comment_id, claimed.attempt_count, claimed.mode, c.content, c.author_type,
       COALESCE(NULLIF(btrim(COALESCE(u.name, a.name)), ''),
                CASE WHEN c.author_type = 'agent' THEN 'an agent' ELSE 'a user' END)::text AS author_name
FROM claimed
JOIN comment c ON c.id = claimed.comment_id
LEFT JOIN "user" u ON u.id = claimed.author_id AND c.author_type = 'member'
LEFT JOIN agent a ON a.id = claimed.author_id AND c.author_type = 'agent';

-- name: AckTaskSupplementDelivered :one
-- The provider can accept input before completion while its HTTP acknowledgement
-- arrives afterward. Serialize with settlement and preserve that successful write.
WITH task AS MATERIALIZED (
    SELECT id FROM agent_task_queue WHERE id = @task_id FOR UPDATE
)
UPDATE task_supplement s
SET status = 'delivered',
    delivered_at = COALESCE(delivered_at, now()),
    failure_reason = NULL,
    updated_at = now()
FROM task t
WHERE s.task_id = t.id
  AND s.comment_id = @comment_id
  AND (s.status IN ('delivering', 'delivered')
       OR (s.status = 'failed' AND s.failure_reason = 'turn_ended' AND s.attempt_count > 0))
RETURNING s.*;

-- name: AckTaskSupplementFailed :one
UPDATE task_supplement
SET status = 'failed',
    failure_reason = @failure_reason,
    updated_at = now()
WHERE task_id = @task_id
  AND comment_id = @comment_id
  AND status = 'delivering'
RETURNING *;

-- name: RetryTaskSupplement :one
WITH comment AS MATERIALIZED (
    SELECT id FROM comment
    WHERE id = @comment_id AND workspace_id = @workspace_id AND deleted_at IS NULL
    FOR UPDATE
), active_task AS MATERIALIZED (
    SELECT agent_task_queue.id FROM agent_task_queue
    WHERE agent_task_queue.id = @task_id
      AND agent_task_queue.issue_id = @issue_id
      AND agent_task_queue.status = 'running'
      AND EXISTS (SELECT 1 FROM comment)
      AND EXISTS (
          SELECT 1 FROM task_supplement_capability cap
          WHERE cap.task_id = agent_task_queue.id
            AND cap.capability = 'task-supplement-v1'
      )
    FOR UPDATE OF agent_task_queue
)
UPDATE task_supplement s
SET status = 'pending',
    failure_reason = NULL,
    updated_at = now()
FROM active_task t
WHERE s.task_id = t.id
  AND s.comment_id = @comment_id
  AND s.workspace_id = @workspace_id
  AND s.status = 'failed'
RETURNING s.*;

-- name: LockTaskSupplementsByComment :many
SELECT * FROM task_supplement
WHERE comment_id = @comment_id AND workspace_id = @workspace_id
FOR UPDATE;

-- name: DeleteTaskSupplementByComment :exec
DELETE FROM task_supplement
WHERE comment_id = @comment_id AND workspace_id = @workspace_id;
