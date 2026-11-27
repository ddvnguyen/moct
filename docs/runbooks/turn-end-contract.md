# Turn-end contract runbook

Orchestrator tick contract for non-terminal cards (statuses below `done`/`cancelled`).
Source of truth for the behaviours described here is `tools/orch-sweep/orch-sweep`
in the `ddvnguyen/moct` repo; every command cited in this document exists in
`multica <cmd> --help`.

## 1. The five legal turn-end actions

When an agent ends its turn on a card, it chooses exactly one of these. Anything
else (commenting instead of acting, standing by, farming work into the background
and yielding) is off-contract and is the source of the stalled-card pattern this
runbook exists to stop.

All five are visible to the next tick: the card's `status`, its assignee, its
runs, and its wakeups are what `orch-sweep` reads. The contract is only honest
when the chosen action is the one the board actually shows.

### 1.1 Hand off

Transfer the card to another agent by changing the assignee. The agent leaving
the card ends its turn with a hand-off, not by walking away while the card still
listens to its wakeups.

```
multica issue status <card> in_progress --no-start          # keep the card open
multica issue comment add <card> --content "Handing off to @<agent>: <what was done, what remains, why this agent>"
```

After a hand-off the outgoing agent's wakeups still belong to the card, but the
new assignee is the one the tick will route to. A hand-off does **not** advance
the card's stage; it changes who owns the next resume.

The Orchestrator's tick resolves `assignee_id` to an account row in the quota
ledger (`tools/orch-sweep/orch-sweep`, `ENGINEERS_ORDER`, `ledger_row_agents`).
A hand-off into a cooling account is routed past on the next tick
(`todo_reroutes` in the sweep output). Hand off forward, never into a seat that
is already cooling.

### 1.2 Advance stage

Move the card to the next workflow step. Stage changes are the only way a card
leaves `in_progress` toward `agent_review_deploy`, `in_review`, `wait_for_decision`,
or `blocked` without changing the assignee.

```
multica issue status <card> agent_review_deploy
```

Stage is the card's declared intent. Advancing to `agent_review_deploy` says "my
work on this card is done; the Lead's review gate is next." Advancing to
`in_review` says "this is in the Owner's queue." Advancing to `blocked` says "I
cannot proceed and I am naming why in a comment."

Stage changes that put a card into an Owner-held state (`in_review`, `wait_for_decision`)
are terminal for the agent: those statuses wait on the Owner or the Architect, and
no agent-run rule auto-fires them. That is by design — they are the contract's way
of handing the card to a person. The sweep treats them as not resumable by an engineer
(`PROGRESSIBLE` in `tools/orch-sweep/orch-sweep` is `("todo","planing_2","in_progress","agent_review_deploy")`;
anything else open is not a forwardable agent state).

### 1.3 Ask / plan

Put the card into a planning state and open an explicit ask. This is the action for
"I cannot continue without a decision I do not have."

```
multica issue status <card> planing_2
multica issue comment add <card> --content "Plan: <what I would do next, what I need, who owns the decision>"
```

`planing_2` is a real stage, not a comment. The sweep tracks `planing_2` cards in
`gate_waiting` and surfaces idle ones in the queues (`fetch_queues` in
`tools/orch-sweep/orch-sweep`). A card in `planing_2` with no ask comment is still
undriven — the action is the stage plus the ask, together.

An ask is a request aimed at a person who can answer it: the Lead for a review
decision, the Architect for a directional call, the Owner for a hard-to-reverse
change. An ask that names no decider and states no deadline is not an ask; it is a
comment on a card that is still idle.

### 1.4 Wakeup with expiry

Arm a wakeup that will resume the card when a real event fires, with an explicit
expiry so a wakeup that never fires does not leave the card undriven forever.

```
# re-arm the card's own resume wakeup with an expiry (example shape; adjust fields to the card)
multica issue wakeup create <card> --event comment.created --filter-actor-type member --filter-actor-id <user-id> --expires-in 72h
# or wait on a PR verdict with a condition instead of an event:
#   multica issue wakeup create <card> --until-pr checks --expires-in 72h
# exact fields per `multica issue wakeup create --help` and the card's existing wakeups
```

