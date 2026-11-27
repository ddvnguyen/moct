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
- `mmx-scan.test.py` — seeded checks for the detection rules
  (`python3 -I tools/mmx-scan/mmx-scan.test.py`).

Detection rules and their known blind spots are in the script docstring.
Baseline to beat (M-571, 2026-11-25..27): 1/429 completed runs loaded `mmx`.

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

Rollback: pause the autopilot (`multica autopilot update <id> --status paused`).
