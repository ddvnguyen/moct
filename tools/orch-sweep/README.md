# orch-sweep

Deterministic board sweep for the Multica Orchestrator tick: one pass over the
live board (issues, runs, wakeups, PRs, quota ledger, committee seats, queues).

- `orch-sweep` — the script. Run with no flags for the full tick JSON;
  `--stuck-list` prints only the compact M-268 committee slice
  `{at, tool, mode, hash, triggers, items}`; `--free-questions [--hours N]`
  (default 24) prints the M-328 slice `{at, tool, mode, hours,
  issues_scanned, comments_flagged, offenders[]}` for the daily ticket.
- `orch-sweep.test.sh` — seeded verification for the stuck-list mode
  (M-268 acceptance: fires once on a seeded case, silent on the same hash)
  plus the M-328 matcher/exemption cases (trailing `?`, Owner-decision
  phrases, WAKEUP/evidence/fenced-code exclusions, ask-card exemption).

## Stuck-list triggers (M-268, deterministic, no LLM judgment)

From the sweep board, wake the Leader when ANY holds:

- (a) green PR with no verdict on its SHA for >30 min, on a card with no live
  run and no pending wakeup (verdict-amendment M-268: driven cards excluded);
- (b) card idle >2 h with a resume already tried
  (`orch_baseline.resume.<card>.count>=1`);
- (c) card `blocked` >4 h;
- (d) ≥3 cards share one `failure_class`/`reason` code.

Items are `{card, trigger, age_min, pr}`. The `hash` covers stable identity
only (card+trigger+pr) — `age_min` drifts every minute and must not re-arm
the wake. The Orchestrator tick compares the hash against M-86 `stuck_list`
and arms at most one wakeup per 60 min / 4 per day on M-269.

## Free-questions check (M-328, heuristic, no LLM call)
Flags agent comments that read as free-text questions to the Owner with no
ask card from the same run: agent-authored `comment` (system /
progress_update never count) inside `--hours`, no `[WAKEUP]` marker, not an
evidence block, whose last non-empty line (fences stripped) ends in `?` or
names an Owner decision ("owner, please decide", "which option",
"approve plan v<N>", "one decision for the owner"). Exempt when a run on the
issue already carries the ask: `trigger_comment_id` match, a
`question_answer`/`question_card` run ref within ±15 min, or the comment's
`source_task_id`. Chat-mode tasks (runs without an issue thread) are exempt
by construction — there is no thread to park a card in (M-325 decision).

Output `offenders[]` are `{card, comment, agent, created_at, signal}`: the
daily-ticket paste (issue, comment id, agent), once per comment. The check
never writes to cards. 7-day dry run: `m328-dry-run.md` (2 offenders on the
board slice, FP rate 0/9 on all unique flagged comments).

 ## Deploy

This repo copy is the source of truth. The tick runs the deployed copy at
`/mnt/workspace/bin/orch-sweep` — copy it there after review:

```sh
cp tools/orch-sweep/orch-sweep /mnt/workspace/bin/orch-sweep
```

Rollback for M-268: remove the trigger paragraph from the Orchestrator
instructions + tick autopilot; the committee stops because no wakeups arrive.
