#!/usr/bin/env python3
"""Seeded checks for mmx-scan detection rules (M-606). No network.

Run: python3 -I tools/mmx-scan/mmx-scan.test.py
"""
import importlib.machinery
import importlib.util
import os
import sys

sys.dont_write_bytecode = True  # keep __pycache__ out of the repo

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("mmx_scan", os.path.join(HERE, "mmx-scan"))
spec = importlib.util.spec_from_loader("mmx_scan", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)


def scan(msgs):
    mod.cli = lambda args, allow_fail=False: (msgs, "")
    return mod.scan_messages("run")


def use(tool, inp):
    return {"type": "tool_use", "tool": tool, "input": inp}


CASES = [
    # (name, messages, field, expected)
    ("Skill tool loads mmx", [use("Skill", {"skill": "mmx"})], "mmx", 1),
    ("Skill tool other skill", [use("Skill", {"skill": "mmx-other"})], "mmx", 0),
    ("Read tool on SKILL.md", [use("Read", {"file_path": "/w/.claude/skills/mmx/SKILL.md"})], "mmx", 1),
    ("shell cat of SKILL.md", [use("Bash", {"command": "cat .claude/skills/mmx/SKILL.md"})], "mmx", 1),
    ("codex exec sed", [use("exec_command", {"cmd": "sed -n 1,80p .codex/skills/mmx/SKILL.md"})], "mmx", 1),
    ("grep naming path is not a load", [use("Bash", {"command": "grep -c 'skills/mmx' runs/*.json"})], "mmx", 0),
    ("memory tools counted", [use("mcp__moct__memory_search", {"q": "x"}),
                              use("mcp__moct__memory_note", {"title": "t", "type": "rule", "body": "b"})],
     "memory_search", 1),
    ("memory_note counted", [use("mcp__moct__memory_note", {"title": "t"})], "memory_note", 1),
    ("proposal in comment file", [use("Write", {"file_path": "c.md",
                                                "content": "Result\n\nHarness edit: L4 / mmx\nHypothesis: x"})],
     "harness_edit", 1),
    ("proposal in text", [{"type": "text", "content": "**Harness edit:** L1 / Workspace Context"}],
     "harness_edit", 1),
    ("skill template is not a proposal", [{"type": "text", "content": "Harness edit: <layer> / <component name>"}],
     "harness_edit", 0),
    ("grep for proposals is not one", [use("Bash", {"command": "grep 'Harness edit:' x"})], "harness_edit", 0),
    ("prose mention is not one", [{"type": "text", "content": "0 \"Harness edit:\" proposals"}],
     "harness_edit", 0),
]

fail = 0
for name, msgs, field, want in CASES:
    got = scan(msgs)[field]
    ok = got == want
    fail += not ok
    print(("ok  " if ok else "FAIL"), name, f"{field}={got} want {want}")

R = mod.REJECT_RE
for text, want in [("**Review of PR #53: REQUEST_CHANGES.**", True), ("Verdict: reject", True),
                   ("plan rejected: scope too wide", True), ("Alternatives: B rejected, C deferred", False),
                   ("Needs changes: add tests", True)]:
    ok = bool(R.search(text)) == want
    fail += not ok
    print(("ok  " if ok else "FAIL"), "reject_re", repr(text))

# --- M-608: snapshot attribution, verdict regexes, compare, redaction --------
from datetime import datetime, timedelta, timezone

D = datetime(2026, 11, 26, tzinfo=timezone.utc)


def st(h, f, t, actor="A", kind="agent"):
    return {"type": "activity", "action": "status_changed", "actor_type": kind, "actor_id": actor,
            "created_at": (D + timedelta(hours=h)).isoformat(), "details": {"from": f, "to": t}}


def cm(h, body, kind="member"):
    return {"type": "comment", "actor_type": kind, "content": body,
            "created_at": (D + timedelta(hours=h)).isoformat()}


