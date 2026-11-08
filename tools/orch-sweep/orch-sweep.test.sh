#!/usr/bin/env bash
# orch-sweep.test.sh — M-268 seeded verification for --stuck-list mode.
# No network, no board: feeds synthetic boards into build_stuck_list and
# asserts the four triggers, the verdict amendment (driven cards excluded),
# and hash stability (same board twice -> same hash; age drift -> same hash).
set -euo pipefail
cd "$(dirname "$0")"
check() { # check <name> <payload-json>
  local name="$1" payload="$2"
  if python3 - "$name" "$payload" <<'EOF'; then
import importlib.machinery, importlib.util, json, sys
path = "./orch-sweep"
loader = importlib.machinery.SourceFileLoader("s", path)
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
name, payload = sys.argv[1], json.loads(sys.argv[2])
board, issues, resume = payload["board"], payload.get("issues", []), payload.get("resume", {})
r = s.build_stuck_list(board, issues, s.now(), resume)
trig = sorted(i["trigger"] for i in r["items"])
ok, detail = True, ""
case = name
if case == "a-fires":
    ok = any(i["trigger"] == "no-verdict" and i["card"] == "M-2" for i in r["items"])
    detail = json.dumps(r["items"])
elif case == "a-excludes-live-run":
    ok = r["items"] == []
    detail = json.dumps(r["items"])
elif case == "a-excludes-pending-wakeup":
    ok = r["items"] == []
    detail = json.dumps(r["items"])
elif case == "a-excludes-red-checks":
    ok = r["items"] == []
    detail = json.dumps(r["items"])
elif case == "a-excludes-verdict":
    ok = r["items"] == []
    detail = json.dumps(r["items"])
elif case == "b-fires":
    ok = any(i["trigger"] == "idle-after-resume" and i["card"] == "M-1" for i in r["items"])
    detail = json.dumps(r["items"])
elif case == "b-no-resume-count":
    ok = r["items"] == []
    detail = json.dumps(r["items"])
elif case == "c-fires":
    ok = any(i["trigger"] == "blocked" and i["card"] == "M-9" for i in r["items"])
    detail = json.dumps(r["items"])
elif case == "d-fires":
    ok = any(i["trigger"].startswith("shared:") for i in r["items"]) and len(r["items"]) == 3
    detail = json.dumps(r["items"])
elif case == "hash-stable":
    r2 = s.build_stuck_list(board, issues, s.now(), resume)
    ok = r["hash"] == r2["hash"] and len(r["hash"]) == 12
    detail = r["hash"]
elif case == "hash-ignores-age":
    import copy
    b2 = copy.deepcopy(board)
    for b in b2: b["activity_minutes"] = (b.get("activity_minutes") or 0) + 5.0
    r2 = s.build_stuck_list(b2, issues, s.now(), resume)
    ok = r["hash"] == r2["hash"]
    detail = r["hash"] + " vs " + r2["hash"]
else:
    ok, detail = False, "unknown case " + case
print(("PASS " if ok else "FAIL ") + case + " :: " + detail)
sys.exit(0 if ok else 1)
EOF
    npass=$((npass+1)); echo "ok - $name"
  else
    nfail=$((nfail+1)); echo "not ok - $name"
  fi
}

GREEN_PR='{"repo":"r","n":1,"state":"OPEN","head":"abc","verdict_on_head":null,"checks":{"total":2,"failing":[]},"updated_at":"2020-01-01T00:00:00Z"}'
mkboard() { # mkboard <json-board> <json-issues> <json-resume>
  python3 -c "import json,sys; print(json.dumps({'board':json.loads(sys.argv[1]),'issues':json.loads(sys.argv[2]),'resume':json.loads(sys.argv[3])}))" "$1" "$2" "$3"
}

