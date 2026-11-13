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
echo "1..13"
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

# M-294: main() must print its result. The bug exited 0 with no output, so
# these cases stub the I/O fns, run main() in-process, and assert the stdout
# parses as JSON with the keys the Orchestrator tick reads. Exit code alone
# is not enough.
check_main() { # check_main <name> <extra-argv...>
  local name="$1"; shift
  if python3 - "$name" "$@" <<'EOF'; then
import contextlib, importlib.machinery, importlib.util, io, json, sys
path = "./orch-sweep"
loader = importlib.machinery.SourceFileLoader("s", path)
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
name, extra = sys.argv[1], sys.argv[2:]
# No network, no board: every I/O fn returns empty; sweep yields {} so the
# test asserts only main()'s contract (print valid JSON with tick keys),
# not sweep()'s content.
s.agent_names = lambda: {}
s.fetch_prs = lambda: []
s.read_ledger = lambda: ({"rows": []}, None)
s.fetch_issues = lambda: {"issues": [], "has_more": False}
s.fetch_queues = lambda t: {}
s.read_seats = lambda: None
s.baseline_resume = lambda: {}
s.sys.argv = ["orch-sweep"] + extra
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = s.main()
out = buf.getvalue()
ok, detail = True, ""
try:
    d = json.loads(out)
except json.JSONDecodeError as e:
    ok, detail = False, f"stdout is not JSON: {e}: {out[:120]!r}"
    print(("PASS " if ok else "FAIL ") + name + " :: " + detail)
    sys.exit(1)
if extra == ["--stuck-list"]:
    ok = rc == 0 and isinstance(d.get("hash"), str)
    detail = "keys=" + ",".join(sorted(d.keys()))
else:
    ok = rc == 0 and all(k in d for k in ("board", "counts", "gate_waiting"))
    detail = "keys=" + ",".join(sorted(d.keys()))
print(("PASS " if ok else "FAIL ") + name + " :: " + detail)
sys.exit(0 if ok else 1)
EOF
    npass=$((npass+1)); echo "ok - $name"
  else
    nfail=$((nfail+1)); echo "not ok - $name"
  fi
}
check_main "main-default-prints-json"
check_main "main-stuck-list-prints-hash" --stuck-list

# M-328: freeq_matches + freeq_has_ask_card, no network. Pure-function cases:
# trailing "?", Owner-decision phrases, and the three exclusions (WAKEUP
# marker, evidence block, fenced-code tail). Ask-card cases: a question_answer
# run within 15 min or sharing the comment's source_task_id exempts.
check_freeq() { # check_freeq <name> <content-json> <want-flagged>
  local name="$1" content="$2" want="$3"
  if python3 - "$name" "$content" "$want" <<'EOF'; then
import importlib.machinery, importlib.util, json, sys
path = "./orch-sweep"
loader = importlib.machinery.SourceFileLoader("s", path)
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
name, content, want = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3] == "1"
got, signal = s.freeq_matches(content)
ok = (bool(got) == want)
detail = repr(signal[:80])
print(("PASS " if ok else "FAIL ") + name + " :: flagged=" + str(bool(got)) + " " + detail)
sys.exit(0 if ok else 1)
EOF
    npass=$((npass+1)); echo "ok - $name"
  else
    nfail=$((nfail+1)); echo "not ok - $name"
  fi
}
check_freeq "fq-trailing-question" '"Status update.\n\nCould we test on dsh-z and multica-main?"' 1
check_freeq "fq-owner-decision" '"Plan v2 ready.\n\nOne decision for the Owner: approve Plan v2 so M-285 can be built."' 1
check_freeq "fq-which-option" '"Two paths forward. Owner, please decide which option to take."' 1
check_freeq "fq-statement" '"Merged, NOT deployed. Evidence block posted on the card."' 0
check_freeq "fq-wakeup" '"[WAKEUP] armed: resume check at 18:30Z"' 0
check_freeq "fq-fenced-code" '"Run this:\n```\nfoo?\n```\nDone."' 0
check_freeq "fq-empty" '""' 0
check_askcard() { # check_askcard <name> <runs-json> <comment-json> <want-exempt>
  local name="$1" runs="$2" comment="$3" want="$4"
  if python3 - "$name" "$runs" "$comment" "$want" <<'EOF'; then
import importlib.machinery, importlib.util, json, sys
path = "./orch-sweep"
loader = importlib.machinery.SourceFileLoader("s", path)
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
name = sys.argv[1]
runs, comment, want = json.loads(sys.argv[2]), json.loads(sys.argv[3]), sys.argv[4] == "1"
got = s.freeq_has_ask_card(runs, comment)
ok = (bool(got) == want)
detail = "exempt=" + str(bool(got))
print(("PASS " if ok else "FAIL ") + name + " :: " + detail)
sys.exit(0 if ok else 1)
EOF
    npass=$((npass+1)); echo "ok - $name"
  else
    nfail=$((nfail+1)); echo "not ok - $name"
  fi
}
ASKRUN='[{"id":"r1","created_at":"2026-11-08T13:36:26Z","trigger_comment_id":null,"attribution":{"evidence":{"kind":"question_answer","ref_id":"card1"}}}]'
check_askcard "fq-ask-nearby-run" "$ASKRUN" '{"id":"c1","created_at":"2026-11-08T13:33:34Z","source_task_id":"r9"}' 1
check_askcard "fq-ask-same-run" "$ASKRUN" '{"id":"c1","created_at":"2026-11-08T10:00:00Z","source_task_id":"r1"}' 1
check_askcard "fq-no-ask" "$ASKRUN" '{"id":"c9","created_at":"2026-11-08T10:00:00Z","source_task_id":"r9"}' 0
check_askcard "fq-empty-runs" "[]" '{"id":"c1","created_at":"2026-11-08T13:33:34Z","source_task_id":"r9"}' 0

echo "# passed=$npass failed=$nfail"
[ "$nfail" -eq 0 ]
