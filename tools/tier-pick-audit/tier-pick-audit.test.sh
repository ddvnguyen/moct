#!/usr/bin/env bash
# Seeded, offline checks for tier-pick-audit. No board access, no writes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/tier-pick-audit"
TMP="$HERE/.test-tmp-audit"
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/fixture.json" <<'JSON'
{
  "properties": [
    {"id": "7e658f74-062c-44ae-9fc6-1b9a29699a24", "name": "complexity", "type": "number", "archived": false, "usage_count": 2},
    {"id": "73ac50cc-eeaf-4075-bdc1-3d1b60f68b6f", "name": "important_level", "type": "number", "archived": false, "usage_count": 2}
  ],
  "agents": [
    {"id": "agent-e", "name": "[Test] Engineer Role", "subtype": "role", "tier_role": "engineer"}
  ],
  "issues": [
    {
      "id": "id-a", "identifier": "M-A", "status": "in_review", "priority": "medium",
      "created_at": "2026-11-20T10:00:00Z", "description": "short", "labels": [],
      "assignee_id": "agent-e",
      "properties": [
        {"name": "important_level", "value": 1},
        {"name": "complexity", "value": 1}
      ]
    },
    {
      "id": "id-b", "identifier": "M-B", "status": "in_progress", "priority": "high",
      "created_at": "2026-11-21T10:00:00Z", "description": "short", "labels": ["refactor"],
      "assignee_id": "agent-e",
      "properties": [{"name": "important_level", "value": 3}]
    },
    {
      "id": "id-c", "identifier": "M-C", "status": "todo", "priority": "low",
      "created_at": "2026-11-14T10:00:00Z", "description": "short", "labels": [],
      "assignee_id": null,
      "properties": [{"name": "complexity", "value": 2}]
    },
    {
      "id": "id-d", "identifier": "M-D", "status": "todo", "priority": "high",
      "created_at": "2026-11-22T10:00:00Z", "description": "short", "labels": ["deploy"],
      "assignee_id": null,
      "properties": []
    },
    {
      "id": "id-e", "identifier": "M-E", "status": "done", "priority": "low",
      "created_at": "2026-10-30T10:00:00Z", "description": "short", "labels": [],
      "assignee_id": null,
      "properties": []
    }
  ]
}
JSON

python3 "$TOOL" --fixture "$TMP/fixture.json" --date 2026-11-26 \
  --out-dir "$TMP/out" --stdout > "$TMP/report.json"
python3 "$TOOL" --fixture "$TMP/fixture.json" --date 2026-11-26 \
  --out-dir "$TMP/out" --stdout --dry-run > "$TMP/report-dry.json"

jq -e '.scope.total_issues == 5' "$TMP/report.json" > /dev/null
jq -e '.coverage.counts.both == 1 and .coverage.counts.important_only == 1 and .coverage.counts.complexity_only == 1 and .coverage.counts.neither == 2' "$TMP/report.json" > /dev/null
jq -e '.coverage.by_status.todo.both == 0 and .coverage.by_status.todo.neither == 1' "$TMP/report.json" > /dev/null
jq -e '.coverage.by_status.in_review.both == 1' "$TMP/report.json" > /dev/null
jq -e '.coverage.by_creation_week["2026-W47"].both == 1' "$TMP/report.json" > /dev/null
jq -e '.value_distribution.important_level.set_count == 2 and .value_distribution.important_level.values["3"] == 1' "$TMP/report.json" > /dev/null
jq -e '.value_distribution.complexity.values["2"] == 1' "$TMP/report.json" > /dev/null
jq -e '.scope.property_ids.important_level.usage_count == 2' "$TMP/report.json" > /dev/null

# Exact requiredTierQuality values, mirroring tier_resolve.go.
jq -e '.resolver_floor.scenarios.today.pilot_floors == {"engineer":50,"management":65,"architect":72}' "$TMP/report.json" > /dev/null
jq -e '.resolver_floor.scenarios.fabricated_3.pilot_floors == {"engineer":58,"management":69,"architect":74}' "$TMP/report.json" > /dev/null
jq -e '.resolver_floor.scenarios.fabricated_5.pilot_floors == {"engineer":65,"management":72,"architect":75}' "$TMP/report.json" > /dev/null
jq -e '.resolver_floor.scenarios.today.floor_by_role.reviewer == 65' "$TMP/report.json" > /dev/null
jq -e '.resolver_floor.sample | length == 5' "$TMP/report.json" > /dev/null
jq -e '.resolver_floor.sample[] | select(.identifier == "M-A") | .today.agent_role_floor == 50' "$TMP/report.json" > /dev/null
jq -e '.resolver_floor.sample[] | select(.identifier == "M-A") | .concrete_tier == null' "$TMP/report.json" > /dev/null

# The tier parts are explicitly stopped, not invented.
jq -e '[.unavailable[].metric] | index("tier_quality_and_cost") != null' "$TMP/report.json" > /dev/null
jq -e '[.unavailable[].metric] | index("concrete_tier_pick") != null' "$TMP/report.json" > /dev/null
jq -e '[.unavailable[].metric] | index("tier_models_without_quality") != null' "$TMP/report.json" > /dev/null

# Proposal recommends the deterministic script, not an LLM and not leave-unset.
jq -e '.proposal.recommendation == "ii"' "$TMP/report.json" > /dev/null
jq -e '[.proposal.options[].id] | sort == ["i","ii","iii"]' "$TMP/report.json" > /dev/null

# Dry-run is a plan only: 3 open cards, 2 closed excluded, no writes.
jq -e '.backfill.mode == "dry-run" and .backfill.writes_performed == false' "$TMP/report-dry.json" > /dev/null
jq -e '.backfill.eligible_count == 3 and .backfill.excluded_closed_count == 2' "$TMP/report-dry.json" > /dev/null
jq -e '.backfill.plan[] | select(.identifier == "M-B") | .would_set == {"important_level":2,"complexity":2}' "$TMP/report-dry.json" > /dev/null
jq -e '.backfill.plan[] | select(.identifier == "M-D") | .would_set == {"important_level":3,"complexity":1}' "$TMP/report-dry.json" > /dev/null
jq -e '.backfill.plan[] | select(.identifier == "M-C") | .would_set == {"important_level":1,"complexity":1}' "$TMP/report-dry.json" > /dev/null

# Determinism: a second pass is byte-identical.
python3 "$TOOL" --fixture "$TMP/fixture.json" --date 2026-11-26 \
  --out-dir "$TMP/out2" --stdout > "$TMP/report-again.json"
cmp -s "$TMP/report.json" "$TMP/report-again.json"

# Without --dry-run the backfill section is explicitly not requested.
jq -e '.backfill.mode == "not-requested" and (.backfill | has("plan") | not)' "$TMP/report.json" > /dev/null

echo "all tier-pick-audit checks passed"