echo "TAP version 13"
echo "1..11"
npass=0; nfail=0
check "a-fires"              "$(mkboard "[{\"card\":\"M-2\",\"activity_minutes\":10,\"active_run\":false,\"wakeup_pending\":false,\"prs\":[$GREEN_PR],\"failure_class\":null,\"reason\":\"fresh\"}]" "[]" "{}")"
check "a-excludes-live-run"  "$(mkboard "[{\"card\":\"M-2\",\"activity_minutes\":10,\"active_run\":true,\"wakeup_pending\":false,\"prs\":[$GREEN_PR],\"failure_class\":null,\"reason\":\"run-live\"}]" "[]" "{}")"
check "a-excludes-pending-wakeup" "$(mkboard "[{\"card\":\"M-2\",\"activity_minutes\":10,\"active_run\":false,\"wakeup_pending\":true,\"prs\":[$GREEN_PR],\"failure_class\":null,\"reason\":\"live-wakeup\"}]" "[]" "{}")"
check "a-excludes-red-checks" "$(mkboard "[{\"card\":\"M-2\",\"activity_minutes\":10,\"active_run\":false,\"wakeup_pending\":false,\"prs\":[{\"repo\":\"r\",\"n\":1,\"state\":\"OPEN\",\"head\":\"abc\",\"verdict_on_head\":null,\"checks\":{\"total\":2,\"failing\":[\"ci\"]},\"updated_at\":\"2020-01-01T00:00:00Z\"}],\"failure_class\":null,\"reason\":\"fresh\"}]" "[]" "{}")"
check "a-excludes-verdict"   "$(mkboard "[{\"card\":\"M-2\",\"activity_minutes\":10,\"active_run\":false,\"wakeup_pending\":false,\"prs\":[{\"repo\":\"r\",\"n\":1,\"state\":\"OPEN\",\"head\":\"abc\",\"verdict_on_head\":\"APPROVED\",\"checks\":{\"total\":2,\"failing\":[]},\"updated_at\":\"2020-01-01T00:00:00Z\"}],\"failure_class\":null,\"reason\":\"fresh\"}]" "[]" "{}")"
check "b-fires"              "$(mkboard "[{\"card\":\"M-1\",\"activity_minutes\":130,\"active_run\":false,\"wakeup_pending\":false,\"prs\":[],\"failure_class\":null,\"reason\":\"idle\"}]" "[]" "{\"M-1\":{\"count\":1}}")"
check "b-no-resume-count"    "$(mkboard "[{\"card\":\"M-1\",\"activity_minutes\":130,\"active_run\":false,\"wakeup_pending\":false,\"prs\":[],\"failure_class\":null,\"reason\":\"idle\"}]" "[]" "{}")"
check "c-fires"              "$(mkboard "[]" "[{\"identifier\":\"M-9\",\"status\":\"blocked\",\"last_activity_at\":\"2020-01-01T00:00:00Z\"}]" "{}")"
check "d-fires"              "$(mkboard "[{\"card\":\"M-1\",\"activity_minutes\":5,\"active_run\":true,\"wakeup_pending\":true,\"prs\":[],\"failure_class\":\"unknown\",\"reason\":\"x\"},{\"card\":\"M-2\",\"activity_minutes\":5,\"active_run\":true,\"wakeup_pending\":true,\"prs\":[],\"failure_class\":\"unknown\",\"reason\":\"x\"},{\"card\":\"M-3\",\"activity_minutes\":5,\"active_run\":true,\"wakeup_pending\":true,\"prs\":[],\"failure_class\":\"unknown\",\"reason\":\"x\"}]" "[]" "{}")"
check "hash-stable"          "$(mkboard "[{\"card\":\"M-1\",\"activity_minutes\":130,\"active_run\":false,\"wakeup_pending\":false,\"prs\":[],\"failure_class\":null,\"reason\":\"idle\"}]" "[]" "{\"M-1\":{\"count\":1}}")"
check "hash-ignores-age"     "$(mkboard "[{\"card\":\"M-1\",\"activity_minutes\":130,\"active_run\":false,\"wakeup_pending\":false,\"prs\":[],\"failure_class\":null,\"reason\":\"idle-after-resume\"}]" "[]" "{\"M-1\":{\"count\":1}}")"

echo "# passed=$npass failed=$nfail"
[ "$nfail" -eq 0 ]
