#!/usr/bin/env bash
# orch-sweep.test.sh — M-268 seeded verification for --stuck-list mode.
# No network, no board: feeds synthetic boards into build_stuck_list and
# asserts the four triggers, the verdict amendment (driven cards excluded),
# and hash stability (same board twice -> same hash; age drift -> same hash).
set -euo pipefail
cd "$(dirname "$0")"
# Hermetic CLI. CI has no `multica` binary, and the harness must never read the
# real board: an un-stubbed call gets an empty JSON object instead of a crash.
shim="$PWD/.test-bin.$$"
mkdir -p "$shim"
printf '#!/bin/sh\necho "{}"\n' > "$shim/multica"
chmod +x "$shim/multica"
PATH="$shim:$PATH"
export PATH
trap 'rm -rf "$shim"' EXIT
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
echo "1..60"
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
# M-392 v2: the invariant (D2) is a pure function over collected facts, so the
# whole satisfier/driver matrix is testable without a board.
if python3 - <<'EOF'; then
import importlib.machinery, importlib.util
loader = importlib.machinery.SourceFileLoader("s", "./orch-sweep")
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)

def fact(**kw):
    base = {"card": "M-1", "id": "i1", "status": "in_progress", "assignee_id": "a",
            "idle_min": 90, "active_run": False, "live_wakeups": 0, "open_asks": 0,
            "errors": [], "prs": [], "refs": [], "ref_status": {}, "open_pr": None,
            "children_progressible": False, "block_kind": None, "block_on": None,
            "account_state": "ok"}
    base.update(kw); return base

# 1. Each of the three satisfiers satisfies, and is reported as such.
for kw, want in (({"active_run": True}, "run"), ({"live_wakeups": 1}, "wakeup"),
                 ({"open_asks": 1}, "ask")):
    inv = s.build_invariant([fact(**kw)])
    assert inv["violators"] == [] and inv["satisfied_by"][want] == 1, (kw, inv)

# 2. Owner-held terminal statuses are out of scope, not violators.
assert "in_review" not in s.V2_STATUSES and "done" not in s.V2_STATUSES

# 3. Undriven in_progress -> one resume driver.
v = s.build_invariant([fact()])["violators"][0]
assert v["satisfier"] == "none" and v["proposed"]["cause"] == "resume"
assert v["proposed"]["flags"] == ["--after", "1m"], v

# 4. Unreadable runs fail closed to inspect, never silently satisfied.
v = s.build_invariant([fact(errors=["runs"])])["violators"][0]
assert v["proposed"]["action"] == "inspect", v

# 5. Leader-owned idle card is still driven (by waking the Leader), not skipped.
v = s.build_invariant([fact(assignee_id=s.LEAD_POOL[0])])["violators"][0]
assert v["proposed"]["leader_owned"] is True and v["proposed"]["cause"] == "resume"
assert s.build_invariant([fact(assignee_id="engineer")])["violators"][0]["proposed"].get("leader_owned") is None

# 6. Per-status drivers: todo starts, plan gate waits on the approval flip with
#    an expiry, wait_for_decision asks the Leader, deploy resumes the engineer.
v = s.build_invariant([fact(status="planing_2")])["violators"][0]["proposed"]
assert v["flags"][:2] == ["--until-status", "in_progress"] and "--expires-in" in v["flags"], v
assert s.build_invariant([fact(status="wait_for_decision")])["violators"][0]["proposed"]["action"] == "ask"
assert s.build_invariant([fact(status="todo")])["violators"][0]["proposed"]["cause"] == "start"
assert s.build_invariant([fact(status="agent_review_deploy")])["violators"][0]["proposed"]["cause"] == "deploy"

# 7. The pass is bounded and says so: scope total > checked cards, cap reported.
facts = [fact(card=f"M-{n}") for n in range(3)]
inv = s.build_invariant(facts, scope_total=9)
assert inv["checked"] == 3 and inv["scope"] == 9, inv
print("PASS v2 invariant: run/wakeup/ask satisfied, in_review exempt, driver per status, leader-owned, read-fail closed")
EOF
  npass=$((npass+1)); echo "ok - v2-invariant"
