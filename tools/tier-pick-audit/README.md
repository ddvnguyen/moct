# tier-pick-audit

M-588 B4. One read-only pass that measures whether the tier-pick inputs exist:
`important_level` / `complexity` on issues, and the tier quality/cost config the
M-423 resolver needs. No LLM, no DB, no writes to the board.

```
tier-pick-audit [--date YYYY-MM-DD] [--out-dir DIR] [--stdout]
                [--fixture captured.json] [--cli /path/to/multica] [--dry-run]
```

Default day: today's UTC date. Output (deterministic, like the M-577 scorecard):

- `/mnt/workspace/tier-pick-audit/tier-pick-audit-<YYYY-MM-DD>.json` — full report
- `/mnt/workspace/tier-pick-audit/tier-pick-audit-<YYYY-MM-DD>.md` — the tables
- the markdown on stdout (`--stdout` prints the JSON instead)

Two runs over the same board and `--date` produce byte-identical JSON: no
timestamps other than the window label, cards sorted by identifier, keys sorted.

## What it reports

| Section | Content |
| --- | --- |
| `coverage` | issues with both / important only / complexity only / neither, overall, by status and by ISO creation week |
| `value_distribution` | the values that actually exist (1..5), for each field |
| `resolver_floor` | the required quality floor today (missing → 1/1) and with difficulty fabricated to 3/3 and 5/5, for a deterministic 20-card cross-section |
| `unavailable` | parts with no CLI read path, with the missing field named — never estimated |
| `proposal` | the three options for new cards and a recommendation, not applied |
| `backfill` | `--dry-run` only: which open/new cards would get values, and what |

## Read path (same as the M-577 scorecard)

The scorecard reads every number through the `multica` CLI; it never touches the
database. This tool does the same:

| Fact | Command | Field |
| --- | --- | --- |
| issues, status, created_at, priority, labels, description | `multica issue list --resolve-properties --output json` (paged at 100) | `issues[]` |
| difficulty values | same call | `properties[]` where `name` is `important_level` / `complexity` |
| property ids / usage counts | `multica property list --output json` | `id`, `usage_count` |
| agent role | `multica agent list --output json` | `tier_role` |

If the CLI cannot answer a question, the report says so in `unavailable[]`.
There is **no CLI command for model tiers**, so tier quality/cost, role links,
`manual_only`, online runtime and models without a quality entry are reported
as unavailable and the work stops on those parts, as the brief requires.

## Resolver floor

The floor is copied from `multica-x`
`server/internal/service/tier_resolve.go:93,196-203`:

```
required = lo + ceil((hi - lo) * (important + complexity - 2) / 8)
bands = architect {72,75}, management {65,72}, engineer {50,65}
        (legacy leader/reviewer/orchestrator -> management, planning -> architect)
```

Missing or invalid values are read as 1/1 by the resolver, so today the floor
never rises above a band's low end. The concrete tier that satisfies a floor
cannot be named without the tier rows (no CLI read path); only the floor is
reported.

## Proposal (not applied)

The only writer of the difficulty fields today is the plan-approve default.
Cards created without planning get no value. Options compared in the report:

1. required field at card creation / planning template;
2. a deterministic script derived from card facts (rules written down, no LLM);
3. leave unset = 1/1.

The report recommends (2): it covers the unplanned cards that are the actual
gap, doubles as the backfill tool, and keeps the LLM out. (1) is a later
complement if a creation template ships; (3) leaves the resolver inert.

## Backfill dry-run

```
tier-pick-audit --dry-run --date 2026-11-26 --stdout
```

Closed statuses (`in_review`, `done`, `cancelled`) are excluded. For the rest,
`rules` in the report show the deterministic derivation; `would_set` is a
proposal only. `--dry-run` performs **no writes** and never contacts production.
PR diff size and previous failed runs are listed as deferred signals because
they need one extra CLI read per card; they are not used in the dry-run.

Production data changes and product code changes are a separate card, cut by
the Leader after reading the report.

## Test

```
bash tools/tier-pick-audit/tier-pick-audit.test.sh
pnpm test
```

The bash test replays a small seeded fixture through the same `build_report`
the live run uses and asserts coverage, distribution, the exact resolver floors,
the unavailable parts, the recommendation, the dry-run proposal, determinism,
and that the source is read-only. `tests/unit/tier-pick-audit.test.ts` runs it
inside `pnpm test`, so CI covers it without a workflow change.

# tier-difficulty

M-598. The audit's recommendation (ii): a deterministic script that derives
`important_level` / `complexity` from card facts — no LLM. The plan-approve
default keeps writing planned cards; this tool covers the unplanned ones and
doubles as the backfill.

```
tier-difficulty [--dry-run] [--apply] [--unset] [--with-runs] [--with-prs]
                [--ledger PATH] [--fixture captured.json] [--cli PATH]
                [--out-dir DIR] [--stdout]
```

`--dry-run` is the default: prints the before/after table, writes nothing.

