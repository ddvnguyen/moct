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

sys.exit(1 if fail else 0)