The contract's wakeups are the card's drivers. A wakeup is the right end-action when
work genuinely waits on an external event: a PR verdict, a scheduled cadence, a
condition on another issue. The sweep classifies each enabled wakeup as live or dead
(`wakeup_liveness` / `classify_wakeup` in `tools/orch-sweep/orch-sweep`) and a card
whose only wakeups are dead has no driver — that is the `dead-wakeup` reason, and it
is exactly the situation a new wakeup should fix.

An expiry matters because a wakeup without one can sit past its relevance. The sweep
marks condition-wakeups older than 24 h whose card is also idle longer than 24 h as
`condition-stale` (`STALE_WAKEUP_HOURS` in `tools/orch-sweep/orch-sweep`). Arm with an
expiry that matches the real wait: "when PR #n is verdicted" is fine; "sometime" is
not, because "sometime" is indistinguishable from standing by. Use
`multica issue wakeup events` to see the event types the platform supports.

### 1.5 In_review with evidence

Move the card to `in_review` and attach the evidence the Owner needs to decide.
`in_review` is the Owner's queue; it is not a hideaway and it is not a complement to
"standing by."

```
multica issue status <card> in_review
multica issue comment add <card> --content "Review: <what is done, what the evidence is, what decision is wanted, what happens next on each outcome>"
```

The evidence is the point. A move to `in_review` with no evidence is a status change
with no payload — the Owner cannot act on it and the card sits. The sweep counts
`in_review` cards in `queues.in_review` and flags those idle longer than 24 h; the
card is visible there whether or not it carries evidence. Evidence is what lets the
Owner clear it rather than return to it.

## 2. Invariant D2

**D2 — every non-terminal card has an active run, a pending wakeup, or an open Owner
ask/plan.**

Non-terminal means any status below `done`/`cancelled`: `todo`, `planing_2`,
`in_progress`, `agent_review_deploy`, `in_review`, `wait_for_decision`, `blocked`.
A card that is not terminal must be carrying one of three things at all times:

- **an active run** — a run in a live status (`running`, `queued`, `dispatched`,
  `waiting_local_directory`, `started`) on the card. The sweep reads these from
  `multica issue runs <card>` and checks the status set `ACTIVE_RUN_STATUSES`
  (`tools/orch-sweep/orch-sweep`).
- **a pending wakeup** — an enabled wakeup that the sweep judges live (not dead,
  not stale, not children-stuck, not target-irrelevant). A card with only dead
  wakeups has no driver (`wakeup_liveness` returns an empty live list; the entry's
  `wakeup_pending` is false and the reason is `dead-wakeup`).
- **an open Owner ask/plan** — the card is in a state that names a person and a
  question: `planing_2` with an ask comment, `in_review` with evidence, `wait_for_decision`
  with the decision named, `blocked` with the blocker named. These are Owner-held states
  and are not auto-resumed by the tick; the ask/plan is what keeps them honest.

D2 is a contract between the agent ending its turn and the tick that follows. The agent
ends the turn in one of the five legal actions; the tick reads the result. If the result
is a card with no active run, no live wakeup, and no open ask/plan, D2 is violated and
the card is undriven.

### How orch-sweep detects a D2 violation

The sweep does not emit a single "D2 violated" flag — it produces the per-card `action`
and `reason` that together describe the violation. The relevant entries are:

- **`action: resumable, reason: dead-wakeup`** — the card has enabled wakeups but none
  are live (`wpending and not live_w` in `tools/orch-sweep/orch-sweep`). The card is
  undriven: its only wakeups are dead. This is the most common D2 violation and the one
  the tick resumes.
- **`action: resumable, reason: partial-stop`** — the card has an open PR, has been idle
  more than 60 minutes, and has no strong live driver (no `at`/`every`/`cron` wakeup).
  The card stopped when the PR opened and nothing drove it after (`open_pr and idle > PARTIAL_STOP_MIN and not strong_live`).
- **`action: resumable, reason: wakeup-stale`** — the card has a live wakeup that has
  never fired (`fire_count == 0`) and is older than 24 h, while the card has been idle
  longer than 24 h. The wakeup exists but has not had its chance yet and the card is
  already stale (`stale_wait and idle > STALE_WAKEUP_HOURS * 60`).
