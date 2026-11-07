-- Reverse 588: parked tasks cannot survive the old vocabulary. Map them to
-- 'cancelled' first — the closest prior state (deliberate non-failure; the
-- row keeps its session_id, so a resume via rerun_of_task_id still works) —
-- then restore the pre-588 CHECK. Same shape as 109's down migration.
UPDATE agent_task_queue
SET status = 'cancelled', completed_at = now(), wait_reason = NULL,
    prepare_lease_expires_at = NULL
WHERE status = 'blocked';

ALTER TABLE agent_task_queue DROP CONSTRAINT agent_task_queue_status_check;
ALTER TABLE agent_task_queue ADD CONSTRAINT agent_task_queue_status_check
    CHECK (status IN (
        'queued',
        'dispatched',
        'running',
        'completed',
        'failed',
        'cancelled',
        'waiting_local_directory',
        'deferred'
    ));
