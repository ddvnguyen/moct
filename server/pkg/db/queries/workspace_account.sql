-- name: CreateWorkspaceAccount :one
INSERT INTO workspace_account (
    workspace_id, provider, label, endpoint, credential_ref, enabled, created_by
) VALUES (
    $1, $2, $3, $4, $5, $6, $7
) RETURNING *;

-- name: GetWorkspaceAccount :one
SELECT * FROM workspace_account
WHERE id = $1;

-- name: GetWorkspaceAccountInWorkspace :one
SELECT * FROM workspace_account
WHERE id = $1 AND workspace_id = $2;

-- name: ListWorkspaceAccounts :many
SELECT * FROM workspace_account
WHERE workspace_id = $1
ORDER BY created_at ASC;

-- name: ListWorkspaceAccountsByProvider :many
SELECT * FROM workspace_account
WHERE workspace_id = $1 AND provider = $2 AND enabled = TRUE
  AND (daemon_account_id IS NULL OR state = 'connected')
ORDER BY created_at ASC;

-- name: UpdateWorkspaceAccount :one
UPDATE workspace_account
SET label = $2,
    endpoint = $3,
    credential_ref = $4,
    enabled = $5,
    engine_version = COALESCE(sqlc.narg(engine_version), engine_version),
    updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteWorkspaceAccount :exec
DELETE FROM workspace_account WHERE id = $1;

-- name: RetryManagedWorkspaceAccount :one
UPDATE workspace_account
SET state='requested', login_url=NULL, expires_at=NULL, error=NULL, status=NULL, updated_at=now()
WHERE id=$1 AND runtime_id=$2 AND daemon_account_id IS NOT NULL
  AND state IN ('failed','signed_out')
RETURNING *;

-- name: DemoteAgentsOnAccountDelete :exec
UPDATE agent
SET account_mode = 'default', account_id = NULL, updated_at = now()
WHERE account_id = $1;
-- name: ListAccountsForDispatch :many
-- The enabled accounts of one provider, least busy first. "Busy" is the number
-- of dispatched/running tasks holding the account; ties break on the account
-- that has been idle longest, so `any` spreads runs instead of piling on one.
SELECT a.id, a.label, a.endpoint, a.credential_ref, a.daemon_account_id, a.runtime_id,
       COALESCE(l.active, 0)::int AS active_tasks
FROM workspace_account a
LEFT JOIN (
    SELECT account_id,
           COUNT(*) FILTER (WHERE status IN ('dispatched', 'running')) AS active,
           MAX(COALESCE(started_at, dispatched_at)) AS last_used
    FROM agent_task_queue
    WHERE account_id IS NOT NULL
    GROUP BY account_id
) l ON l.account_id = a.id
WHERE a.workspace_id = $1 AND a.provider = $2 AND a.enabled = TRUE
  AND (a.daemon_account_id IS NULL OR a.state = 'connected')
  AND (a.runtime_id IS NULL OR a.runtime_id = $3)
ORDER BY COALESCE(l.active, 0) ASC, l.last_used ASC NULLS FIRST, a.created_at ASC;

-- name: AgentAccountBlocked :one
-- Whether the agent must wait for an account to free up before a task is
-- claimed. `specific` is blocked while its account holds a dispatched/running
-- task; `any` only when every enabled account does. An agent with no usable
-- account (`default`, or `any` with none configured) is never blocked.
SELECT CASE
    WHEN ag.account_mode = 'specific' THEN EXISTS (
        SELECT 1 FROM agent_task_queue t
        WHERE t.account_id = ag.account_id AND t.status IN ('dispatched', 'running'))
    WHEN ag.account_mode = 'any' THEN
        EXISTS (SELECT 1 FROM workspace_account a
                WHERE a.workspace_id = ag.workspace_id AND a.provider = 'freebuff-desktop' AND a.enabled
                  AND (a.daemon_account_id IS NULL OR a.state = 'connected')
                  AND (a.runtime_id IS NULL OR a.runtime_id = sqlc.arg(runtime_id)))
        AND NOT EXISTS (SELECT 1 FROM workspace_account a
                WHERE a.workspace_id = ag.workspace_id AND a.provider = 'freebuff-desktop' AND a.enabled
                  AND (a.daemon_account_id IS NULL OR a.state = 'connected')
                  AND (a.runtime_id IS NULL OR a.runtime_id = sqlc.arg(runtime_id))
                  AND NOT EXISTS (SELECT 1 FROM agent_task_queue t
                                  WHERE t.account_id = a.id AND t.status IN ('dispatched', 'running')))
    ELSE FALSE
END::boolean AS blocked
FROM agent ag
WHERE ag.id = $1;
