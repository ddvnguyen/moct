CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_decision_delivered_supplement
    ON task_supplement (workspace_id, task_id, delivered_at)
    WHERE status = 'delivered';
