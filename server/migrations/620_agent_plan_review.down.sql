-- Reverse 587: drop the plan verdict history. Runs before 586 in reverse
-- order; the table has no dependents (no foreign keys, 538 house style).
DROP TABLE IF EXISTS agent_plan_review;
