# dogfood-scorecard

M-577 (M-574 A1). One read-only command, run once a day, that writes a
deterministic report over a fixed card set. The week of files it produces is the
baseline every later M-574 slice is compared against.

```
dogfood-scorecard [--date YYYY-MM-DD | --since RFC3339 [--until RFC3339]]
                  [--cards cards.json] [--out-dir DIR] [--stdout] [--by-arm]
                  [--fixture captured.json] [--cli /path/to/multica]
```

Default window: today's UTC day. `--since` without `--until` means a 1-day
window; a window longer than 31 days is rejected (one `run-messages` call per
run).

Output:

- `/mnt/workspace/dogfood-scorecard/scorecard-<YYYY-MM-DD>.json` — full report
- `/mnt/workspace/dogfood-scorecard/scorecard-<YYYY-MM-DD>.md` — short table
- the markdown table on stdout (`--stdout` prints the JSON instead)

Two runs over the same window produce byte-identical JSON: no timestamps other
than the window, cards sorted by identifier, keys sorted.

## By arm (M-588 B1b)

`--by-arm` adds an `Arm` column per card, a `by_arm` block, and a
`## By arm` table. Without the flag the output is exactly what it was
before, byte for byte.

The arm comes from card metadata `role_pilot` (written once by
`orch-sweep`): `{arm, pct, bucket, reason, at}`. Three groups:

| Group | Definition |
| --- | --- |
| `role` | `arm == "role"` — routed to the Engineer Role, reviewed by the Management Role |
| `named (control)` | `arm == "named"` with `bucket >= pct` |
| `named (fallback: intended role)` | `arm == "named"`, `bucket < pct`, and a `reason` — hashed into the role arm but failed closed |
| `pre-pilot` | no `role_pilot` metadata on the card |

The fallback label is a count and a label on the existing `named` group, not a
fourth group: intent-to-treat stays visible while the routing comparison stays
honest. A card with no arm is `pre-pilot`, never `named` — an unarmed card was
not part of the pilot.

Per group: cards, runs, failed, turns, turns/card, tokens in/out, owner→run
median, cost ticks (lifetime), `control` and `fallback` counts.

**Turns** are assistant blocks (`type` in `tool_use` | `text`) in
`run-messages`, summed per card. The transcript carries no turn id, so this is
a reproducible floor, not a model-turn count; the `by_arm.definition` block
says so in the report itself.

## Card set

`cards.json` is checked in and human-editable:

```json
{ "version": 1, "cards": [{ "identifier": "M-576", "note": "..." }] }
```

Identifiers resolve through `multica issue get <key>`, so the file holds no
UUIDs. Keep the set stable: changing it changes the baseline.

## Metric sources

Every number is read through the `multica` CLI. Nothing touches the database,
the board, comments or status. No metric is estimated or priced locally.

| Metric | Command | Field |
| --- | --- | --- |
| runs per card; completed / failed / blocked / cancelled / open | `multica issue runs <card> --output json` | `status` |
| retried runs | same | `attempt > 1` |
| runs after a failed hand-off | same | `trigger_evidence_kind == "delegated_failure"` |
| tokens in / out / cache read / cache write, models | same | `usage[]` → `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `model` |
| MOCT inject size (tokens per run) | same | `result.init_context.parts[]` where `part == "memory"` → `tokens` |
| on-demand memory-tool calls | `multica issue run-messages <run> --issue <card> --output json` | rows `type == "tool_use"` and `tool` in `memory_search` \| `memory_get` \| `memory_note` (same matcher as `server/internal/handler/moct_memory_tools.go:15`) |
| owner answer → next run latency | `multica issue comment list <card>` and `multica question list <card>` × `runs[].started_at` | member `created_at` / `answered_at` (`answered_by_type == "member"`), delta to the first run starting after the event |
| active agents, role vs named | distinct `runs[].agent_id` + `multica agent list --output json` | `subtype` (`role` \| `agent`) |
| cost (lifetime) | `multica issue usage <card> --output json` | `cost_usd_ticks`, `metered_task_count`, `task_count`, `unreported_task_count` |

A run with no `result.init_context` (failed, blocked, or never reported) is
counted in `memory_inject.runs_without_report` — never as zero memory. Runs
outside the window are excluded from every per-card number, but they are still
used to find the "next run" for latency.

## Unavailable (named, not invented)

The report's `unavailable[]` carries the missing field for each gap:

- **`cost_per_card_window`** — missing `runs[].usage[].cost_usd_ticks`. The runs
  API drops the per-row `task_usage.cost_usd_ticks` column that exists in the
  database (`server/pkg/db/generated/models.go:2189`), and `multica issue usage`
  is card-lifetime only. The report therefore carries `cost.scope:
  "card-lifetime"`; it does not price tokens from a local rate table.
- **`active_agents_workspace`** — missing a workspace-wide runs listing. The
  active-agent count is scoped to the fixed card set.

Fixing the first gap is a one-line change in `multica-x` (include
`cost_usd_ticks` in the runs `usage[]` payload); it is out of scope for this
`moct`-only card.

## Test

```
bash tools/dogfood-scorecard/dogfood-scorecard.test.sh   # seeded, offline
pnpm test                                                # CI gate (vitest wrapper)
```

The bash test replays a synthetic fixture through the same `build_report` the
live run uses and asserts run counts, token sums, memory-inject extraction,
memory-tool counting, latency pairing, the role/named split, the `--by-arm`
groups (role / named control / named fallback / pre-pilot, turns, and the
default output staying arm-free), byte-identical output on a second pass, and
the window rules. `tests/unit/dogfood-scorecard.test.ts` runs it inside
`pnpm test`, so CI covers it without a workflow change.

## Deploy and daily run

Install beside `orch-sweep`:

```
cp tools/dogfood-scorecard/dogfood-scorecard /mnt/workspace/bin/
```

Schedule the daily run from the Orchestrator tick (`orch-sweep`), guarded so it
runs at most once per UTC day:

```
[ -f /mnt/workspace/dogfood-scorecard/scorecard-$(date -u +%F).json ] \
  || /mnt/workspace/bin/dogfood-scorecard
```

It prints one table line set and exits 0; it never posts comments. To stop it,
remove that line from the tick — nothing else reads the directory. Deleting
`tools/dogfood-scorecard/` and `tests/unit/dogfood-scorecard.test.ts` is a full
rollback (no other code imports the tool).

After 7 daily files exist, one summary comment goes on M-574 (numbers, gaps) and
the card moves to `in_review`.
