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
echo "1..45"
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
s.load_incomplete_turns_state = lambda: (s.incomplete_turns_default_state(), None)
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
elif extra[:1] == ["--illegal-endings"]:
    ok = rc == 0 and d.get("mode") == "illegal-endings" and isinstance(d.get("offenders"), list) and isinstance(d.get("checked"), int)
    detail = "keys=" + ",".join(sorted(d.keys()))
else:
    ok = rc == 0 and all(k in d for k in ("board", "counts", "gate_waiting", "incomplete_turns"))
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
check_main "main-illegal-endings-prints-mode" --illegal-endings

# M-393: deterministic no-delta classification and consecutive sweeps.
if python3 - <<'EOF'; then
import importlib.machinery, importlib.util
loader = importlib.machinery.SourceFileLoader("s", "./orch-sweep")
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
agent, leader = "agent-1", s.INCOMPLETE_LEADER_ID
issue = {"id": "issue-1", "identifier": "M-1", "status": "in_progress", "assignee_id": agent}
def run(rid, start, end, aid=agent, status="completed"):
    return {"id": rid, "agent_id": aid, "status": status, "started_at": start,
            "completed_at": end, "result": {"output": "standing by"}}
def detect(i=issue, r=None, state=None, acts=None, comms=None, wakes=None, t="2026-11-17T01:00:00Z"):
    return s.classify_incomplete_turns([i], {i["id"]: [r] if r else []},
        {i["id"]: acts or []}, {i["id"]: comms or []}, {i["id"]: wakes or []},
        state or s.incomplete_turns_default_state(), t=s.parse_ts(t))
r1 = run("run-1", "2026-11-17T00:01:00Z", "2026-11-17T00:02:00Z")
a = detect(r=r1, t="2026-11-17T00:02:30Z")
assert a["actions"][0]["action"] == "requeue_same_agent" and a["actions"][0]["occurrence"] == 1
r2 = run("run-2", "2026-11-17T00:03:00Z", "2026-11-17T00:04:00Z")
b = detect(r=r2, state=a["state"], t="2026-11-17T00:04:30Z")
assert b["actions"][0]["action"] == "assign_leader" and b["actions"][0]["occurrence"] == 2
assert detect(r=r2, state=b["state"], t="2026-11-17T00:05:00Z")["actions"] == []
r3 = run("run-3", "2026-11-17T00:05:00Z", "2026-11-17T00:06:00Z")
assert detect(r=r3, state=b["state"], t="2026-11-17T00:06:30Z")["actions"] == []
progress = detect(r=r2, state=a["state"], comms=[{"author_id": agent,
    "created_at": "2026-11-17T00:03:30Z"}], t="2026-11-17T01:04:00Z")
assert progress["actions"] == [] and "M-1:agent-1" not in progress["state"]["counts"]
assert detect(i=dict(issue, status="in_review"), r=r2, state=a["state"])["actions"] == []
f = s.classify_incomplete_turns([issue], {"issue-1": {"__error__": "unavailable"}},
    {}, {}, {}, a["state"], t=s.parse_ts("2026-11-17T01:05:00Z"))
assert f["actions"] == [] and f["skipped"][0]["reason"] == "runs_unreadable"
assert f["state"]["last_sweep_at"] == a["state"]["last_sweep_at"]
f2 = s.classify_incomplete_turns([issue], {"issue-1": [r2]}, {"issue-1": []},
    {"issue-1": [{"author_id": "agent-1", "created_at": "unknown"}]},
    {"issue-1": []}, a["state"], t=s.parse_ts("2026-11-17T01:05:00Z"))
assert f2["actions"] == [] and f2["skipped"][0]["reason"] == "ambiguous_history_timestamp"
assert f2["state"]["last_sweep_at"] == a["state"]["last_sweep_at"]
g = detect(i=dict(issue, assignee_id=leader), r=run("leader-run",
    "2026-11-17T00:01:00Z", "2026-11-17T00:02:00Z", aid=leader))
assert g["actions"][0]["action"] == "leader_noop"
assert detect(r=run("failed", "2026-11-17T00:01:00Z", "2026-11-17T00:02:00Z", status="failed"))["actions"] == []
print("PASS M-393: retry, Leader route, dedupe, reset, terminal, fail-closed, Leader self-route, failed run")
EOF
  npass=$((npass+1)); echo "ok - incomplete-turn-cases"
else
  nfail=$((nfail+1)); echo "not ok - incomplete-turn-cases"
fi

# Exercise the actual collector across two synthetic sweep passes. The
# Orchestrator consumes the emitted action: reminder comment, then rerun-task
# or assign. This verifies one detected run produces one handoff action and a
# second no-delta run routes to the Leader without replaying the first action.
if python3 - <<'EOF'; then
import importlib.machinery, importlib.util
loader = importlib.machinery.SourceFileLoader("s", "./orch-sweep")
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
agent, leader = "agent-1", s.INCOMPLETE_LEADER_ID
issue = {"id": "issue-1", "identifier": "M-1", "status": "in_progress", "assignee_id": agent}
runs = [{"id": "run-1", "agent_id": agent, "status": "completed",
         "started_at": "2026-11-17T00:01:00Z", "completed_at": "2026-11-17T00:02:00Z"}]
state = {"v": 1, "last_sweep_at": "2026-11-17T00:00:00Z",
         "processed_run_ids": [], "counts": {}}
