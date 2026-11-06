ALTER TABLE task_supplement
    DROP CONSTRAINT IF EXISTS task_supplement_mode_check;

ALTER TABLE task_supplement
    DROP COLUMN IF EXISTS mode;
