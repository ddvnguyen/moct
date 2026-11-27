# Wakeup cookbook

A wakeup is the only thing that starts a run on a card nobody is looking at. A
wait an agent leaves behind without one is not a wait, it is a dead card
(invariant D2 in [turn-end-contract.md](turn-end-contract.md)). This runbook is
the reference for arming one correctly.

Source of truth for every flag here: `multica issue wakeup --help`,
`multica issue wakeup create --help` and `multica issue wakeup events`. If a flag
is not in that output, it does not exist. Design context: M-256, M-392 (orch-sweep
v2 arms the same shapes from `tools/orch-sweep/orch-sweep`).

## 1. Pick the kind

`--kind` is one of `event` (default), `at`, `every`, `cron`.

| You wait on | Flags | Shape |
| --- | --- | --- |
| CI finishing on the card's PR | `--until-pr checks` | condition |
| The PR merging | `--until-pr merged` | condition |
| The PR's head gaining conflicts | `--until-pr conflicts` (GitHub only) | condition |
| This card reaching a status | `--until-status KEY` | condition |
| Another card reaching a state | `--until-issue M-<n> [--until-issue-state done\|ended\|in_review\|blocked]` (default `done`) | condition |
| Every sub-issue closing | `--until-children-done [--stage N]` | condition |
| A card changing hands | `--until-assignee member\|agent\|squad:ID` | condition |
| A label, or a property value | `--until-label LABEL_ID`, `--until-property ID=VALUE` | condition |
| Something happening on this card | `--event <type,...>` (types: `multica issue wakeup events`) | event |
| A delayed resume | `--kind at --after 15m`, or `--kind at --at <RFC3339>` | time |
| A cadence | `--kind every --every 1h` (minimum `1m`), `--kind cron --cron "..." --timezone UTC` | repeating |

Rules that come from the CLI and from how the sweep arms wakes:

- One condition per rule: the help says to use one `--until-*` flag "instead of
  `--event`". Conditions are created as kind `event`; do not pass `--kind at`
  with `--until-*` (the sweep's test stub enforces "conditions use event kind").
- `--after` belongs to the `at` kind. On the default event kind the server
  rejects it with "select at least one supported event"
  (`tools/orch-sweep/README.md`).
- `--agent-id` defaults to the authenticated agent. That is usually what you
  want; pass it only to wake somebody else.
- Event rules take a source filter. `--filter-actor-type member|agent` with
  `--filter-actor-id <uuid>` identifies who made the change; `--filter-agent-id`
  and `--task-id` are the task-event forms. Without a source filter every
  matching event on the card wakes the target.
- `--instruction` (or `--instruction-file`) is what the waking run reads first:
  say what to do next, not what happened. `--parent <comment-id>` replies in a thread.

## 2. Always cap the wait

Pass `--expires-in 24h` (or `--expires-at <RFC3339>`) **and**
`--on-timeout wake` on every rule that waits on something outside the card.

The default `--on-timeout end` kills the rule at the deadline and the card goes
undriven with no error anywhere. `wake` runs the target once to handle the
deadline itself, which is the only honest end for a wait whose fact may never
arrive.

House values, from `tools/orch-sweep/orch-sweep` (`PR_WAIT_EXPIRES`,
`DEP_WAIT_EXPIRES`, `CHILDREN_WAIT_EXPIRES`): PR waits 24h, issue and children
waits 72h. Pick the value from how long the fact really takes; "sometime" is
indistinguishable from standing by.

A condition that already holds fires on the next check, except `--until-pr
checks`, which waits for a newer finished result (`wakeup create --help`). Do
not arm a condition whose fact is already true unless you want an immediate run.

## 3. Read the rule before you trust it

```
multica issue wakeup list M-408 --output json
multica issue wakeup get M-408 <wakeup-id> --output json
```

Read four fields:

- `last_error` — non-null means the watched fact cannot become true yet. A real
  one, observed on M-391: `Condition pending: No pull request is linked to this
  issue; link the PR to this issue (a parent issue's PR is not included), or
  wait for the linking webhook`. The rule is armed but will never fire; fix the
  world or delete it.
- `fire_count`, `next_fire_at`, `expires_at` — where the rule actually is. A
  `once` rule that already fired shows `enabled: false` with `fire_count: 1`:
  that is success, not breakage.
- `paused_reason` — loop protection, from `wakeup events`: a rule stops when
  its trigger chain passes through it a third time with no person in between,
  or when it starts more than 12 runs in an hour.
- `last_task_status` — whether the run it started is still going.

## 4. Three mistakes that look like coverage

**1. A wakeup on a card already `done` or `cancelled`.** The run wakes to find
nothing to do, and the rule drives nothing. Deleting an issue withdraws its
wakeups (`wakeup events`), so a rule on a closed card only burns a run. Check
the status first; closed work needs a new card, not a wakeup. In reverse, a
condition whose target is already `ended` (`done` or `cancelled`) can never fire.

**2. An event rule for an agent that is not the assignee.** The rule wakes
`agent_id` on this card. If that is not the assignee, the run inherits a card it
does not own while the assignee stays asleep. Leave `--agent-id` at its default,
or reassign the card first (`multica issue assign`). Conditions have the same
property: they wake `agent_id`, not "whoever is assigned".

**3. An `at` rule left in the past.** `--kind at --at 2026-11-17T09:00:00Z`
written for a deadline that has passed, or an `at` rule whose `next_fire_at` is
past with `fire_count: 0`, is not a driver: it will not resume the card at the
time you meant. Re-arm it (`--after` or a new `--at`) or delete it, so the next
sweep does not count it as coverage. The M-400 audit reads stale rules exactly
this way and names the fixing command per row.

## 5. Copy-paste examples

**Wait for CI on the card's PR, then decide.**

```
multica issue wakeup create M-408 \
  --until-pr checks --expires-in 24h --on-timeout wake \
  --instruction "CI finished on the M-408 PR. Green: review, then merge with --match-head-commit. Red: fix, push, re-arm this wait."
```

**Wait for a blocker card to land.**

```
multica issue wakeup create M-408 \
  --until-issue M-409 --until-issue-state in_review --expires-in 72h --on-timeout wake \
  --instruction "M-409 is in_review. Read its verdict; if it unblocks M-408, continue the step, otherwise reassign or comment once with the blocker."
```

**Wait for every sub-issue, first stage only.**

```
multica issue wakeup create M-408 \
  --until-children-done --stage 1 --expires-in 72h --on-timeout wake \
  --instruction "Stage-1 sub-issues are closed. Start stage 2, or post the evidence block if this card is done."
```

**Delayed self-resume, and waiting on a person's comment.**

```
# 15 minutes from now, one run (--after needs the at kind)
multica issue wakeup create M-408 \
  --kind at --after 15m \
  --instruction "Re-read the M-408 card; if the PR is still unpushed, push it and arm the next wait."

# the Owner commenting on this card
multica issue wakeup create M-408 \
  --event comment.created --filter-actor-type member --filter-actor-id 26a523af-37a5-4d83-b281-24c58109a772 \
  --expires-in 48h --on-timeout wake \
  --instruction "The Owner replied on M-408. Treat it as the decision it is, act on it, and move the card."
```