else
  nfail=$((nfail+1)); echo "not ok - v2-invariant"
fi

# M-392 D3: blocked kinds - metadata wins, deterministic fallback otherwise,
# unverified fails closed, and Owner cards batch by cluster.
if python3 - <<'EOF'; then
import importlib.machinery, importlib.util
loader = importlib.machinery.SourceFileLoader("s", "./orch-sweep")
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)

def fact(**kw):
    base = {"card": "M-1", "id": "i1", "status": "blocked", "assignee_id": "a",
            "idle_min": 300, "active_run": False, "live_wakeups": 0, "open_asks": 0,
            "errors": [], "prs": [], "refs": [], "ref_status": {}, "open_pr": None,
            "children_progressible": False, "block_kind": None, "block_on": None,
            "account_state": "ok"}
    base.update(kw); return base

b = s.classify_blocked
# metadata is authoritative, in all three kinds
for k in s.BLOCK_KINDS:
    c = b(fact(block_kind=k))
    assert c["kind"] == k and c["kind_source"] == "metadata", c
# an unknown metadata kind never auto-acts
c = b(fact(block_kind="someday"))
assert c["kind"] == "unverified" and c["driver"]["action"] == "inspect", c
# heuristic: open ask -> owner
assert b(fact(open_asks=1))["kind"] == "owner"
# heuristic: blocker still open -> dependency, one-shot wait with expiry
c = b(fact(ref_status={"M-7": "in_progress"}))
assert c["kind"] == "dependency" and c["driver"]["flags"][:2] == ["--until-issue", "M-7"], c
assert "--expires-in" in c["driver"]["flags"] and c["driver"]["flags"][-2:] == ["--on-timeout", "wake"]
# blocker already terminal -> stale parking, so the agent is the driver (no wait that never fires)
c = b(fact(block_on="M-7", ref_status={"M-7": "done"}))
assert c["kind"] == "agent" and c["kind_source"] == "heuristic:block_on-terminal", c
# progressible children -> wait on children_done
c = b(fact(children_progressible=True))
assert c["kind"] == "dependency" and c["driver"]["cause"] == "children", c
assert c["driver"]["flags"][:3] == ["--until-children-done", "--expires-in", s.CHILDREN_WAIT_EXPIRES]
# open PR -> wait for the next CI result, never a silent poll
pr = {"repo": "r", "n": 5, "state": "OPEN", "head": "abc", "verdict_on_head": None,
      "checks": {"total": 1, "failing": []}, "updated_at": "2026-11-16T00:00:00Z"}
c = b(fact(open_pr=pr, prs=[pr]))
assert c["kind"] == "dependency" and c["driver"]["flags"][:2] == ["--until-pr", "checks"], c
# dead account -> reassign; live-but-stuck assignee -> resume that assignee
assert b(fact(account_state="cooling"))["driver"]["action"] == "reassign"
assert b(fact())["kind"] == "agent" and b(fact())["driver"]["cause"] == "resume"

# Owner cards sharing one blocker become ONE batched ask per cluster.
facts = [fact(card="M-31", open_asks=1, block_on="PR#200"),
         fact(card="M-42", open_asks=1, block_on="PR#200"),
         fact(card="M-85", open_asks=1, block_on="M-325")]
blocked = [b(f) for f in facts]
q = s.leader_queue_for(facts, blocked, {"violators": []}, [], 1, {}, {})
assert len(q["owner_asks"]) == 2, q["owner_asks"]
assert [x["cards"] for x in q["owner_asks"] if x["cluster"] == "PR#200"] == [["M-31", "M-42"]]
print("PASS v2 blocked kinds: metadata/heuristic/unverified, per-kind driver, owner asks batched by cluster")
EOF
  npass=$((npass+1)); echo "ok - v2-blocked-kinds"
else
  nfail=$((nfail+1)); echo "not ok - v2-blocked-kinds"
fi

