CREATE TABLE issue_decision_response (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    client_request_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    source_revision bigint NOT NULL,
    decision text NOT NULL,
    rationale text NOT NULL,
    next_status text NOT NULL,
    comment_id uuid NOT NULL,
    task_id uuid,
    requested_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