- **`action: resumable, reason: idle`** — the card has no active run, no live wakeup,
  is older than 60 minutes, and is not cooling. No driver at all (`else` branch).
- **`action: cooldown-routing, reason: cooldown-routing`** — the assignee's account is
  cooling, so the tick will not start a run here even though the card is otherwise
  resumable. D2 holds in the sense that a driver exists but is deferred; the card is
  routed to the next eligible account for its `todo` siblings (`todo_reroutes`).

A card whose entry says `run-live` (active run) or `wakeup-pending` (live wakeup) or
that sits in an Owner-held state with an ask/plan satisfies D2. A card whose entry says
`resumable` with any reason, and is not in an Owner-held state with an ask/plan, violates
D2 and is a candidate for the tick to resume or for the committee wake to flag.

The committee-level view is the stuck-list (`--stuck-list`, `build_stuck_list` in
`tools/orch-sweep/orch-sweep`). It fires on cards that are undriven and have been that
way long enough to warrant a Leader look: green PR with no verdict for >30 min on an
undriven card (trigger `no-verdict`), idle >2 h after a resume was already tried
(`idle-after-resume`), `blocked` >4 h (`blocked`), or >=3 cards sharing one
`failure_class`/`reason` (`shared:<code`).

## 3. Worked examples

### 3.1 Blocked card

A card is blocked because the fix it needs is on another card that is not done.

**What the card looks like to the sweep:** status `blocked`, no active run, wakeups
as configured, `last_activity_at` older than the block arrived.

**The contract action:** advance to `blocked` with a named blocker and an ask for the
Owner or the Lead. Do not leave it in `in_progress` with a comment saying "blocked" —
that is a D2 violation (no run, no live wakeup, no open ask/plan, just a comment).

```
multica issue status M-123 blocked
multica issue comment add M-123 --content "Blocked: waiting on M-401 (turn-end contract runbook). Need M-401 merged to integration before I can continue. Owner/Lead: please confirm priority or reroute."
```

**What the tick sees:** a `blocked` card. `orch-sweep` does not put `blocked` cards on
the resume board (they are not `in_progress`); it folds them into the stuck-list after
4 h idle (`BLOCKED_STUCK_MIN`, trigger `blocked`) and into `fetch_queues` for the
committee. The blocker comment is the ask/plan that keeps D2 honest — the card is in an
Owner-actionable state with the reason stated.

**What not to do:** set `blocked` and post no comment, or post "blocked" as a one-word
comment with no named blocker and no named decider. Either way the card is terminal-less
and undriven.

### 3.2 Review verdict

A card is at `agent_review_deploy` waiting on a PR verdict, or an agent has finished work
and wants the Lead to review.

**What the card looks like to the sweep:** status `agent_review_deploy`, the PR is open
with green checks but no review decision on its head SHA, no active run, wakeups as
configured. The sweep reports the PR in the card's `prs` with `verdict_on_head: null` and
`checks` green (`prs_for_card` + `pr_checks_green` in `tools/orch-sweep/orch-sweep`).

**The contract action:** the right end-action depends on who is ending the turn.

- If the agent who did the work is ending its turn, advance to `agent_review_deploy` (if
  not already there) and arm a wakeup that fires on the PR verdict, with an expiry, plus
  a comment naming the Lead reviewer.

```
multica issue status M-123 agent_review_deploy
multica issue comment add M-123 --content "Work done; PR #170 is open with green checks. @Claude Architect please review when the verdict lands. Expiry on the verdict wakeup: I want a ruling within the review window, not an open-ended wait."
```

- If the Lead is ending its turn after reviewing, the action is to advance the card to the
  next stage with the verdict recorded, or to `in_review` with evidence if the verdict needs
  an Owner decision.

```
# Lead reviewed, approves, card advances
multica issue status M-123 in_review
multica issue comment add M-123 --content "Review verdict: LGTM on #170 @ <sha>. Evidence: <the run, the test outcome, the deploy check>. Next: Owner merge or Architect sign-off; I have recorded the verdict here so the cards behind this one can move."
```