# M-392 D4: per-card budget. 6th wake is allowed, 7th is refused and escalated
# once that day; a create failure must not consume budget.
if python3 - <<'EOF'; then
import importlib.machinery, importlib.util, json
loader = importlib.machinery.SourceFileLoader("s", "./orch-sweep")
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
T = s.parse_ts("2026-11-17T03:00:00Z")
day = s.budget_day(T)
# The platform rejects a wakeup with no event and no `at` delay
# ("select at least one supported event"); the stub enforces that so a
# malformed flag set can never pass here again.
def platform_wakeup_ok(args):
    kind = args[args.index("--kind") + 1] if "--kind" in args else "event"
    if any(a.startswith("--until-") for a in args):
        return kind == "event"
    if kind == "at":
        return "--after" in args or "--at" in args
    if kind == "event":
        return "--event" in args
    return False


state = {"budget": {"d": day, "n": 5}}
calls, fail_create = [], [False]
def fake_sh(args, timeout=90):
    calls.append(args)
    if args[0:4] == ["multica", "issue", "metadata", "get"]:
        return 0, json.dumps({"value": json.dumps(state["budget"])}), ""
    if args[0:4] == ["multica", "issue", "metadata", "set"]:
        state["budget"] = json.loads(args[args.index("--value") + 1])
        return 0, "", ""
    if args[0:4] == ["multica", "issue", "wakeup", "create"]:
        assert platform_wakeup_ok(args), "platform: select at least one supported event " + repr(args)
        if fail_create[0]:
            return 1, "", "boom"
        return 0, json.dumps({"id": "w1"}), ""
    raise AssertionError("unexpected call " + repr(args))
s.sh = fake_sh

# 6th wake of the day: allowed, budget 5 -> 6, and it targets the assignee.
a = s.arm_wake("M-1", "i1", "resume", ["--after", "1m"], True, 6, T, agent_id="eng")
assert a["armed"] and a["budget_before"] == 5 and a["budget_after"] == 6, a
wake = next(c for c in calls if c[0:4] == ["multica", "issue", "wakeup", "create"])
assert wake[wake.index("--agent-id") + 1] == "eng", wake
assert "M-1: no live run" in wake[wake.index("--instruction") + 1]

# 7th: refused, escalated exactly once, and no wakeup create is attempted.
calls.clear()
a = s.arm_wake("M-1", "i1", "resume", ["--after", "1m"], True, 6, T, agent_id="eng")
assert a["refused"] == "budget-exhausted" and a["escalate"] is True, a
assert a["escalation_logged"] is True, a
assert not [c for c in calls if c[0:4] == ["multica", "issue", "wakeup", "create"]]
assert state["budget"]["esc"] == day and state["budget"]["n"] == 6
# second refusal the same day does not escalate again
calls.clear()
a = s.arm_wake("M-1", "i1", "resume", ["--after", "1m"], True, 6, T, agent_id="eng")
assert a["escalate"] is False and a["escalation_logged"] is False
assert not [c for c in calls if c[0:4] in (["multica", "issue", "wakeup", "create"],
                                          ["multica", "issue", "metadata", "set"])], calls

# A failed create spends no budget and reports the error.
state["budget"] = {"d": day, "n": 1}
fail_create[0] = True
a = s.arm_wake("M-1", "i1", "resume", ["--after", "1m"], True, 6, T, agent_id="eng")
assert not a["armed"] and a["error"] == "boom" and a["budget_after"] == 1 and state["budget"]["n"] == 1, a
# A repeating rule gets a fire cap so it can never run unbounded.
state["budget"] = {"d": day, "n": 0}
calls.clear()
a = s.arm_wake("M-1", "i1", "resume", ["--event", "comment.created", "--expires-in", "24h"],
               True, 6, T, agent_id="eng")
create = next(c for c in calls if c[0:4] == ["multica", "issue", "wakeup", "create"])
assert "--max-fires" in create and create[create.index("--max-fires") + 1] == str(s.WAKE_MAX_FIRES_DEFAULT), create
# Budget resets on a new ICT day.
state["budget"] = {"d": "2026-11-16", "n": 6}
fail_create[0] = False
a = s.arm_wake("M-1", "i1", "resume", ["--after", "1m"], True, 6, T, agent_id="eng")
assert a["armed"] and a["budget_before"] == 0 and a["budget_after"] == 1, a
print("PASS v2 wake budget: 6th allowed, 7th refused+escalated once, failed create free, ICT-day reset")
EOF
  npass=$((npass+1)); echo "ok - v2-wake-budget"
