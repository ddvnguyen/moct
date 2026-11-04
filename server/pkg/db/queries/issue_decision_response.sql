-- name: GetIssueDecisionResponseByRequest :one
SELECT * FROM issue_decision_response
WHERE workspace_id = $1 AND client_request_id = $2;

-- name: CreateIssueDecisionResponse :one
INSERT INTO issue_decision_response (
    id, workspace_id, issue_id, client_request_id, actor_id, source_revision,
    decision, rationale, next_status, comment_id, task_id, requested_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;
