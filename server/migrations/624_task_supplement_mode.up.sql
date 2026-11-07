ALTER TABLE task_supplement
    ADD COLUMN mode TEXT NOT NULL DEFAULT 'steer';

ALTER TABLE task_supplement
    ADD CONSTRAINT task_supplement_mode_check CHECK (mode IN ('steer', 'queue'));