else
  nfail=$((nfail+1)); echo "not ok - v2-wake-budget"
fi

# M-392: the whole pass. Dry run executes zero `wakeup create` / `metadata set`;
# --apply arms one resume per undriven card and covers the violator list.
if python3 - <<'EOF'; then
import importlib.machinery, importlib.util, json
loader = importlib.machinery.SourceFileLoader("s", "./orch-sweep")
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
T = s.parse_ts("2026-11-17T03:00:00Z")
issues = [{"id": "i1", "identifier": "M-1", "status": "in_progress", "assignee_id": "a",
           "last_activity_at": "2026-11-17T00:00:00Z", "title": "M-1 thing",
           "description": "", "metadata": {}}]
s.card_runs = lambda cid: []
s.card_wakeups = lambda cid: []
s.read_open_questions = lambda cid: (0, None)
s.children_statuses = lambda key: None
s.target_status = lambda ref: None
budget_state = {}
calls = []


def platform_wakeup_ok(args):
    kind = args[args.index("--kind") + 1] if "--kind" in args else "event"
    if any(a.startswith("--until-") for a in args):
        return kind == "event"
    if kind == "at":
        return "--after" in args or "--at" in args
    if kind == "event":
        return "--event" in args
    return False


def fake_sh(args, timeout=90):
    calls.append(args)
    if args[0:4] == ["multica", "issue", "metadata", "get"]:
        if not budget_state:
            return 1, "", "key not found on issue"
        return 0, json.dumps({"value": json.dumps(budget_state)}), ""
    if args[0:4] == ["multica", "issue", "metadata", "set"]:
        budget_state.clear(); budget_state.update(json.loads(args[args.index("--value") + 1]))
        return 0, "", ""
    if args[0:4] == ["multica", "issue", "wakeup", "create"]:
        assert platform_wakeup_ok(args), "platform: select at least one supported event " + repr(args)
        return 0, json.dumps({"id": "w1"}), ""
    if args[0:3] == ["multica", "issue", "get"]:
        return 0, "", ""
    raise AssertionError("unexpected call " + repr(args))
s.sh = fake_sh
WRITES = lambda: [c for c in calls if c[0:4] in
                  (["multica", "issue", "wakeup", "create"],
                   ["multica", "issue", "metadata", "set"])]

dry = s.sweep_v2(issues, T, {}, [], apply=False, limit=6, card_cap=40,
                 agent_row={}, todos=[], wip={})
assert WRITES() == [], WRITES()
assert dry["checked"] == 1 and len(dry["violators"]) == 1, dry["violators"]
assert dry["actions"][0]["dry_run"] is True
assert dry["violators_after"] == [] and dry["covered"]["M-1"].startswith("wakeup:"), dry["covered"]

calls.clear()
applied = s.sweep_v2(issues, T, {}, [], apply=True, limit=6, card_cap=40,
                     agent_row={}, todos=[], wip={})
w = WRITES()
assert len([c for c in w if c[0:4] == ["multica", "issue", "wakeup", "create"]]) == 1, w
create = next(c for c in w if c[0:4] == ["multica", "issue", "wakeup", "create"])
assert create[create.index("--kind") + 1] == "at" and create[create.index("--after") + 1] == "1m", create
assert len([c for c in w if c[0:4] == ["multica", "issue", "metadata", "set"]]) == 1, w
assert applied["actions"][0]["armed"] and applied["actions"][0]["budget_after"] == 1
assert budget_state.get("n") == 1, budget_state
assert applied["violators_after"] == []

# Coverage must be real. A failed create is an escalation, never coverage.
s.arm_wake = lambda *a, **k: {"card": "M-1", "cause": "resume", "armed": False,
                              "budget_before": 0, "budget_after": 0,
                              "error": "Invalid request: bad wakeup"}
failed = s.sweep_v2(issues, T, {}, [], apply=True, limit=6, card_cap=40,
                    agent_row={}, todos=[], wip={})
