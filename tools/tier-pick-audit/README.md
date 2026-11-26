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
