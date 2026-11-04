CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_native_question_answer_request
    ON native_question_answer (task_id, workspace_id, author_id, client_request_id);