assert failed["violators_after"] == ["M-1"], failed["violators_after"]
assert failed["escalations"][0]["reason"] == "wakeup-create-failed", failed["escalations"]

# ...and a Leader queue that never left the box covers nothing either.
s.arm_wake = lambda *a, **k: {"card": "M-2", "cause": "resume", "armed": True,
                              "wakeup_kind": "after", "budget_before": 0,
                              "budget_after": 1}
wfd = [dict(issues[0], identifier="M-2", status="wait_for_decision")]
undelivered = s.sweep_v2(wfd, T, {}, [], apply=True, limit=6, card_cap=40,
                         agent_row={}, todos=[], wip={})
assert undelivered["leader_ping"]["arm"] is False, undelivered["leader_ping"]
assert undelivered["violators_after"] == ["M-2"], undelivered["violators_after"]

# An idle engineer with no todo yields exactly ONE batched cut_next; with a
# todo on the board the Leader is not asked to cut.
assert len(applied["leader_queue"]["cut_next"]) == 1, applied["leader_queue"]
with_todo = s.sweep_v2(issues, T, {}, [], apply=False, limit=6, card_cap=40,
                       agent_row={}, todos=[{"identifier": "M-9"}], wip={})
assert with_todo["leader_queue"]["cut_next"] == [], with_todo["leader_queue"]
print("PASS v2 pass: dry run writes nothing, --apply arms one resume, cut_next batched once")
EOF
  npass=$((npass+1)); echo "ok - v2-pass-dry-run"
else
  nfail=$((nfail+1)); echo "not ok - v2-pass-dry-run"
fi

# M-392: the batched Leader ping replaces the hash gate - arm once when the
# queue is non-empty and nothing is pending or recent, never on an empty queue.
if python3 - <<'EOF'; then
import importlib.machinery, importlib.util, json
loader = importlib.machinery.SourceFileLoader("s", "./orch-sweep")
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
T = s.parse_ts("2026-11-17T03:00:00Z")
lead = s.LEAD_POOL[0]
issues = [{"id": "epic", "identifier": s.LEADER_CARD, "status": "in_progress"}]
q = {"owner_asks": [{"cluster": "PR#200", "cards": ["M-31"]}], "decisions": [],
     "plans": [], "reassign": [], "verdicts": [], "cut_next": [], "items": 1}
calls, wakeups = [], [[]]


def platform_wakeup_ok(args):
    kind = args[args.index("--kind") + 1] if "--kind" in args else "event"
    if any(a.startswith("--until-") for a in args):
        return kind == "event"
    if kind == "at":
        return "--after" in args or "--at" in args
    if kind == "event":
        return "--event" in args
    return False


def fake_sh(args, timeout=90):
    calls.append(args)
    if args[0:4] == ["multica", "issue", "wakeup", "create"]:
        assert platform_wakeup_ok(args), "platform: select at least one supported event " + repr(args)
        return 0, json.dumps({"id": "lw1"}), ""
    raise AssertionError("unexpected call " + repr(args))
s.sh = fake_sh
s.card_wakeups = lambda cid: wakeups[0]

# empty queue: nothing armed, and no issue read either
ping = s.ping_leader({"items": 0}, [], T, True, {}, {})
assert ping["arm"] is False and ping["reason"] == "queue-empty" and calls == []

# non-empty, nothing pending: one wake on the epic, addressed to the Leader
dry = s.ping_leader(q, issues, T, False, {}, {})
assert dry["arm"] is False and dry["reason"] == "would-arm" and calls == [], calls
ping = s.ping_leader(q, issues, T, True, {}, {})
assert ping["arm"] is True and ping["reason"] == "armed"
arm = next(c for c in calls if c[0:4] == ["multica", "issue", "wakeup", "create"])
assert arm[4] == "epic" and arm[arm.index("--agent-id") + 1] == lead, arm
assert arm[arm.index("--kind") + 1] == "at", arm
assert "Leader queue from orch-sweep" in arm[arm.index("--instruction") + 1]

