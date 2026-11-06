-- Reverse 585: drop the question-card table. Rows are ask/plan artifacts of
-- live tasks; dropping the table with any still-open cards simply withdraws
-- them from the UI (the daemon-side parked-run interrupt is unaffected).
DROP TABLE IF EXISTS agent_question_card;