**What the tick sees:** an `agent_review_deploy` card with a green PR and no verdict, no
live run, no live wakeup (if the verdict wakeup is dead or stale) → `action: resumable,
reason: dead-wakeup` or, if the gate passes 30 min, the stuck-list fires `no-verdict` on
this card. That is the committee's cue to wake the Leader, not the engineer. The engineer's
job is to have left a live verdict wakeup or to have advanced the card; a green-PR card with
no driver at all is exactly what `no-verdict` exists to catch.

**What not to do:** leave the card at `agent_review_deploy` with no wakeup and no comment
and expect the Lead to notice. That is a D2 violation and a `no-verdict` stuck-list item;
the card is undriven and the verdict waits on a person who was never asked.

### 3.3 CI wait

A card's work is done but the deploy/CI gate has not finished, and the agent is ending its
turn while CI runs.

**What the card looks like to the sweep:** an open PR with checks in progress or green,
no active run on the card, wakeups as configured. If CI is still running, `checks` is not
yet green (`pr_checks_green` returns false while checks are failing or absent); the sweep
does not treat it as `no-verdict` until it is green with no verdict for >30 min.

**The contract action:** while CI is running and the agent is ending its turn, the card is
in a real external wait. The right action is a live wakeup on the CI/verdict event with an
expiry, plus a comment saying what is being waited on and what happens next. If the agent
cannot leave a live wakeup (the event type is not available), the agent advances the card to
`agent_review_deploy` and names the CI as the open ask.

```
multica issue status M-123 agent_review_deploy
multica issue comment add M-123 --content "CI is running on #170; I am ending my turn. Waiting on: the linux gate on #170. Next when green: I (or the reviewer) advance to in_review with the deploy evidence. Reviewer: @<Lead>."
```

If CI is green and the card still has no verdict and no driver after 30 min, the sweep's
`no-verdict` trigger fires. That is the cue to the committee — the agent who ended the turn
should have left a live wakeup or advanced the card; a green-PR card with no driver is exactly
the case `no-verdict` catches.

**What the tick sees:** an `agent_review_deploy` card with an open PR. While CI is not green,
the card is not `no-verdict` (it is not provably green yet); it is judged on its wakeups and
run. If the agent left no live wakeup and no run, the card is `dead-wakeup` or `idle` and the
tick resumes it or the committee flags it. The CI itself is not the driver — the driver is the
wakeup or the run the agent left. A card waiting on CI with no driver of its own is undriven
even while CI runs.

**What not to do:** end the turn with a comment "CI is running, I'll check when it finishes"
and no wakeup, no status change, no expiry. That is standing by: the card looks the same to
the tick before and after the comment, and the agent has not left a driver. When CI finally
goes green with no verdict and no driver, the card becomes a `no-verdict` stuck-list item.

## 4. What NOT to do

These are the patterns that create undriven cards. They are off-contract because they leave
the card with no active run, no live wakeup, and no open ask/plan — a D2 violation — while
looking busy in prose.

### 4.1 Comment-as-trigger

Posting a comment instead of taking one of the five actions. A comment does not change the
card's status, assignee, runs, or wakeups; to the sweep it is invisible as a driver. A card
whose only update is a comment is still judged on its status/run/wakeups and is undriven if
those are empty.

```
# off-contract
multica issue comment add M-123 --content "I'll pick this up next."
```

The comment reads as work; the board shows an undriven card. The fix is to take a legal action
instead: advance the stage, arm a wakeup with expiry, or hand off. A comment accompanies the
action; it does not replace it.

### 4.2 Standing by

Ending a turn without changing anything and expecting the next turn to pick up where this one
left off. Standing by is the quiet D2 violation: the card's status, runs, and wakeups are
unchanged, so the sweep reports the same thing it reported before, and the card is undriven if
it had no driver to start with.

```
# off-contract: no status change, no wakeup, no hand-off, no ask
# (an empty turn that leaves the card as it was)
```

The contract's answer to "I am not done but I am stopping" is one of: arm a live wakeup with
expiry on the event that will resume you, advance to `planing_2` with an ask, or hand off.
Standing by on a card that already had no driver makes the card a stuck-list candidate after
the relevant threshold (`idle-after-resume` after 2 h if a resume was tried, `idle` otherwise).

