# orch-sweep

Deterministic board sweep for the Multica Orchestrator tick: one pass over the
live board (issues, runs, wakeups, PRs, quota ledger, committee seats, queues).

- `orch-sweep` — the script. Run with no flags for the full tick JSON,
  including the `v2` block (invariant, blocked kinds, wakes, Leader queue).
  `--apply` is the only mode that writes: it arms the v2 wakes and records the
  per-card budget. `--invariant` and `--blocked-kinds` print those slices and
  write nothing. `--role-pilot-config <path>` (default `role-pilot.json` beside
  the script) and `--max-role-pilot-cards N` (default 20) tune the M-588 role
  split; `--apply` is what records an arm. Role readiness is decided by a
  `agent role-route` CLI probe (see below), not by the agent row. `--stuck-list` prints the compact M-268 committee slice
  `{at, tool, mode, hash, triggers, items}` (deprecated alias, one release);
  `--free-questions [--hours N]` (default 24) prints the M-328 slice
  `{at, tool, mode, hours, issues_scanned, comments_flagged, offenders[]}` for
  the daily ticket. `--illegal-endings [--hours N]` (default 24) prints the
  M-391 slice `{at, tool, mode, hours, issues_scanned, checked,
  comments_flagged, offenders[]}` for the daily ticket: agent comments with
  illegal turn-ending language (`standing by`, `waiting for review`,
  `<role> needed` with no trigger, `next:`/`next step` to nobody,
  `someone should`, `to-do for` nobody). The full result also includes the
  M-393 `incomplete_turns` report; `--apply-incomplete-turns` persists its
  run-ID ledger.
- `orch-sweep.test.sh` — seeded verification for the stuck-list mode
  (M-268 acceptance: fires once on a seeded case, silent on the same hash),
  the M-328 matcher/exemption cases (trailing `?`, Owner-decision phrases,
  WAKEUP/evidence/fenced-code exclusions, ask-card exemption), the M-393
  incomplete-turn cases, the M-391 illegal-endings cases (signals, exclusions,
  same-run driver exemption), and the M-392 v2 cases (invariant satisfiers, blocked
  kinds, wake budget, dry-run zero writes, batched Leader ping), plus the
  M-588 B1b role-split cases (arm stability, 30 % ±1.5 over 10k uuids, pct=0,
  never re-split, dry run writes nothing, cards with runs, unreadable runs,
  `pre_assigned`, and a failed write that keeps the arm), plus the B1d/G1
  route-probe cases: an `offline`/unbound agent row no longer gates a Role;
  the fake `multica` on `PATH` answers `agent role-route`; flag off, no online
  runtime, stale runtime, no capacity, all tiers manual/cooldown, and a probe
  error each land on `named` with a precise `reason`. The harness puts a
  `multica` shim on `PATH` (empty JSON for any un-stubbed call except a seeded
  `role-route`), so it runs in CI where no CLI exists.
- `tick-prompt-delta.md` — the Orchestrator prompt text to apply with the
  deploy; without it the tick still carries the hash gate and v2 is inert.

## Invariant, blocked kinds, event wakes (M-392, D2/D3/D4)

**D2 invariant.** Every non-terminal card must have an active run, a live
wakeup, or an open ask. `in_review`, `done` and `cancelled` are Owner-held and
out of scope. `--invariant` prints `{checked, scope, cap, satisfied_by,
violators[], violators_after[], escalations[]}`; each violator carries the one
driver it would use (`wake:<cause>`, `ask`, `reassign`, `inspect`). Batched
Leader work lands in `leader_queue` and is delivered by ONE `leader_ping` wake
on `M-256` — at most one per 60 min, none while a Leader wake is pending, none
on an empty queue. That replaces the stuck-list hash gate and the global
4/day cap.

**D3 blocked kinds.** `blocked` is never parked. `metadata block_kind`
(`owner | dependency | agent`) plus `block_on` (`M-key` or `PR#n`) is the
contract; without it the sweep falls back deterministically (open ask → owner,
open blocker or issue ref → dependency, else agent) and stamps `kind_source`.
An unknown metadata value is `unverified` and gets no automatic action.
Drivers: Owner → one batched ask per cluster (same `block_on`); dependency →
`wakeup --until-issue|--until-pr|--until-children-done` with an expiry and
`--on-timeout wake`; agent → resume the assignee, or reassign when its account
is cooling. The "after 2 failed resumes → blocked" rule is gone.

**D4 wakes.** Wakes come from events/conditions the platform actually has and
every one is one-shot or expiring. Budget is per card per ICT day: 6 wakes
(`--max-wakes-per-card`, stored in card metadata `wake_budget` as
`{d, n, last, esc}`). At the limit the sweep refuses, logs ONE escalation for
that day (`esc`) and reports it; a failed `wakeup create` spends no budget.
A delay (`--after`) is armed as the platform's `at` kind — with the default
event kind the server rejects it with "select at least one supported event" —
and the test stub enforces that rule plus "conditions use event kind" so a
malformed flag set fails here instead of silently arming nothing.