tl = [st(-30, "todo", "in_progress", "BUILDER"), st(-29, "in_progress", "agent_review_deploy", "BUILDER"),
      st(-28, "agent_review_deploy", "in_review", "LEAD"),
      cm(2, "It not run yet and the team move to In review? How?"),
      cm(3, "**Verdict: PR #58 REQUEST_CHANGES (one blocker)**", "agent"),
      cm(3.5, "Signals: reopens, Needs changes, REQUEST_CHANGES, resumes", "agent"),
      st(4, "in_review", "in_progress", "LEAD"),
      st(5, "in_progress", "in_review", "BUILDER"), st(6, "in_review", "done", "OWNER", "member")]
ev = [(k, b) for k, _a, b, _x in mod.card_events(tl, D, D + timedelta(days=1), "ASSIGNEE")]
for name, want in [("owner correction -> builder", ("owner_correction", "BUILDER")),
                   ("REQUEST_CHANGES verdict -> builder", ("request_changes", "BUILDER")),
                   ("reopen from in_review -> builder", ("reopen", "BUILDER")),
                   ("in_review entry counted", ("in_review", "BUILDER")),
                   ("done counted", ("done", "BUILDER"))]:
    ok = want in ev
    fail += not ok
    print(("ok  " if ok else "FAIL"), name, ev if not ok else "")
ev2 = [k for k, _a, _b, _x in mod.card_events(
    tl[:3] + [dict(cm(1, "Addressed the review: REQUEST_CHANGES fixed", "agent"), actor_id="BUILDER")],
    D, D + timedelta(days=1), None)]
ok = "request_changes" not in ev2
fail += not ok
print(("ok  " if ok else "FAIL"), "builder quoting REQUEST_CHANGES is not a verdict")
ok = sum(1 for k, _ in ev if k == "request_changes") == 1
fail += not ok
print(("ok  " if ok else "FAIL"), "REQUEST_CHANGES listed as a signal is not a verdict")
ok = not any(k == "owner_correction" for k, _a, _b, _x in mod.card_events(
    [st(-1, "todo", "in_progress"), cm(1, "no, do X")], D, D + timedelta(days=1), None))
fail += not ok
print(("ok  " if ok else "FAIL"), "owner comment on a working card is not a delivery correction")
for text, want in [("I add more research. This skill should have the loop.", False),
                   ("move back to implement: remove all legacy tier config", False),
                   ("still broken @Claude Architect", True), ("No, do it in the skill instead", True)]:
    ok = bool(mod.OWNER_CORRECTION_RE.search(text)) == want
    fail += not ok
    print(("ok  " if ok else "FAIL"), "owner_correction_re", repr(text))

red = mod.redact("token: ghp_" + "a" * 36 + " and Redact every secret")
ok = "ghp_" not in red and "[REDACTED]" in red and red.endswith("Redact every secret")
fail += not ok
print(("ok  " if ok else "FAIL"), "redact secret-shaped strings only")


def row(day, agent, cards, corrected):
    r = {k: 0 for k in mod.COUNT_KEYS}
    r.update(date=day, agent=agent, agent_id=agent, cards_in_review=cards, corrected_cards=corrected)
    return r


def days(n, start):
    s = datetime.fromisoformat(start)
    return [(s + timedelta(days=i)).date().isoformat() for i in range(n)]


import random
rnd = random.Random(1)
rows = []
for d in days(14, "2026-11-01"):
    rows += [row(d, "C", 3, rnd.choice([1, 2])), row(d, "K", 3, rnd.choice([1, 2]))]
for d in days(7, "2026-11-15"):
    rows += [row(d, "C", 3, 0), row(d, "K", 3, rnd.choice([1, 2]))]
e = mod.evaluate(rows, "correction_rate", ["C"], "2026-11-15")
ok = e["effect"] < -e["delta"] < 0
fail += not ok
print(("ok  " if ok else "FAIL"), "compare: clear canary gain beats δ", round(e["effect"], 3), round(e["delta"], 3))
rows2 = [r if r["date"] < "2026-11-15" or r["agent"] == "K" else row(r["date"], "C", 3, rnd.choice([1, 2]))
         for r in rows]
