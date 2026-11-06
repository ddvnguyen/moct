-- One durable binding per answer to a native question. The transcript row owns
-- the question; this row owns the fact that a human already answered that exact
-- sequence, so a retry returns the original receipt instead of steering a second
-- answer into a turn that may have moved on. No foreign keys, like the other
-- supplement-side tables: teardown stays application-owned.
CREATE TABLE native_question_answer (
    task_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    question_seq INTEGER NOT NULL,
    comment_id UUID NOT NULL,
    author_id UUID NOT NULL,
    client_request_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
