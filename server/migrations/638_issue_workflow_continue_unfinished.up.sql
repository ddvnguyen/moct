-- Per-workflow switch to continue an unfinished workflow step after a completed
-- run (M-279). Defaults on so existing workflows keep the new behavior.
ALTER TABLE issue_workflow
    ADD COLUMN IF NOT EXISTS continue_unfinished BOOLEAN NOT NULL DEFAULT TRUE;