e2 = mod.evaluate(rows2, "correction_rate", ["C"], "2026-11-15")
ok = abs(e2["effect"]) <= e2["delta"]
fail += not ok
print(("ok  " if ok else "FAIL"), "compare: noise stays inside δ", round(e2["effect"], 3), round(e2["delta"], 3))

import subprocess as sp
import tempfile
for branch, push, want in [("integration", None, "checkout branch"), ("mmx-harness", "master", "--push target")]:
    with tempfile.TemporaryDirectory(dir=HERE) as d:
        sp.run(["git", "init", "-q", "-b", branch, d], check=True)
        try:
            mod.guard_destination(d, push)
            got = ""
        except SystemExit as ex:
            got = str(ex)
    ok = want in got
    fail += not ok
    print(("ok  " if ok else "FAIL"), "nightly guard refuses", branch, push)
# --- M-612: composite gate, rounds scheduler, SIM index rebuild ---------------
import shutil
import tempfile


def grow(day, agent, cards, corrected, tok, done, din):
    r = {k: 0 for k in mod.COUNT_KEYS}
    r.update(date=day, agent=agent, agent_id=agent, cards_in_review=cards, corrected_cards=corrected,
             tokens_input=tok, tokens_cache_write=tok // 4, done_cards=done,
             days_in_review_sum=round(din, 3), runs=20, completed=18, failed=1)
    return r


def gate_rows(after_tok):
    r2 = random.Random(3)
    out = []
    for d in days(14, "2026-11-01"):
        out += [grow(d, "C", 3, r2.choice([1, 2]), 30000 + r2.randint(0, 4000), 2, 4.0 + r2.random() * 3),
                grow(d, "K", 3, r2.choice([1, 2]), 30000 + r2.randint(0, 4000), 2, 4.0 + r2.random() * 3)]
    for d in days(4, "2026-11-15"):
        out += [grow(d, "C", 3, 0, after_tok, 3, 6.0), grow(d, "K", 3, 0, after_tok, 3, 6.0)]
    return out


# Clear win on all three components -> kept, with per-agent gains reported.
j = mod.gate_judge(gate_rows(22000), "2026-11-15", "2026-11-18")
ok = j["verdict"] == "kept" and all(v is not None for v in j["per_agent_gain"].values())
fail += not ok
print(("ok  " if ok else "FAIL"), "gate: clear win kept",
      round(j["composite_gain"], 2), round(j["composite_band"], 2), j["verdict"])

# Composite improves but tokens regress beyond their band -> rejected (non-compensatory).
j = mod.gate_judge(gate_rows(90000), "2026-11-15", "2026-11-18")
ok = j["verdict"] == "rejected" and any("tokens_per_card" in r for r in j["reasons"])
fail += not ok
print(("ok  " if ok else "FAIL"), "gate: one component regresses -> rejected",
      j["verdict"], j["reasons"] if not ok else "")

# Inside the noise at the cap -> inconclusive (edit reverted, verdict recorded).
j = mod.gate_judge(gate_rows(22000), "2026-11-15", "2026-11-18", min_cards=1000)
ok = j["verdict"] == "inconclusive"
fail += not ok
print(("ok  " if ok else "FAIL"), "gate: too few cards -> inconclusive", j["verdict"])

# Too few cards in a noisy window -> inconclusive, never kept.
thin = [grow(d, "C", 1, r2, 30000, 0, 0.0) for d, r2 in zip(days(14, "2026-11-01"), [0, 1] * 7)]
thin += [grow(d, "C", 1, 0, 30000, 0, 0.0) for d in days(4, "2026-11-15")]
j = mod.gate_judge(thin, "2026-11-15", "2026-11-18")
ok = j["verdict"] == "inconclusive"
fail += not ok
print(("ok  " if ok else "FAIL"), "gate: noise stays inconclusive", j["verdict"],
      j["reasons"] if not ok else "")