def seeded_cli(args, timeout=90):
    if args[0:3] == ["multica", "issue", "runs"]:
        return runs
    if args[0:3] == ["multica", "issue", "timeline"]:
        return []
    if args[0:4] == ["multica", "issue", "comment", "list"]:
        return []
    if args[0:4] == ["multica", "issue", "wakeup", "list"]:
        return []
    raise AssertionError("unexpected CLI call: " + repr(args))
s.sh_json = seeded_cli
s.load_incomplete_turns_state = lambda: (state, None)
s.now = lambda: s.parse_ts("2026-11-17T00:03:00Z")
first = s.collect_incomplete_turns([issue])
assert len(first["actions"]) == 1
assert first["actions"][0]["action"] == "requeue_same_agent"
assert first["actions"][0]["run_id"] == "run-1"
assert first["actions"][0]["target_agent_id"] == agent
assert first["actions"][0]["reminder"] == s.INCOMPLETE_REMINDER
state = first["state"]
runs.append({"id": "run-2", "agent_id": agent, "status": "completed",
              "started_at": "2026-11-17T00:04:00Z", "completed_at": "2026-11-17T00:05:00Z"})
s.now = lambda: s.parse_ts("2026-11-17T00:06:00Z")
second = s.collect_incomplete_turns([issue])
assert len(second["actions"]) == 1
assert second["actions"][0]["action"] == "assign_leader"
assert second["actions"][0]["target_agent_id"] == leader
assert "run-1" in second["state"]["processed_run_ids"]
state = second["state"]
third = s.collect_incomplete_turns([issue])
assert third["actions"] == []
print("PASS M-393 collector: one same-agent retry action, second-run Leader action, no duplicate action")
EOF
  npass=$((npass+1)); echo "ok - incomplete-turn-collector"
else
  nfail=$((nfail+1)); echo "not ok - incomplete-turn-collector"
fi

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

# M-391: illegal_endings_matches + illegal_has_same_run_driver, no network.
# Pure-function cases: each illegal signal fires, and the M-328-style
# exclusions (WAKEUP marker, evidence block, fenced-code body) stay silent.
# Driver cases: a same-run wakeup or ask card exempts, a stale wakeup does not.
check_illegal() { # check_illegal <name> <content-json> <want-flagged>
  local name="$1" content="$2" want="$3"
  if python3 - "$name" "$content" "$want" <<'EOF'; then
import importlib.machinery, importlib.util, json, sys
path = "./orch-sweep"
loader = importlib.machinery.SourceFileLoader("s", path)
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
name, content, want = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3] == "1"
got, signal = s.illegal_endings_matches(content)
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
check_illegal "ie-standing-by" '"Work done. Standing by for next instructions."' 1
check_illegal "ie-stand-by" '"Stand by for instructions."' 1
check_illegal "ie-waiting-review" '"Done. Waiting for review."' 1
check_illegal "ie-lane-operator-needed" '"Lane operator needed to proceed."' 1
check_illegal "ie-architect-needed" '"Claude Architect needed for the verdict."' 1
check_illegal "ie-next-unnamed" '"Next: verify the deploy on dsh-z."' 1
check_illegal "ie-next-step" '"Next step is to confirm green CI."' 1
check_illegal "ie-someone-should" '"Someone should check the logs."' 1
check_illegal "ie-todo-for" '"To-do for follow-up: check the logs."' 1
check_illegal "ie-clean-statement" '"Merged, NOT deployed. Evidence block posted on the card."' 0
check_illegal "ie-evidence" '"Evidence block: done. Standing by for review."' 0
check_illegal "ie-wakeup" '"[WAKEUP] armed: standing by until 18:30Z"' 0
check_illegal "ie-fenced-code" '"Run this:\n```\nstanding by\n```\nDone."' 0
check_illegal "ie-question-owner" '"Could you approve Plan v2, Owner?"' 0
check_illegal "ie-next-named" '"Next: @owner please approve plan v2."' 0
check_ildriver() { # check_ildriver <name> <runs-json> <wakeups-json> <comment-json> <want-exempt>
  local name="$1" runs="$2" wakes="$3" comment="$4" want="$5"
  if python3 - "$name" "$runs" "$wakes" "$comment" "$want" <<'EOF'; then
import importlib.machinery, importlib.util, json, sys
path = "./orch-sweep"
loader = importlib.machinery.SourceFileLoader("s", path)
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
name = sys.argv[1]
runs, wakes = json.loads(sys.argv[2]), json.loads(sys.argv[3])
comment, want = json.loads(sys.argv[4]), sys.argv[5] == "1"
got = s.illegal_has_same_run_driver(runs, wakes, comment)
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
SAMEWAKE='[{"id":"w1","enabled":true,"created_at":"2026-11-08T13:35:00Z"}]'
STALEWAKE='[{"id":"w1","enabled":true,"created_at":"2026-11-08T10:00:00Z"}]'
check_ildriver "ie-driver-wakeup-same-run" "[]" "$SAMEWAKE" '{"id":"c1","created_at":"2026-11-08T13:33:34Z","source_task_id":"r9"}' 1
check_ildriver "ie-driver-wakeup-stale" "[]" "$STALEWAKE" '{"id":"c1","created_at":"2026-11-08T13:33:34Z","source_task_id":"r9"}' 0
check_ildriver "ie-driver-ask-card" "$ASKRUN" "[]" '{"id":"c1","created_at":"2026-11-08T13:33:34Z","source_task_id":"r9"}' 1

echo "# passed=$npass failed=$nfail"
[ "$nfail" -eq 0 ]
