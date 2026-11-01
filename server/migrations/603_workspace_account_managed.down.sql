ALTER TABLE workspace_account DROP CONSTRAINT IF EXISTS workspace_account_state_check;
ALTER TABLE workspace_account
    DROP COLUMN IF EXISTS runtime_id,
    DROP COLUMN IF EXISTS daemon_account_id,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS error,
    DROP COLUMN IF EXISTS expires_at,
    DROP COLUMN IF EXISTS login_url,
    DROP COLUMN IF EXISTS state;
