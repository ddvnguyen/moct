# orch-sweep

Deterministic board sweep for the Multica Orchestrator tick: one pass over the
live board (issues, runs, wakeups, PRs, quota ledger, committee seats, queues).

- `orch-sweep` — the script. Run with no flags for the full tick JSON;
  `--stuck-list` prints only the compact M-268 committee slice
  `{at, tool, mode, hash, triggers, items}`.
- `orch-sweep.test.sh` — seeded verification for the stuck-list mode
  (M-268 acceptance: fires once on a seeded case, silent on the same hash).

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

## Deploy

This repo copy is the source of truth. The tick runs the deployed copy at
`/mnt/workspace/bin/orch-sweep` — copy it there after review:

```sh
cp tools/orch-sweep/orch-sweep /mnt/workspace/bin/orch-sweep
```

Rollback for M-268: remove the trigger paragraph from the Orchestrator
instructions + tick autopilot; the committee stops because no wakeups arrive.
