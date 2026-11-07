-- Reverse 637: drop the plan comment threads and the section version ledger.
-- Neither table has dependents (no foreign keys, 538 house style); the flat
-- agent_plan_review.comments history is untouched by this migration.
DROP TABLE IF EXISTS agent_plan_section_version;
DROP TABLE IF EXISTS agent_plan_comment;