**Coverage is verified, not assumed.** `violators_after` drops a card only when
its wake actually armed or its Leader queue was actually delivered by an armed
ping. A create failure, a budget refusal, an unreadable card, or a ping that
did not leave the box all stay listed, alongside their `escalations` entry.

**Bound.** `--max-invariant-cards` (default 60) caps one pass, keeping every
`blocked` card and then the oldest idle of the rest; `scope` reports the true
total so a cap cannot truncate silently. Read cost per checked card is one
`issue runs` + one `wakeup list`, plus one `question list` only when neither
the run nor the wakeup satisfies it.

## Role pilot split (M-588 B1b)

A deterministic 30 % A/B split of new work between the **Engineer Role** and the
named agents. The result is a `role_pilot` block in every sweep JSON.

**Bucket.** `int(sha256(issue_uuid).hexdigest()[:8], 16) % 100`. The card uuid,
not the identifier, so the answer is the same on any host and never drifts. The
card is in the role arm iff `bucket < pct`.

**Config.** `role-pilot.json` beside the script (override with
`--role-pilot-config`):

```json
{"pct": 30, "engineer_role_id": "…", "lead_role_id": "…", "max_wip": 1}
```

A missing or malformed file fails closed: `pct=0`, `status` is
`config_missing` / `config_invalid`, and every candidate card is recorded
`named` with that reason.

**Who is eligible.** A `todo` / `in_progress` card that has no recorded arm, no
runs yet, and is either unassigned or already assigned to the Engineer Role.
Cards already recorded are counted in `counts.existing` and never re-split.
Cards assigned to any other agent are `pre_assigned` — a hand-routed card is
never relabelled. Cards with runs are `already_run`; an unreadable
`issue runs` (or a missing CLI) is `runs_unreadable` and the card keeps no arm.
`--max-role-pilot-cards` caps the per-pass `issue runs` calls; anything left
over is `truncated`.

**Readiness, fail closed (M-588 B1d / G1).** A Role is `status=offline` and
`runtime_bound=false` forever by construction, so those agent-row fields are
**not** consulted any more. The role arm needs both Roles ready by *route*:
not archived, the workspace flag on, at least one tier that is enabled, not
`manual_only`, not in cooldown, with a member runtime that is `online`, fresh
(`runtime_last_seen_at` within 15 minutes) and has a free slot; the Engineer
Role must also be below `max_wip`. Any failure records `named` with a precise
`reason` and appends `{card, reason, arm}` to `skipped[]`, so a go-live period
with no route is visible as `counts.fallback` rather than silently filling the
control group. Reason codes: `role_flag_off`, `role_route_unreadable` (probe
error, including a missing CLI command), `role_route_no_eligible_tier` (all
tiers disabled/manual/cooldown), `role_route_no_online_runtime` (no online and
fresh member), `role_route_no_capacity` (online but no free slot). Archive /
WIP / unknown still use `role_*` / `lead_*` prefixes.

**Route read (the smallest read-only endpoint).** The probe calls:

```
multica agent role-route <role-id> --output json
```

and expects (read-only, one call per Role; no key or secret in the output):

```json
{"flag_on": true, "tiers": [
  {"name": "go-hy4", "enabled": true, "manual_only": false, "cooldown_until": null,
   "members": [{"runtime_id": "…", "runtime_status": "online",
                "runtime_last_seen_at": "2026-11-26T09:00:00Z", "free_slots": 3}]}
]}
```

**Gap:** no `multica` CLI command and no API the sweep already uses exposes
`model_tier_role` / tier members today (confirmed with `multica --help`,
`agent --help` and the B4 tier-pick audit). The sweep therefore fails closed
with `role_route_unreadable` until that narrow read exists; go-live needs the
CLI binding above added to `multica-x`. The sweep never guesses a DB path.
The probe result is echoed in `engineer_role.route` / `lead_role.route` in the
sweep JSON.

**Record.** With `--apply` (the only write mode) the arm is written once as
card metadata `role_pilot`:

```json
{"arm":"named","bucket":5,"pct":30,"reason":"role_route_no_capacity","at":"2026-11-26T09:00:00Z"}
```

`role` cards also get `engineer_id` (assignee) and `reviewer_id` (the
Management Role) in the `eligible[]` entry. A failed metadata write is
reported in `recorded[]` with `written:false` and **does not change that
pass's routing** — the arm was decided before the write.

Block shape: `{status, pct, config, apply, engineer_role, lead_role,
eligible[], skipped[], recorded[], counts{role,named,skipped,existing,fallback,
intended_role}, truncated}`. `counts.fallback` is the intent-to-treat count:
cards that hashed into the role arm but were routed `named` because a Role was
unavailable.

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
`/mnt/workspace/bin/orch-sweep` — copy it there after review, together with the
prompt text from `tick-prompt-delta.md`:

```sh
cp tools/orch-sweep/orch-sweep /mnt/workspace/bin/orch-sweep
```

Rollback for M-268: remove the trigger paragraph from the Orchestrator
instructions + tick autopilot; the committee stops because no wakeups arrive.
Rollback for M-392: restore the previous script and prompt text; the only v2
state is per-card `wake_budget` metadata, which is inert without the sweep.
