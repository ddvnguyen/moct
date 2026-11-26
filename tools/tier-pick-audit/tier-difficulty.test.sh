#!/usr/bin/env bash
# Seeded, offline checks for tier-difficulty (M-598). No board access, no writes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$HERE/tier-difficulty"
TMP="$HERE/.test-tmp-difficulty"
rm -rf "$TMP"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

LONG1500="$(printf 'x%.0s' $(seq 1 1600))"
LONG4000="$(printf 'y%.0s' $(seq 1 4100))"

# jq --arg slurps a shell var into JSON safely.
jq -n --arg l1 "$LONG1500" --arg l2 "$LONG4000" '{
  issues: [
    # R-P: priority + risk label -> important 3 (clamp holds at 3).
    {id: "p", identifier: "M-P", status: "todo", priority: "high",
     created_at: "2026-11-20T00:00:00Z", description: "short",
     labels: ["deploy"], parent_issue_id: null, assignee_id: null, properties: []},
    # R-D1: 1600 chars -> complexity 2.
    {id: "d1", identifier: "M-D1", status: "backlog", priority: "low",
     created_at: "2026-11-20T00:00:00Z", description: $l1,
     labels: [], parent_issue_id: null, assignee_id: null, properties: []},
    # R-D2: 4100 chars -> complexity 3 (cumulative 1500 + 4000 rules).
    {id: "d2", identifier: "M-D2", status: "todo", priority: "low",
     created_at: "2026-11-20T00:00:00Z", description: $l2,
     labels: [], parent_issue_id: null, assignee_id: null, properties: []},
    # R-F: 3 failed runs -> complexity +1 on top of long desc = 3.
    {id: "f", identifier: "M-F", status: "in_progress", priority: "low",
     created_at: "2026-11-20T00:00:00Z", description: $l1,
     labels: [], parent_issue_id: null, assignee_id: null, properties: []},
    # R-PR: open linked PR -> complexity +1.
    {id: "r", identifier: "M-R", status: "todo", priority: "low",
     created_at: "2026-11-20T00:00:00Z", description: "short",
     labels: [], parent_issue_id: null, assignee_id: null, properties: []},
    # R-H: human-set 4/2 -> untouched (skip-human).
    {id: "h", identifier: "M-H", status: "todo", priority: "high",
     created_at: "2026-11-20T00:00:00Z", description: $l2,
     labels: ["deploy"], parent_issue_id: null, assignee_id: null,
     properties: [{name: "important_level", value: 4}, {name: "complexity", value: 2}]},
    # R-E: epic parent of 3 open kids -> important 2.
    {id: "e", identifier: "M-E", status: "todo", priority: "low",
     created_at: "2026-11-20T00:00:00Z", description: "short",
     labels: [], parent_issue_id: null, assignee_id: null, properties: []},
    {id: "c1", identifier: "M-C1", status: "todo", priority: "low",
     created_at: "2026-11-20T00:00:00Z", description: "short",
     labels: [], parent_issue_id: "e", assignee_id: null, properties: []},
    {id: "c2", identifier: "M-C2", status: "todo", priority: "low",
     created_at: "2026-11-20T00:00:00Z", description: "short",
     labels: [], parent_issue_id: "e", assignee_id: null, properties: []},
    {id: "c3", identifier: "M-C3", status: "todo", priority: "low",
     created_at: "2026-11-20T00:00:00Z", description: "short",
     labels: [], parent_issue_id: "e", assignee_id: null, properties: []},
    # R-X: closed child does not count toward the epic (c4 is done).
    {id: "c4", identifier: "M-C4", status: "done", priority: "low",
     created_at: "2026-11-20T00:00:00Z", description: "short",
     labels: [], parent_issue_id: "e", assignee_id: null, properties: []},
    # R-C: closed card -> skip-closed, never written.
    {id: "x", identifier: "M-X", status: "in_review", priority: "high",
     created_at: "2026-11-20T00:00:00Z", description: $l2,
     labels: ["deploy"], parent_issue_id: null, assignee_id: null, properties: []}
  ],
  runs: {
    f: [{status: "completed"}, {status: "failed"}, {status: "failed"}, {status: "failed"}],
    r: [{status: "completed"}]
  },
  pull_requests: {
    r: {pull_requests: [{state: "open"}]},
    f: {pull_requests: [{state: "merged"}]}
  }
}' > "$TMP/fixture.json"

LEDGER="$TMP/ledger.json"

# --- dry-run: derivation rules ---
python3 "$TOOL" --fixture "$TMP/fixture.json" --ledger "$LEDGER" \
  --with-runs --with-prs --stdout > "$TMP/dry.json"

