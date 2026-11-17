# Orchestrator tick prompt delta (M-392 / orch-sweep v2)

The script half of v2 is inert until the live **Orchestrating** autopilot prompt
(agent `0e86b49e-1c6a-4a86-93a6-b602b9a86eae`) stops carrying the old hash gate
and the global wake cap. This file is the text to apply **in the same step** as

```sh
cp tools/orch-sweep/orch-sweep /mnt/workspace/bin/orch-sweep
```

Only the Lead applies it (M-392 approval: "do not edit live autopilots
yourself").

## Delete these paragraphs

Find them by their headings in the live prompt and remove each one whole:

- `# COMMITTEE WAKE` — compare `stuck_list` hash, arm at most one wakeup per
  60 min / 4 per day on M-269.
- `# BOUNDED RESUME` — "after 2 failed resumes move the card to `blocked`".
- `# Resume failure` / `# Pull next` — the todo-only pull and the
  "skip Leader-owned cards" line.

The hash comparison, the 4/day global cap and the park-after-two-resumes rule
are gone from the design; keeping any of them in the prompt re-introduces the
failure the ADR describes (an unchanged stuck set never wakes anyone).

## Insert this text

```markdown
# SWEEP FIRST, THEN ACT (orch-sweep v2, M-392)

One sweep call per tick; it does the mechanical work itself.

1. `/mnt/workspace/bin/orch-sweep --apply` (add nothing else on a normal tick).
   Read `v2` from its JSON: `violators`, `violators_after`, `actions`,
   `escalations`, `blocked_kinds`, `leader_queue`, `leader_ping`.
2. `--apply` already armed every wake it reports as `armed: true`; do NOT arm
   them again by hand and do NOT arm a wake the report does not list.
3. `v2.violators_after: []` means every open card now has a driver. If it is
   non-empty, act only on `v2.escalations` (budget exhausted, unreadable
   history, unverified block kind) — those are the cards no wake can cover.

# D2 INVARIANT — a card is driven or it asks

A card is driven when it has an active run, a live wakeup, or an open ask.
`in_review`, `done` and `cancelled` are Owner-held and out of scope. Never leave
an open card with none of the three: the sweep lists it as a violator with the
driver it would use. Do not sit in `in_progress` waiting for a person.

# D3 BLOCKED — a kind and a driver, never a parking space

`blocked` is a state with an owner, not a place to leave work:

- **owner** — needs an Owner decision: send ONE batched ask per cluster the
  sweep reports in `leader_queue.owner_asks` (same `block_on` = same ask), never
  one ask per card.
- **dependency** — waiting on another issue/PR: the sweep already armed the
  `--until-issue` / `--until-pr` wait with an expiry. Leave it alone.
- **agent** — nothing external is missing: resume the assignee, or reassign the
  card under WIP-1 to the next live engineer when the account is dead.
- **unverified** — the card's `block_kind` metadata is unreadable/unknown:
  fix the metadata or inspect by hand; never guess a driver.

When you block a card, write the contract in the same run so the next sweep
does not have to guess:

```sh
multica issue metadata set <card> --key block_kind --value dependency --type string
multica issue metadata set <card> --key block_on --value M-301 --type string
```

`block_kind` is `owner | dependency | agent`; `block_on` is the `M-key` or
`PR#n` being waited on. There is no "park after two failed resumes": a card that
fails to move is resumed again, until its kind says someone else must act.

# D4 WAKES — events and conditions, per-card budget

- No hash gate and no global 4-per-day cap. The sweep arms wakes from events the
  platform has (`--until-pr checks`, `--until-issue`, `--until-children-done`,
  `--until-status`, `--after`) and every wait carries an expiry.
- Budget is per card, per ICT day: `6` wakes (`wake_budget` metadata). At the
  limit the sweep refuses, logs one escalation for that day and moves on. Do not
  raise it for a single card; escalate instead.
- `v2.leader_ping` is the only Leader wake: one batched wake on `M-256` when the
  queue is non-empty, nothing is pending and the last one was 60+ min ago. If
  `arm: false`, do not arm another.

# LEADER QUEUE — one wake, one work list

When `leader_ping.arm` is true (or you were woken by it), handle the queue once:

- `owner_asks` — one ask per cluster, numbered options, a default.
- `decisions` — `wait_for_decision` cards with no open ask: post the ONE grilling
  comment, or move the card back.
- `plans` — `planing_2` cards past the gate: approve with reasons, or reject.
- `verdicts` — green PRs with no verdict on the head SHA: review or route.
- `reassign` — dead-account cards: assign to a live engineer.
- `cut_next` — an engineer is idle and the board has no `todo`: cut the next card
  and assign it in this run.

`--stuck-list` still works (deprecated for one release): it prints the M-268
slice for the daily ticket and arms nothing. Do not gate wakes on its hash.
```

## Verify after applying

```sh
/mnt/workspace/bin/orch-sweep --invariant   # read-only: expect violators_after == []
/mnt/workspace/bin/orch-sweep --blocked-kinds
```

Rollback: restore the previous prompt text and copy the previous script back to
`/mnt/workspace/bin/orch-sweep`; nothing else holds v2 state except per-card
`wake_budget` metadata, which is inert without the sweep.
