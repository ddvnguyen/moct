-- One answer per question sequence: two windows answering the same ask race
-- here, and the loser's whole statement (comment, supplement, revision) rolls
-- back.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_native_question_answer_task_seq
    ON native_question_answer (task_id, question_seq);
