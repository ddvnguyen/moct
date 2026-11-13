# M-328 dry run — `--free-questions --hours 168` (last 7 days, 2026-11-06 → 11-13)

Command: `tools/orch-sweep/orch-sweep --free-questions --hours 168`

## Counts

- Board issues scanned (in_progress + planing_2 + todo + blocked): **28**
- Agent comments flagged, no ask card from the same run: **2**
- Full-corpus cross-check (100 recently-updated issues, 1340 agent comments, matcher only): **8 hits**,
  all on cards now `in_review` (M-285 ×6, M-258, M-259) — outside the sweep's board slice, so correctly absent.
- Random 100-comment negative sample: **0 missed Owner-questions** (1 ambiguous approval-request ending in
  a period, correctly silent — the heuristic only fires on trailing `?` or explicit decision phrases).

**False-positive rate: 0/9 unique flagged comments.** Every flagged comment is a genuine free-text question
to the Owner with no ask card from the same run (verified: no `question_answer`/`question_card` run ref
within ±15 min, no shared `source_task_id`, no `trigger_comment_id` match).

## The 2 sweep offenders (daily-ticket paste)

- M-255, comment 01a1b163-c371-725f-9522-cfbbbd375d03, Lead (Muse Spark), 2026-11-06 —
  "Next: need Owner decision — approve planning this fix as implementation issue(s), or close as diagnosis-only?"
- M-82, comment 01a1bb83-8837-7029-ac09-b9cb38d1327b, Codex | Terra | Engineer, 2026-11-08 —
  "Please approve Plan v1 … to start implementation."

## 3 more samples from the full-corpus cross-check (same heuristic, TP)

- M-285, 01a1bf03-032c — "**One decision for the Owner: approve Plan v2 so M-285 can be built.**" (+options A/B)
- M-258, 01a1b598-0431 — "Which do you want — (a) or (b)?" (deploy path choice)
- M-259, 01a1b496-f6e4 — "Please approve Plan v1 with the five review conditions, or move the issue to `in_progress`"

## Notes

- Read-only: no comments posted on any card.
- Exclusions behaved: `[WAKEUP]` markers, evidence blocks, fenced-code tails, and member questions never flag.
- After this week, post the offender list on M-325 (acceptance follow-up).
