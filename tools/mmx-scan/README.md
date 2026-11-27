# mmx-scan

Read-only data feed for the MMX self-improvement loop (M-571 ADR slice 1, M-606).
It never changes issues, comments, memory or agents.

- `mmx-scan signals [--hours 24] [--markdown]` — correction signals for the daily
  **MMX curator** autopilot: reopens, backward status moves (Needs changes),
  moves to `blocked`, `plan_verdict` runs, REQUEST_CHANGES / rejected-plan
  comments, Owner comments (candidates; the curator decides which are
  corrections), cards with ≥2 failed runs, and pending MOCT records.
- `mmx-scan baseline [--days 7] [--markdown]` — weekly usage baseline over
  `multica issue run-messages`: share of completed runs that loaded `mmx`,
  `memory_search` / `memory_get` / `memory_note` calls, "Harness edit:"
  proposals, new active team `convention`/`rule` records. The curator's own
  autopilot runs are excluded (`--curator-agent`).
- `mmx-scan snapshot [--date YYYY-MM-DD] [--out DIR]` — M-608 daily metric
  counts, one JSON line per agent per UTC day plus a `_workspace` row (below).
- `mmx-scan export --out DIR` — the incumbent harness as plain files: skills,
  agent/Role instructions + meta, Workspace Context, autopilot prompts.
- `mmx-scan nightly --repo CHECKOUT [--push BRANCH]` — export, commit if
  changed, then snapshot every complete day without a file against that
  commit, commit, push. Idempotent: a second run the same day commits nothing.
- `mmx-scan compare --metrics DIR --target METRIC --start DAY [--canary a,b]`
  — the acceptance rule as a calculation (suggests adopt / revert /
  insufficient-data; the Architect decides).
- `mmx-scan chart --metrics DIR` — weekly loop chart (mermaid) for the Monday
  curator triage card.
- `mmx-scan.test.py` — seeded checks for the detection rules
  (`python3 -I tools/mmx-scan/mmx-scan.test.py`).

Detection rules and their known blind spots are in the script docstring.
Baseline to beat (M-571, 2026-11-25..27): 1/429 completed runs loaded `mmx`.

## Metric lines (M-608)

Lines hold **counts**, never ratios, so any window re-aggregates exactly.
`harness_commit` is the last incumbent-export commit when the day was
measured (for back-filled days it postdates the day).

| Field | Meaning |
|---|---|
| `cards_in_review` | cards that entered `in_review` that day, attributed to the **builder**: the agent that last moved the card forward out of `todo`/`planing_2`/`in_progress` |
| `reopens` | moves back out of `in_review`/`done` (any actor) |
| `owner_correction_comments` | Owner comments on a delivered card (`agent_review_deploy`/`in_review`/`done`) matching the "no, do X" regex (heuristic) |
| `corrected_cards` | distinct cards with a reopen or an Owner correction that day |
| `sent_back` | other backward moves (review sent the work back) |
| `request_changes` / `prs_opened` | REQUEST_CHANGES verdict comments; PRs opened, attributed by head branch `agent/<slug>/` |
| `done_cards` / `days_in_review_sum` | cards moved to `done`; days since they last entered `in_review` |
| `tokens_*` | `issue usage` of the cards in `cards_in_review` (whole card, all agents) |
| `runs` `completed` `failed` `blocked` `cancelled` | runs created that day |
| `resumes` | Orchestrator stall resumes (orch-sweep "Resume the task now" wakeups) |
| `mmx_runs` `memory_*` `harness_edit` `asks` | loop usage from run messages (curator autopilot runs excluded, counted in `curator_runs`) |
| `active_team_rules` | `_workspace` row only: active team `convention`/`rule` records at measurement time |

Derived metrics (`compare`, `chart`): `correction_rate` = corrected/cards,
`request_changes_per_pr`, `tokens_per_card` (input+output+cache write),
`days_in_review`, `failed_run_rate` = (failed+blocked)/runs, `resume_rate`,
`asks_per_run`, `mmx_share`, `memory_calls_per_run`.

## Harness-edit records and the acceptance rule

One card per harness edit, `multica issue metadata set <card> --key K --value V`
for `kind=harness-edit` plus: `component`, `layer`, `hypothesis`,
`target_metric` (a derived metric name), `guard_metrics` (comma list),
`baseline` (value + window), `canary_agents` (names, or `all` for L0),
`window` (start..end UTC days), `result` (effect and δ from `compare`),
`verdict` (`proposed|canary|adopted|reverted`), `tokens_added`.
`chart` counts `adopted` vs `reverted` from these cards. The verdict is also a
MOCT `decision`: `MMX verdict: <component>: adopted|reverted …`.

Adopt only if all hold, otherwise revert (revert the incumbent commit's
change through `multica skill update` etc.) and record it as falsified:
1. canary on 1–2 agents (L0 / global edits: all agents, before/after);
2. each arm ≥ 7 days and ≥ 10 delivered cards in the after window, ≥ 14 baseline days;
3. target gain > δ, where δ = 95th percentile of |effect| under placebo
   splits of the 14 baseline days (day-level bootstrap; difference-in-differences
   vs the other agents when there is a canary);
4. no guard metric (`tokens_per_card`, `failed_run_rate`, `asks_per_run`) worse by more than δ;
5. `tokens_added` is paid for by the gain (Architect judgement).

## Requirements

Runs inside a Multica task: uses `$MULTICA_CLI_PATH` and the run token. MOCT
records are read through `multica moct-mcp` (stdio); `MOCT_WORKSPACE_ID` and
`MOCT_EXPERT_ID` default to `multica:ws:$MULTICA_WORKSPACE_ID` and
`multica:agent:$MULTICA_AGENT_ID`. If moct-be is unreachable the MOCT fields
say `unavailable` and the rest of the scan still runs.

## Deploy

The curator autopilot runs the deployed copy:

```sh
cp tools/mmx-scan/mmx-scan /mnt/workspace/bin/mmx-scan
```

Data (metrics + incumbent) is committed by `nightly` to a data branch/repo,
not to `integration`. Rollback: pause the autopilot (`multica autopilot update <id> --status paused`).