# a pending Leader wakeup means the queue is already delivered
calls.clear()
wakeups[0] = [{"id": "w", "agent_id": lead, "enabled": True, "disabled_at": None,
               "condition": {}, "event_types": [], "created_at": "2026-11-17T02:59:00Z"}]
ping = s.ping_leader(q, issues, T, True, {}, {})
assert ping["arm"] is False and ping["reason"] == "leader-wake-pending" and calls == []

# fired wakeups do not block, but the 60-min spacing does
wakeups[0] = [{"id": "w", "agent_id": lead, "enabled": False, "disabled_at": None,
               "condition": {}, "event_types": [], "created_at": "2026-11-17T02:30:00Z"}]
ping = s.ping_leader(q, issues, T, True, {}, {})
assert ping["arm"] is False and ping["reason"] == "spaced", ping
wakeups[0] = [{"id": "w", "agent_id": lead, "enabled": False, "disabled_at": None,
               "condition": {}, "event_types": [], "created_at": "2026-11-17T01:00:00Z"}]
calls.clear()
ping = s.ping_leader(q, issues, T, True, {}, {})
assert ping["arm"] is True and len(calls) == 1, ping
print("PASS v2 leader ping: batched, once per 60 min, skipped when pending or empty")
EOF
  npass=$((npass+1)); echo "ok - v2-leader-ping"
else
  nfail=$((nfail+1)); echo "not ok - v2-leader-ping"
fi

