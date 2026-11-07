-- S1-A1 (M-118): add the 'blocked' task status.
--
-- A task ends 'blocked' ("awaiting human") when the agent's ask/plan call
-- parks it: the ask handler moves running -> blocked, the daemon sees the
-- status on its cancel-poll, interrupts the local agent, and reports the
-- session back through POST /api/daemon/tasks/{id}/blocked (park report).
-- The row then holds the session the answer/verdict re-queue resumes via
-- rerun_of_task_id. 'blocked' is NOT terminal: GC must keep the parked
-- workdir (daemon gc.go isAgentTaskTerminal stays completed/failed/cancelled)
-- and no sweeper may reap the row — see the sweep in agent.sql, which
-- deliberately excludes 'blocked' from every in-flight / stale / orphan list
-- (parked by design, not stuck) and deliberately includes it in the
-- user-facing cancel paths so a human cancel frees the parked slot.
--
-- Same DROP/ADD shape as 109 and 128: the CHECK constraint cannot be extended
-- in place. The table is hot, but the constraint rebuild takes the same brief
-- ACCESS EXCLUSIVE lock those migrations already accepted on this table.
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
        'deferred',
        'blocked'
    ));