## Derivation rules

Inputs come only from `multica issue ... --output json`: the one
`issue list --resolve-properties` pass (id, properties, status, priority,
labels, description, parent/children via `parent_issue_id`), plus — only with
`--with-runs` / `--with-prs` — one `issue runs` / `issue pull-requests` call
per card. No LLM, no DB, no other read path.

| # | Rule | Live-board justification (591 cards, 2026-11-26) |
| --- | --- | --- |
| I1 | `important` starts at 1 | base: most cards are ordinary small cards, floor stays at the band low end |
| I2 | +1 when priority is high or urgent | 21 of 56 open cards are high; priority is the planner's own importance vote |
| I3 | +1 when a label is in {deploy, production, security, owner-gate, incident} | labels are empty on this board today, so the rule is inert until labeling starts; kept because a deploy/security card mis-routed to the cheapest tier is the failure the floor exists to prevent |
| I4 | +1 when the card parents >=3 non-closed children | 10 of 56 open cards are epic parents (M-31 has 14 kids); coordinating real sub-work is importance, not verbosity |
| I5 | derived `important` clamps to 1..3; 4/5 are human-only | M-595 G7: management 3/3 already floors at 69, one step below the cost-100 single-slot `claude-sonnet-5-5` (72); 4+ would push ordinary cards onto it |
| C1 | `complexity` starts at 1 | base, same as above |
| C2 | +1 for description >= 1500 chars | open-card p50 is 1827 chars: a longer-than-typical writeup is the best cheap complexity proxy on a board with no labels and no PR links |
| C3 | +1 more for description >= 4000 chars (cumulative) | p90 is 4875; only 8 of 56 open cards reach this — sustained specification, not chatter |
| C4 | +1 when failed runs >= 3 (needs `--with-runs`) | M-31 has 27 failed runs, M-82 has 4, M-562 has 2: repeated failure is observed difficulty, and the default pass deliberately skips the per-card call |
| C5 | +1 when an open linked PR exists (needs `--with-prs`) | a linked PR means implementation started and came back for rework; PR links are empty board-wide today, so the rule is inert-but-cheap until linking starts |
| C6 | derived `complexity` clamps to 1..4; 5 is human-only | only 5/5 reaches past the management band top onto the single-slot tiers; nothing derived may claim it |
| H | a field holding a valid 2..5 the script did not set is human-owned and never overwritten | the plan-approve default and human judgment outrank the heuristic; re-derive also yields to a human edit over a script-set value |

Resulting live distribution (56 open cards, default pass without
per-card reads): 24x1/1, 15x2/2, 7x1/2, 4x1/3, 4x2/3, 2x2/1 — max 2/3,
so no ordinary small card rises above 3/3 and the G7 route stays unreachable
by derivation. The audit's sketch proposed the same shape (23x1/1, 14x2/2, 7x1/2).

## Apply / rollback

```
tier-difficulty --apply                      # write derived values
tier-difficulty --unset                      # rollback every ledger entry
```

`--apply` touches open/new cards only
(`backlog|todo|planing_2|in_progress|blocked|wait_for_decision`;
`agent_review_deploy` is excluded — a card awaiting deploy keeps the floor it
was reviewed at) through `multica issue property set` on the two existing
property definitions (`important_level`, `complexity`). It is idempotent: a
re-run whose derivation matches the current value writes nothing, and a human
edit over a script-set value is treated as an override and left alone.

Every write is appended to a ledger file (default
`tools/tier-pick-audit/tier-difficulty.ledger.json`, overridable with
`--ledger`) as `{issue_id, identifier, field, previous (null = was unset),
set, at}`. `--unset` restores each entry to its `previous` value (`property
unset` when it was unset) and clears the ledger, so rollback is exact.
**Do not run `--apply` on the live board without the Leader's go-ahead.**

## Hook point proposal (not wired)

The Orchestrator tick should call this so every card entering `todo` has values
before it is assigned: in `tools/orch-sweep/orch-sweep`, right after the
`build_role_pilot` call (the pilot already reads per-card runs there), add a
`--apply`-scoped pass limited to cards with status `todo` and no difficulty
values, before the assignment/routing step. Scope it to `todo`-entering cards
only — not a full-board sweep — so the per-tick cost is one `issue list` pass
plus zero extra calls in the default mode. Wiring is a separate card; this
proposal is deliberately not implemented here.

## Test

```
bash tools/tier-pick-audit/tier-difficulty.test.sh
pnpm test
```

The bash test replays a seeded fixture (one card per rule, plus a human-owned
4/2, a closed card, and a closed child that must not count toward the epic
rule) and asserts each derivation, the clamps, `skip-human` / `skip-closed`
actions, determinism, dry-run purity (no ledger created), apply scoping,
idempotence, human-override survival, and rollback restoring the exact prior
state. `tests/unit/tier-difficulty.test.ts` runs it inside `pnpm test`.
