CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS workspace_account_daemon_account_id_uq
    ON workspace_account (runtime_id, daemon_account_id)
    WHERE runtime_id IS NOT NULL AND daemon_account_id IS NOT NULL;