jq -e '.mode == "dry-run"' "$TMP/dry.json" > /dev/null
jq -e '.scope.in_scope == 10 and .scope.out_of_scope == 2' "$TMP/dry.json" > /dev/null
# each rule's seeded card
jq -e '.cards[] | select(.identifier=="M-P") | .derived == {"important_level":3,"complexity":1}' "$TMP/dry.json" > /dev/null
jq -e '.cards[] | select(.identifier=="M-D1") | .derived == {"important_level":1,"complexity":2}' "$TMP/dry.json" > /dev/null
jq -e '.cards[] | select(.identifier=="M-D2") | .derived == {"important_level":1,"complexity":3}' "$TMP/dry.json" > /dev/null
jq -e '.cards[] | select(.identifier=="M-F") | .derived == {"important_level":1,"complexity":3}' "$TMP/dry.json" > /dev/null
jq -e '.cards[] | select(.identifier=="M-R") | .derived == {"important_level":1,"complexity":2}' "$TMP/dry.json" > /dev/null
jq -e '.cards[] | select(.identifier=="M-E") | .derived == {"important_level":2,"complexity":1}' "$TMP/dry.json" > /dev/null
# human values are never overwritten, even when derivation disagrees
jq -e '.cards[] | select(.identifier=="M-H") | .actions == {"important_level":"skip-human","complexity":"skip-human"}' "$TMP/dry.json" > /dev/null
# closed cards are out of scope and never written
jq -e '.cards[] | select(.identifier=="M-X") | .actions == {"important_level":"skip-closed","complexity":"skip-closed"}' "$TMP/dry.json" > /dev/null
# without --with-runs / --with-prs the expensive signals stay unevaluated
python3 "$TOOL" --fixture "$TMP/fixture.json" --ledger "$LEDGER" --stdout > "$TMP/dry-base.json"
jq -e '.cards[] | select(.identifier=="M-F") | .derived == {"important_level":1,"complexity":2}' "$TMP/dry-base.json" > /dev/null
jq -e '.cards[] | select(.identifier=="M-R") | .derived == {"important_level":1,"complexity":1}' "$TMP/dry-base.json" > /dev/null
# determinism: a second pass is byte-identical
python3 "$TOOL" --fixture "$TMP/fixture.json" --ledger "$LEDGER" \
  --with-runs --with-prs --stdout > "$TMP/dry-again.json"
cmp -s "$TMP/dry.json" "$TMP/dry-again.json"
# dry-run writes nothing: no ledger file created
test ! -e "$LEDGER"

# --- apply: writes only set-actions, ledger records prior state ---
python3 "$TOOL" --fixture "$TMP/fixture.json" --ledger "$LEDGER" \
  --with-runs --with-prs --apply --stdout > "$TMP/applied.json"
jq -e '.mode == "apply" and (.errors | length == 0)' "$TMP/applied.json" > /dev/null
# M-H (human) and M-X (closed) got no writes
jq -e '[.applied[] | select(.card=="M-H" or .card=="M-X")] | length == 0' "$TMP/applied.json" > /dev/null
# ledger recorded the prior state (all unset -> previous null)
jq -e '[.entries[]] | length == 18' "$LEDGER" > /dev/null
jq -e '[.entries[] | select(.previous != null)] | length == 0' "$LEDGER" > /dev/null
# the apply pass re-plans post-write: everything written reads back skip-same
jq -e '[.cards[] | select(.identifier=="M-P") | .actions] == [{"important_level":"skip-same","complexity":"skip-same"}]' "$TMP/applied.json" > /dev/null
jq -e '.cards[] | select(.identifier=="M-H") | .actions == {"important_level":"skip-human","complexity":"skip-human"}' "$TMP/applied.json" > /dev/null

# --- idempotence: the ledger survives and a re-plan writes nothing new ---
# (each CLI call reloads the fixture, so replay the writes into a state file
# and plan against it: only the human-touched card differs from derived.)
jq -e '[.entries[]] | length == 18' "$LEDGER" > /dev/null
python3 - "$TMP/fixture.json" "$LEDGER" "$TMP/state.json" <<'PYEOF'
import json, sys
fixture_path, ledger_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
fixture = json.load(open(fixture_path))
ledger = json.load(open(ledger_path))
by_id = {i["id"]: i for i in fixture["issues"]}
for entry in ledger["entries"]:
    issue = by_id[entry["issue_id"]]
    rows = issue.setdefault("properties", [])
    lname = entry["field"]
    for row in rows:
        if row.get("name") == lname:
            row["value"] = entry["set"]
            break
    else:
        rows.append({"name": lname, "value": entry["set"]})
# a human overrides the script's M-P complexity after the apply
for row in by_id["p"]["properties"]:
    if row.get("name") == "complexity":
        row["value"] = 2
json.dump(fixture, open(out_path, "w"))
PYEOF
python3 "$TOOL" --fixture "$TMP/state.json" --ledger "$LEDGER" \
  --with-runs --with-prs --stdout > "$TMP/replan.json"
# human override (M-P complexity 2) wins over re-derive: no write planned
jq -e '.cards[] | select(.identifier=="M-P") | .actions == {"important_level":"skip-same","complexity":"skip-human"}' "$TMP/replan.json" > /dev/null
# everything else already matches: skip-same or skip-human
jq -e '[.cards[] | select(.in_scope) | .actions[]] | map(select(. == "set")) | length == 0' "$TMP/replan.json" > /dev/null

# --- rollback: exact prior state restored, ledger cleared ---
python3 "$TOOL" --fixture "$TMP/state.json" --ledger "$LEDGER" \
  --unset > "$TMP/unset.txt"
grep -q "restored 18 values" "$TMP/unset.txt"
jq -e '[.entries[]] | length == 0' "$LEDGER" > /dev/null
# the unset pass recorded the writes it performed against the state file
python3 - "$TMP/unset.txt" <<'PYEOF'
import sys
text = open(sys.argv[1]).read()
assert "ERROR" not in text, text
PYEOF

echo "all tier-difficulty checks passed"
