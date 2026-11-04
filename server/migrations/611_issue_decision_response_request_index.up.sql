CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS issue_decision_response_request_idx
    ON issue_decision_response (workspace_id, client_request_id);
