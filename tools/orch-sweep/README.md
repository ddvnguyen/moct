# orch-sweep

Deterministic board sweep for the Multica Orchestrator tick: one pass over the
live board (issues, runs, wakeups, PRs, quota ledger, committee seats, queues).

- `orch-sweep` — the script. Run with no flags for the full tick JSON;
  `--stuck-list` prints only the compact M-268 committee slice
  `{at, tool, mode, hash, triggers, items}`; `--free-questions [--hours N]`
  (default 24) prints the M-328 slice `{at, tool, mode, hours,
  issues_scanned, comments_flagged, offenders[]}` for the daily ticket. The
  full result also includes the M-393 `incomplete_turns` report;
  `--apply-incomplete-turns` persists its run-ID ledger.
  `--illegal-endings [--hours N]` (default 24) prints the M-391 slice
  `{at, tool, mode, hours, issues_scanned, checked, comments_flagged,
  offenders[]}` for the daily ticket: agent comments with illegal
  turn-ending language (`standing by`, `waiting for review`,
  `<role> needed` with no trigger, `next:`/`next step` to nobody,
  `someone should`, `to-do for` nobody).
- `orch-sweep.test.sh` — seeded verification for the stuck-list mode
  (M-268 acceptance: fires once on a seeded case, silent on the same hash)
  plus the M-328 matcher/exemption cases (trailing `?`, Owner-decision
  phrases, WAKEUP/evidence/fenced-code exclusions, ask-card exemption) and
  the M-393 incomplete-turn cases.

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

## Illegal-endings check (M-391, heuristic, no LLM call)

Text-pattern complement to the M-393 state-delta incomplete-turn detector
(M-393 looks at run/status/wakeup deltas, never at comment wording; this
check looks only at wording, never at deltas). Flags agent comments that
end a turn with language the turn-end contract forbids: the run stops
without handing off, advancing the issue, asking, or arming a wakeup.
Same one-`--since`-pass-per-issue architecture as M-328, read-only: no
card writes, no metadata writes.

Signals (case-insensitive, fenced code stripped before matching):

- `standing-by`: `standing by` / `stand by`;
- `waiting-for-review`: `waiting for review`;
- `role-needed`: `<role> needed` with no trigger (lane operator,
  claude/opus architect, architect, leader, owner, operator, reviewer);
- `next-unnamed`: `next:` / `next step` assigning work to an unnamed person;
- `someone-should`: `someone should`;
- `todo-for-unnamed`: `to-do for` / `todo for` an unnamed owner.

Exclusions (mirroring M-328): `[WAKEUP]` markers, evidence blocks, fenced
code, and any comment on an issue that already has an open ask card
(`freeq_has_ask_card`, same run) or an enabled wakeup armed by the same
run (same `source_task_id` / `trigger_comment_id`, or created within
15 min after the comment). The `role-needed` / `next-unnamed` /
`someone-should` / `todo-for-unnamed` signals are additionally skipped
when the comment names an owner (`@mention` or `mention://` link):
naming someone IS a trigger.

Output `offenders[]` are `{card, comment, agent, created_at, signal}`,
sorted by `(card, created_at)`: the daily-ticket paste, once per comment.

## Incomplete-turn detector (M-393, D6)

The full sweep examines at most 40 `in_progress` / `planing_2` issues per
pass, rotating the issue cursor when the board is larger. It considers only
completed runs newer than the saved sweep boundary. A run is a no-delta
candidate only while its issue remains in a working status and assigned to the
run's agent, and only when its run window has no status/assignee activity,
agent-authored comment, or created wakeup. Failed/cancelled runs and terminal
issue states are ignored. Unreadable or ambiguous history yields a `skipped`
entry and does not advance the boundary.

`incomplete_turns.actions[]` is deduplicated by run ID and contains the action,
issue/run/agent IDs, occurrence number, target agent, and reminder text. The
Orchestrator applies `requeue_same_agent` by posting the action's reminder
once, then calling `multica issue rerun-task <run-id>` on occurrence 1. The
CLI's `rerun-task --help` has no reminder/instruction flag, so the comment is
a separate action. Occurrence 2 posts one reminder and calls
`multica issue assign <issue-id> --to-id bd7b7aae-88e9-4260-a7b5-301993757e59`.
It takes no further action at occurrence 3. If Claude Architect is already the
agent, the action is `leader_noop`; do not assign it to itself. Use
`--apply-incomplete-turns` only on a tick that consumes the emitted actions.
A changed run resets the `(issue, agent)` count. The normal sweep remains
read-only.

### Task-completion hook finding

Verified with Multica CLI `multica main-0.9.0-4190621-20261115-054651Z`:
`multica issue --help` exposes `rerun-task`, `timeline`, and `runs`, but no
completion-rejection switch or hook. In `multica-x`,
`server/internal/handler/daemon.go:5066-5174` accepts and commits a valid
`/complete` callback, then calls `DecideContinueUnfinishedStep`; that is a
post-completion continuation hook, not a rejection hook. The policy in
`server/internal/service/continue_unfinished.go:19-26,34-61` queues up to two
same-agent continuations after a clean no-progress completion, then routes
continued silence to the Orchestrator. No completion-reject hook was found in
those paths. Other runtime/provider completion hooks were not exhaustively
searched and remain unverified.

 ## Deploy

This repo copy is the source of truth. The tick runs the deployed copy at
`/mnt/workspace/bin/orch-sweep` — copy it there after review:

```sh
cp tools/orch-sweep/orch-sweep /mnt/workspace/bin/orch-sweep
```

Rollback for M-268: remove the trigger paragraph from the Orchestrator
instructions + tick autopilot; the committee stops because no wakeups arrive.