### 4.3 Background-and-yield

Farming work into the background and yielding the card without recording what is running, where
it is, and who owns the result. A background process is not an active run on the card unless it
is a run the board can see (`ACTIVE_RUN_STATUSES`). The sweep reads runs from
`multica issue runs <card>`; a process the agent started elsewhere and walked away from is not
on the board and does not satisfy D2.

```
# off-contract: start something, yield the card, leave no run and no wakeup
# the board sees an undriven card; the background work is invisible to the tick
```

If work is genuinely running in the background and should keep the card driven, the card needs
a live wakeup or a visible run that represents it. If the background work is done and the result
is not yet recorded, the agent's end-action is to record it (advance the stage, post the evidence,
arm the verdict wakeup). A card yielded with neither is undriven.

## 5. Reading the board

The Orchestrator tick runs `tools/orch-sweep/orch-sweep` once per tick and reads the JSON on
stdout. The fields most relevant to the turn-end contract:

- `board[].action` and `board[].reason` — the per-card driver verdict. `run-live` and
  `wakeup-pending` satisfy D2; `resumable` with any reason is a D2 violation candidate.
- `board[].active_run` / `board[].wakeup_pending` / `board[].wakeup_detail` — the three
  things D2 asks for, per card.
- `counts.resumable_by_reason` — how many cards violate D2 and by which reason.
- `stuck` (from `--stuck-list`) — the committee cue: cards undriven long enough to warrant a
  Leader look, with `hash` so the tick does not re-arm on a list whose only change is drift.
- `queues` — the Owner-held piles (`in_review`, `wait_for_decision`, `agent_review_deploy`,
  `todo`) with 24 h+ idle slices so the committee can slice them.

The contract is readable from this output: a card is driven when its entry is `run-live` or
`wakeup-pending`, or when it sits in an Owner-held state with an ask/plan. It is undriven when
its entry is `resumable` and it is not in an Owner-held state with an ask/plan.

## 6. Source citations

Every behaviour described here is from `tools/orch-sweep/orch-sweep` in the `ddvnguyen/moct`
repo (the merged orch-sweep v2: M-218, M-284, M-268) plus the M-256 discussion that defined the
turn-end contract and invariant D2. Specifics:

- Five legal turn-end actions and invariant D2: M-256 discussion (parent of this card), as
  operationalized by the Orchestrator and Claude Architect's contract deliverable.
- `ACTIVE_RUN_STATUSES`, `card_runs`, `board[].active_run`: `tools/orch-sweep/orch-sweep`.
- `wakeup_liveness`, `classify_wakeup`, `board[].wakeup_pending`, `wakeup_detail`,
  `dead-wakeup`/`partial-stop`/`wakeup-stale`/`live-wakeup`/`fresh`/`cooldown-routing`/`idle`
  reasons, `STALE_WAKEUP_HOURS`, `PARTIAL_STOP_MIN`, `IDLE_THRESHOLD_MIN`: `tools/orch-sweep/orch-sweep`.
- `PROGRESSIBLE` and the Owner-held-state rule (only `todo`, `planing_2`, `in_progress`,
  `agent_review_deploy` are forwardable by an agent): `tools/orch-sweep/orch-sweep`.
- `fetch_queues`, `gate_waiting`, `todo_reroutes`, `wip_breaches`, committee seats: `tools/orch-sweep/orch-sweep`.
- Stuck-list triggers `no-verdict`, `idle-after-resume`, `blocked`, `shared:<code>`,
  `VERDICT_WAIT_MIN`, `STUCK_IDLE_MIN`, `BLOCKED_STUCK_MIN`, `SHARED_CODE_MIN`, `build_stuck_list`:
  `tools/orch-sweep/orch-sweep` (M-268).
- Quota ledger, `classify_failure`, confirmed-signal cooldown rule, unknown-tier never-cooldown:
  `tools/orch-sweep/orch-sweep` (M-218).

Behaviours not present in `tools/orch-sweep/orch-sweep` are omitted from this document.