# Scheduler: 10 runs unlock round 1; then +1 day, +1 day, then every 3 days.
ok = mod.rounds_schedule(9) == [] and len(mod.rounds_schedule(10, "2026-11-28")) == 1
fail += not ok
print(("ok  " if ok else "FAIL"), "rounds: round 1 gates on 10 runs")
ok = (mod.rounds_next("2026-11-28", 1) == "2026-11-29"
      and mod.rounds_next("2026-11-29", 2) == "2026-11-30"
      and mod.rounds_next("2026-11-30", 3) == "2026-12-03"
      and mod.rounds_next("2026-12-03", 5) == "2026-12-06"
      and mod.rounds_next("2026-12-03", 5, reset=True) == "2026-12-04")
fail += not ok
print(("ok  " if ok else "FAIL"), "rounds: +1d, +1d, then every 3d; reset restarts")

# rounds arm: the printed wakeup command must re-parse to one --instruction argv
# (regression: `cmd.split()` used to split the quoted instruction into pieces).
import io
from contextlib import redirect_stdout
import shlex as _shlex


class _A:
    pass


a = _A()
a.last_round_date = "2026-11-28"
a.round_no = 1
a.reset = False
a.issue = None
buf = io.StringIO()
with redirect_stdout(buf):
    mod.rounds_arm(a)
toks = _shlex.split(buf.getvalue().strip().splitlines()[0])
ok = (toks[toks.index("--instruction") + 1].startswith("MMX round 2:")
      and toks[toks.index("--expires-in") + 1] == "96h"
      and "--on-timeout" in toks and toks[toks.index("--at") + 1] == "2026-11-29T01:00:00Z")
fail += not ok
print(("ok  " if ok else "FAIL"), "rounds arm: instruction survives argv round-trip")
# Index rebuild: derived linkage survives a fresh regeneration; live edit guard fires.
tmp = tempfile.mkdtemp(prefix="mmx-sim-test-")
simd = os.path.join(tmp, "sim")
os.makedirs(os.path.join(simd, "problems"))


def _mk_problem(name):
    a = _A()
    a.sim = simd
    a.repo = None
    a.sim_dir = "sim"
    a.name = name
    a.root_cause = "test"
    a.round = 1
    mod.sim_problem(a)


_mk_problem("P one")
_mk_problem("P two")
os.remove(os.path.join(simd, "INDEX.json")) if os.path.exists(os.path.join(simd, "INDEX.json")) else None


def _mk_attempt(prob, comp, rnd_no=1):
    a = _A()
    a.sim = simd
    a.repo = None
    a.problem = prob
    a.round = rnd_no
    a.layer = "L4"
    a.component = comp
    a.what = "w"
    a.rationale = "r"
    a.predicted_metric = "owner_corrections_per_card"
    a.predicted_delta = -0.1
    a.harness_commit = None
    a.agent = a.executor = a.model = a.tier = None
    a.card = "M-612"
    mod.sim_attempt(a)


_mk_attempt("P-1", "mmx")
idx = mod.sim_index_data(simd)
ok = (len(idx["problems"]) == 2 and len(idx["attempts"]) == 1
      and idx["problems"][0]["attempt_ids"] == ["A-1-1"]
      and idx["live_components"] == ["mmx"] and idx["open_problems"] == 2)
fail += not ok
print(("ok  " if ok else "FAIL"), "sim: index rebuild derives linkage, tracks live edits")
try:
    _mk_attempt("P-2", "mmx")  # second live edit on mmx must be refused
    ok = False
except SystemExit:
    ok = True
fail += not ok
print(("ok  " if ok else "FAIL"), "sim: at most one live edit per component")
shutil.rmtree(tmp, ignore_errors=True)

sys.exit(1 if fail else 0)
