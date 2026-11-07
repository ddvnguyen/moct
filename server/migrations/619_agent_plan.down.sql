-- Reverse 586: drop the plan table and its review history (587 drops first in
-- reverse order; IF EXISTS keeps the down idempotent if 587 was already gone).
DROP TABLE IF EXISTS agent_plan;