# M-588 B1b: the deterministic role split. Pure-function cases, no board and
# no writes: bucket stability, the 30% distribution, pct=0, fail-closed when
# the Role is offline or the config is missing, never re-split a recorded card,
# a dry pass writes nothing, a card that already ran is not eligible, a card
# already handed to a named agent is not relabelled, and a failed write keeps
# the arm the pass already decided.
check_rp() { # check_rp <case>
  local name="$1"
  if python3 - "$name" <<'EOF'; then
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("s", "./orch-sweep")
spec = importlib.util.spec_from_loader("s", loader)
s = importlib.util.module_from_spec(spec); loader.exec_module(s)
name = sys.argv[1]
ENG, LEAD = "eng-role", "lead-role"
CFG = {"pct": 30, "engineer_role_id": ENG, "lead_role_id": LEAD, "max_wip": 1}
READY = {ENG: {"name": "Engineer Role", "status": "idle", "runtime_bound": True, "archived_at": None},
         LEAD: {"name": "Management Role", "status": "idle", "runtime_bound": True, "archived_at": None}}
OFFLINE = {ENG: {"name": "Engineer Role", "status": "offline", "runtime_bound": False, "archived_at": None},
           LEAD: {"name": "Management Role", "status": "offline", "runtime_bound": False, "archived_at": None}}
def issue(n, status="todo", assignee=None, md=None):
    return {"id": n, "identifier": "M-" + n, "status": status,
            "assignee_id": assignee, "metadata": md or {}}
def role_id():
    for i in range(1000):
        if s.role_pilot_bucket("card-%d" % i) < 30:
            return "card-%d" % i
    raise AssertionError("no role bucket")
def named_id():
    for i in range(1000):
        if s.role_pilot_bucket("card-%d" % i) >= 30:
            return "card-%d" % i
    raise AssertionError("no named bucket")
def build(issues, board=None, names=None, cfg=None, err=None, apply=False, write=None, runs=None):
    # `runs` is stubbed: the harness must never shell out to the multica CLI
    # (CI has none on PATH, and a real card uuid is not available here).
    return s.build_role_pilot(issues, board or {}, names or READY, cfg or CFG, err,
                              apply=apply, write_fn=write or (lambda i, p: (0, "")),
                              runs_fn=runs or (lambda i: []),
                              config_path="role-pilot.test.json")
ok, detail = True, ""
if name == "rp-arm-stable":
    card = role_id()
    arms = [build([issue(card)])["eligible"][0]["arm"] for _ in range(3)]
    ok = arms == ["role"] * 3 and len(set(arms)) == 1
    detail = ",".join(arms)
elif name == "rp-arm-30pct":
    hits = sum(1 for i in range(10000) if s.role_pilot_bucket("u-%d" % i) < 30)
    share = hits / 100.0
    ok = abs(share - 30.0) <= 1.5
    detail = "share=%.2f%%" % share
elif name == "rp-arm-pct0":
    cfg = dict(CFG, pct=0)
    r = build([issue(role_id())], cfg=cfg)
    ok = r["counts"]["role"] == 0 and r["eligible"][0]["arm"] == "named"
    detail = json.dumps(r["counts"])
elif name == "rp-role-offline":
    r = build([issue(role_id())], names=OFFLINE)
    e = r["eligible"][0]
    ok = (e["arm"] == "named" and e["reason"] == "role_offline"
          and any(x["reason"] == "role_offline" for x in r["skipped"])
          and r["counts"]["fallback"] == 1)
    detail = json.dumps({"arm": e["arm"], "reason": e["reason"], "skipped": r["skipped"]})
elif name == "rp-config-missing":
    r = build([issue(role_id())], cfg={"pct": 0, "engineer_role_id": ENG, "lead_role_id": LEAD, "max_wip": 1},
              err="config_missing")
    ok = (r["status"] == "config_missing" and r["pct"] == 0
          and r["eligible"][0]["arm"] == "named" and r["eligible"][0]["reason"] == "config_missing")
    detail = json.dumps({"status": r["status"], "pct": r["pct"], "arm": r["eligible"][0]["arm"]})
elif name == "rp-never-resplit":
    card = role_id()
    rec = json.dumps({"arm": "named", "pct": 30, "bucket": 99, "reason": None})
    r = build([issue(card, md={"role_pilot": rec})])
    ok = r["eligible"] == [] and r["counts"]["existing"] == 1
    detail = json.dumps(r["counts"])
elif name == "rp-dry-run-no-write":
    calls = []
    r = build([issue(role_id())], apply=False, write=lambda i, p: calls.append(i) or (0, ""))
    ok = calls == [] and r["recorded"] == [] and r["apply"] is False
    detail = "writes=%d" % len(calls)
elif name == "rp-not-yet-run":
    card = named_id()
    r = build([issue(card)], board={"M-" + card: 2})
    ok = r["eligible"] == [] and r["skipped"][0]["reason"] == "already_run"
    detail = json.dumps(r["skipped"])
elif name == "rp-pre-assigned":
    calls = []
    card = role_id()
    r = build([issue(card, assignee="named-agent")], apply=True,
              write=lambda i, p: calls.append(i) or (0, ""))
    ok = (r["eligible"] == [] and r["skipped"][0]["reason"] == "pre_assigned" and calls == [])
    detail = json.dumps({"skipped": r["skipped"], "writes": len(calls)})
elif name == "rp-runs-unreadable":
    card = role_id()
    r = build([issue(card)], runs=lambda i: {"__error__": "no multica on PATH"})
    ok = r["eligible"] == [] and r["skipped"][0]["reason"] == "runs_unreadable"
    detail = json.dumps(r["skipped"])
elif name == "rp-write-failure-keeps-arm":
    card = role_id()
    r = build([issue(card)], apply=True, write=lambda i, p: (1, "boom"))
    ok = (r["eligible"][0]["arm"] == "role" and r["recorded"][0]["written"] is False
          and r["counts"]["role"] == 1)
    detail = json.dumps({"arm": r["eligible"][0]["arm"], "recorded": r["recorded"]})
else:
    ok, detail = False, "unknown case " + name
print(("PASS " if ok else "FAIL ") + name + " :: " + detail)
sys.exit(0 if ok else 1)
EOF
    npass=$((npass+1)); echo "ok - $name"
  else
    nfail=$((nfail+1)); echo "not ok - $name"
  fi
}

check_rp "rp-arm-stable"
check_rp "rp-arm-30pct"
check_rp "rp-arm-pct0"
check_rp "rp-role-offline"
check_rp "rp-config-missing"
check_rp "rp-never-resplit"
check_rp "rp-dry-run-no-write"
check_rp "rp-not-yet-run"
check_rp "rp-pre-assigned"
check_rp "rp-runs-unreadable"
check_rp "rp-write-failure-keeps-arm"

echo "# passed=$npass failed=$nfail"
[ "$nfail" -eq 0 ]
