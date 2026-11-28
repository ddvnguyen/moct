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

Known limits (accepted in review): `corrected_cards` is counted on the day of
the correction, not the delivery day, so a single day's ratio mixes cohorts
(pool over a window); whole-card tokens are credited to the builder, reviewer
runs on that card included; a card reopened and delivered again counts its
tokens twice. A REQUEST_CHANGES comment by the builder itself (quoting the
verdict) is not counted.

Derived metrics (`compare`, `chart`): `correction_rate` = corrected/cards,
`request_changes_per_pr`, `tokens_per_card` (input+output+cache write),
`days_in_review`, `failed_run_rate` = (failed+blocked)/runs, `resume_rate`,
`asks_per_run`, `mmx_share`, `memory_calls_per_run`, `harness_edit_per_run`.

## SIM ledger, composite gate and rounds (M-612)

The SIM record lives in Knowledge_Documents (`sim/`, same data repo as
`mmx-harness`, because `moct` is public): `problems/P-<n>.json`, immutable
attempt files `attempts/A-<round>-<n>.json`, one verdict file per judged attempt
`attempts/A-<round>-<n>.verdict.json`, and the generated `INDEX.json`.
Files are written once and never rewritten; a verdict is a new file, and a
close is a `P-<n>.closed.json` marker. The problem→attempts link is derived by
scanning attempt files (`problem_id`), so later attempts never rewrite a
problem file.

- `mmx-scan sim new-problem --sim DIR --name .. --root-cause .. [--round N]`
- `mmx-scan sim new-attempt --sim DIR --round N --problem P-n --layer L4 --component mmx --what .. --rationale .. [...]`
  — records the adoption time (all-agent rollout); refuses a second live
  (unjudged) attempt on the same component.
- `mmx-scan sim index --sim DIR` — regenerate `INDEX.json` (the only writer;
  never hand-edited) and check ledger integrity.
- `mmx-scan sim read --sim DIR` — proposer input: the index plus every open
  problem with all its attempts, in full. Closed problems come through the
  index only.
- `mmx-scan gate --sim DIR --metrics DIR --attempt A-<r>-<n> [--start DAY] [--end DAY] [--write]`
  — the composite gate as a calculation. Each of the three components
  (`owner_corrections_per_card`, `tokens_per_card`, `days_in_review`) is a
  z-score against the 14 days before adoption, weighted equally. Kept only if
  the after window has ≥ 10 cards (cap: 14 days), the composite improves beyond
  its bootstrap noise band, and no component regresses beyond its own band;
  `rejected` the moment a component is worse beyond its band; otherwise
  `inconclusive` (revert the edit from the snapshot, record the verdict, do
  not re-propose without new evidence). Overlapping edits: per-agent composite
  gains are reported alongside. `--write` stores the verdict file (immutable,
  once). `Claude Architect adopts when the gate passes; the Owner gets a
  native `ask` only when an edit changes the meaning of Owner directive text.
- `mmx-scan rounds next [--runs N | --last-round-date DAY --round-no K] [--reset]`
  — round 1 after 10 runs, rounds 2 and 3 one day later, round 4+ every 3 days;
  a model/executor change resets the sequence.
- `mmx-scan rounds arm --last-round-date DAY --round-no K [--issue CARD] [--reset]`
  — self-arming: prints (or with `--issue`, creates) the issue wakeup that
  starts the next round on the curator card. No new cron. At most 3 new edits
  per round, at most one live edit per component.

Seed problems: P1 no loop after a correction (M-604), P2 friction writing to
memory (M-605), P3 cards reach `in_review` on the artifact alone (rule
`mem_ca39eeae`).

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

Data (metrics + incumbent) lives in the **private** repo
`ddvnguyen/Knowledge_Documents`, branch `mmx-harness`, folder `mmx-harness/`
(Owner decision on M-608). `nightly` refuses a checkout on, or a push to,
`integration`/`master`/`main`/`stable`, and refuses to push to a non-private
origin. The curator autopilot runs it daily:

```sh
multica repo checkout https://github.com/ddvnguyen/Knowledge_Documents --ref mmx-harness
/mnt/workspace/bin/mmx-scan nightly --repo <checkout> --push mmx-harness
```

Rollback: pause the autopilot (`multica autopilot update <id> --status paused`).
