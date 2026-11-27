#!/usr/bin/env python3
"""Seeded checks for mmx-scan detection rules (M-606). No network.

Run: python3 -I tools/mmx-scan/mmx-scan.test.py
"""
import importlib.machinery
import importlib.util
import os
import sys

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

sys.exit(1 if fail else 0)
