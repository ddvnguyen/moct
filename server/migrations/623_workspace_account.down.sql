ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS account_id;

ALTER TABLE agent DROP CONSTRAINT IF EXISTS agent_account_mode_consistent;
ALTER TABLE agent DROP COLUMN IF EXISTS account_id;
ALTER TABLE agent DROP COLUMN IF EXISTS account_mode;

DROP INDEX IF EXISTS idx_workspace_account_workspace;
DROP TABLE IF EXISTS workspace_account;