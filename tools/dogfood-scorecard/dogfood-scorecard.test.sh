#!/usr/bin/env bash
# dogfood-scorecard.test.sh — M-577 seeded verification.
#
# Offline: no network, no board, no multica CLI. A synthetic fixture is replayed
# through the same build_report the live run uses, then the real entry point is
# exercised with --fixture so argument parsing, file output and determinism are
# covered end to end. Exits non-zero on the first failed assertion.
set -euo pipefail
cd "$(dirname "$0")"
tmp="$(mktemp -d "$PWD/.test-tmp.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
python3 - "$tmp" <<'PY'
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys

sys.dont_write_bytecode = True  # loading the script must not leave __pycache__
tmp = sys.argv[1]
loader = importlib.machinery.SourceFileLoader("scorecard", "./dogfood-scorecard")
spec = importlib.util.spec_from_loader("scorecard", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)

failures = []


def check(name, cond, detail=""):
    if cond:
        print("ok   %s" % name)
    else:
        print("FAIL %s %s" % (name, detail))
        failures.append(name)


def usage_row(i, o, cr, cw, model="m1"):
    return {
        "input_tokens": i,
        "output_tokens": o,
        "cache_read_tokens": cr,
        "cache_write_tokens": cw,
        "model": model,
        "provider": "p1",
    }


def init_ctx(memory_tokens):
    return {
        "parts": [
            {"part": "instructions", "tokens": 100, "measured": True, "budget": 4000},
            {"part": "memory", "tokens": memory_tokens, "measured": True, "budget": 6000},
        ]
    }


fixture = {
    "issues": {
        "M-1": {"id": "id-1", "identifier": "M-1", "title": "first",
                "metadata": {"role_pilot": json.dumps(
                    {"arm": "role", "pct": 30, "bucket": 3, "reason": None})}},
        "M-2": {"id": "id-2", "identifier": "M-2", "title": "second",
                "metadata": {"role_pilot": json.dumps(
                    {"arm": "named", "pct": 30, "bucket": 77, "reason": None})}},
        "M-3": {"id": "id-3", "identifier": "M-3", "title": "third", "metadata": {}},
        "M-4": {"id": "id-4", "identifier": "M-4", "title": "fourth",
                "metadata": {"role_pilot": json.dumps(
                    {"arm": "named", "pct": 30, "bucket": 5, "reason": "role_offline"})}},
    },
    "runs": {
        "M-1": [
            {
                "id": "r1",
                "status": "completed",
                "attempt": 1,
                "agent_id": "a1",
                "trigger_evidence_kind": "comment",
                "started_at": "2026-11-26T01:00:00Z",
                "usage": [usage_row(10, 100, 1000, 50)],
                "result": {"init_context": init_ctx(368)},
            },
            {
                "id": "r2",
                "status": "failed",
                "attempt": 2,
                "agent_id": "a2",
                "trigger_evidence_kind": "delegated_failure",
                "started_at": "2026-11-26T02:00:00Z",
                "usage": [usage_row(20, 200, 2000, 60)],
                "result": {},
            },
            {
                "id": "r3-outside",
                "status": "completed",
                "attempt": 1,
                "agent_id": "a1",
                "trigger_evidence_kind": "issue_wakeup",
                "started_at": "2026-11-25T23:00:00Z",
                "usage": [usage_row(999, 999, 999, 999)],
                "result": {"init_context": init_ctx(999)},
            },
            {
                "id": "r4",
                "status": "completed",
                "attempt": 1,
                "agent_id": "a1",
                "trigger_evidence_kind": "delegated_failure",
                "started_at": "2026-11-26T03:00:00Z",
                "usage": [],
                "result": {"init_context": init_ctx(0)},
            },
        ],
        "M-2": [],
        "M-3": [],
        "M-4": [],
    },
    "usage": {
        "M-1": {
            "cost_usd_ticks": 1234,
            "metered_task_count": 2,
            "task_count": 3,
            "unreported_task_count": 1,
        },
        "M-2": {"cost_usd_ticks": 0, "metered_task_count": 0, "task_count": 0, "unreported_task_count": 0},
        "M-3": {"cost_usd_ticks": 0, "metered_task_count": 0, "task_count": 0, "unreported_task_count": 0},
        "M-4": {"cost_usd_ticks": 0, "metered_task_count": 0, "task_count": 0, "unreported_task_count": 0},
    },
    "comments": {
        "M-1": [
            {"id": "c-agent", "author_type": "agent", "created_at": "2026-11-26T01:15:00Z"},
            {"id": "c-owner", "author_type": "member", "created_at": "2026-11-26T01:30:00Z"},
            {"id": "c-old", "author_type": "member", "created_at": "2026-11-25T22:00:00Z"},
        ],
        "M-2": [{"id": "c-lonely", "author_type": "member", "created_at": "2026-11-26T05:00:00Z"}],
        "M-3": [],
        "M-4": [],
    },
    "questions": {
        "M-1": [
            {"id": "q1", "answered_by_type": "member", "answered_at": "2026-11-26T02:30:00.123456789Z"},
            {"id": "q-old", "answered_by_type": "member", "answered_at": "2026-11-25T23:30:00Z"},
            {"id": "q-open", "answered_by_type": "", "answered_at": None},
            {"id": "q-agent", "answered_by_type": "agent", "answered_at": "2026-11-26T02:45:00Z"},
        ],
        "M-2": [],
        "M-3": [],
        "M-4": [],
    },
    "run_messages": {
        "r1": [
            {"type": "tool_use", "tool": "memory_search", "seq": 1},
            {"type": "tool_result", "tool": "memory_search", "seq": 2},
            {"type": "tool_use", "tool": "mcp__moct__memory_search", "seq": 3},
            {"type": "tool_use", "tool": "Bash", "seq": 4},
            {"type": "tool_use", "tool": "mcp__moct__memory_note", "seq": 5},
            {"type": "tool_use", "tool": "mcp__other__memory_get", "seq": 6},
        ],
        "r2": [],
        "r4": [],
    },
    "agents": [
        {"id": "a1", "name": "Role One", "subtype": "role"},
        {"id": "a2", "name": "Agent Two", "subtype": "agent"},
    ],
}

cards = [{"identifier": "M-1", "note": "a"}, {"identifier": "M-2", "note": "b"}]
window = mod.Window(mod.parse_ts("2026-11-26T00:00:00Z"), mod.parse_ts("2026-11-27T00:00:00Z"))
source = mod.FixtureSource(fixture)
report = mod.build_report(source, cards, window)
by_id = {card["identifier"]: card for card in report["cards"]}
one, two = by_id["M-1"], by_id["M-2"]

# --- runs and tokens -------------------------------------------------------
check("runs-total", one["runs"]["total"] == 3, one["runs"])
check("runs-completed", one["runs"]["completed"] == 2, one["runs"])
check("runs-failed", one["runs"]["failed"] == 1, one["runs"])
check("runs-retried", one["runs"]["retried"] == 1, one["runs"])
check("runs-delegated-failure", one["runs"]["after_delegated_failure"] == 2, one["runs"])
check("window-excludes-run", one["tokens"]["input"] == 30, one["tokens"])
check("tokens-output", one["tokens"]["output"] == 300, one["tokens"])
check("tokens-cache", one["tokens"]["cache_read"] == 3000 and one["tokens"]["cache_write"] == 110, one["tokens"])
check("tokens-models", one["tokens"]["models"] == ["m1"], one["tokens"]["models"])

# --- MOCT inject -----------------------------------------------------------
check("memory-runs-with-report", one["memory_inject"]["runs_with_report"] == 2, one["memory_inject"])
check("memory-runs-without-report", one["memory_inject"]["runs_without_report"] == 1, one["memory_inject"])
check("memory-tokens", one["memory_inject"]["tokens_total"] == 368, one["memory_inject"])
check("memory-mean", one["memory_inject"]["tokens_mean"] == 184.0, one["memory_inject"])

# --- on-demand memory tools ------------------------------------------------
check("memory-calls", one["memory_tools"]["calls"] == 3, one["memory_tools"])
check(
    "memory-calls-by-tool",
    one["memory_tools"]["by_tool"] == {"memory_note": 1, "memory_search": 2},
    one["memory_tools"],
)
check("memory-runs-with-calls", one["memory_tools"]["runs_with_calls"] == 1, one["memory_tools"])

# --- owner latency ---------------------------------------------------------
check("latency-samples", one["owner_latency"]["samples"] == 2, one["owner_latency"])
check("latency-median", one["owner_latency"]["median_seconds"] == 1800.0, one["owner_latency"])
check("latency-max", one["owner_latency"]["max_seconds"] == 1800, one["owner_latency"])
check("latency-kinds", sorted(p["kind"] for p in one["owner_latency"]["pairs"]) == ["comment", "question"])
check("latency-no-next-run", two["owner_latency"]["samples"] == 0, two["owner_latency"])

# --- cost: lifetime, never windowed ---------------------------------------
check("cost-scope", one["cost"]["scope"] == "card-lifetime", one["cost"])
check("cost-ticks", one["cost"]["cost_usd_ticks"] == 1234, one["cost"])

# --- totals and agents -----------------------------------------------------
check("totals-runs", report["totals"]["runs"]["total"] == 3, report["totals"])
check("totals-tokens", report["totals"]["tokens"]["output"] == 300, report["totals"])
check("totals-latency", report["totals"]["owner_latency"]["samples"] == 2, report["totals"])
agents = report["agents"]
check("agents-active", agents["active"] == 2, agents)
check("agents-roles", agents["roles"] == 1 and agents["named"] == 1, agents)
check("agents-sorted", [a["name"] for a in agents["list"]] == ["Agent Two", "Role One"], agents["list"])

# --- unavailable is named, not invented -----------------------------------
names = [gap["metric"] for gap in report["unavailable"]]
check("unavailable-cost", "cost_per_card_window" in names, names)
check("unavailable-agents", "active_agents_workspace" in names, names)

# --- determinism -----------------------------------------------------------
first = json.dumps(report, sort_keys=True, ensure_ascii=False)
second = json.dumps(mod.build_report(source, cards, window), sort_keys=True, ensure_ascii=False)
check("deterministic-json", first == second)

# --- markdown --------------------------------------------------------------
markdown = mod.render_markdown(report)
check("markdown-has-card", "| M-1 |" in markdown, markdown[:200])
check("markdown-has-total", "| **total** |" in markdown, markdown[:200])
check("markdown-has-unavailable", "`cost_per_card_window`" in markdown, markdown[-400:])

# --- M-588 B1b: --by-arm grouping -----------------------------------------
check("by-arm-off-by-default", "by_arm" not in report and "## By arm" not in markdown)

arm_cards = cards + [
    {"identifier": "M-3", "note": "c"},
    {"identifier": "M-4", "note": "d"},
]
arm_report = mod.build_report(source, arm_cards, window, by_arm=True)
arm_by_id = {card["identifier"]: card for card in arm_report["cards"]}
check("arm-role-label", arm_by_id["M-1"]["arm"] == "role"
      and arm_by_id["M-1"]["arm_label"] == "role", arm_by_id["M-1"].get("arm"))
check("arm-control-label", arm_by_id["M-2"]["arm_label"] == "named (control)",
      arm_by_id["M-2"].get("arm_label"))
check("arm-pre-pilot-label", arm_by_id["M-3"]["arm_label"] == "pre-pilot",
      arm_by_id["M-3"].get("arm_label"))
check("arm-fallback-label", arm_by_id["M-4"]["arm_label"] == "named (fallback: intended role)",
      arm_by_id["M-4"].get("arm_label"))
check("arm-turns", arm_by_id["M-1"]["turns"] == 5, arm_by_id["M-1"].get("turns"))

groups = arm_report["by_arm"]["groups"]
check("by-arm-three-groups", sorted(groups) == ["named", "pre-pilot", "role"], sorted(groups))
check("by-arm-cards", [groups[n]["cards"] for n in ("role", "named", "pre-pilot")] == [1, 2, 1],
      {n: groups[n]["cards"] for n in groups})
check("by-arm-fallback-count", groups["named"]["fallback"] == 1 and groups["named"]["control"] == 1,
      groups["named"])
check("by-arm-role-runs", groups["role"]["runs"] == 3 and groups["role"]["failed"] == 1,
      groups["role"])
check("by-arm-turns-per-card", groups["role"]["turns"] == 5
      and groups["role"]["turns_per_card"] == 5.0, groups["role"])
check("by-arm-cost", groups["role"]["cost_usd_ticks"] == 1234
      and groups["named"]["cost_missing_cards"] == 0, groups["named"])
check("by-arm-definition", "fallback" in arm_report["by_arm"]["definition"]
      and "pre-pilot" in arm_report["by_arm"]["definition"], arm_report["by_arm"]["definition"])

arm_markdown = mod.render_markdown(arm_report)
check("by-arm-markdown-table", "## By arm" in arm_markdown, arm_markdown[-600:])
check("by-arm-markdown-named", "named (control 1 / fallback 1)" in arm_markdown, arm_markdown[-600:])
check("by-arm-markdown-column", "| Card | Arm |" in arm_markdown, arm_markdown[:300])
check("by-arm-deterministic",
      json.dumps(arm_report, sort_keys=True, ensure_ascii=False)
      == json.dumps(mod.build_report(source, arm_cards, window, by_arm=True),
                    sort_keys=True, ensure_ascii=False))

# --- a missing card is an error, not a zero --------------------------------
missing = mod.summarize_card(mod.FixtureSource({}), {"identifier": "M-404", "note": ""}, window)
check("missing-card-unresolved", missing["resolved"] is False, missing)
check("missing-card-error", any("fixture-miss" in e for e in missing["errors"]), missing["errors"])

# --- window rules ----------------------------------------------------------
check("window-one-day", mod.resolve_window("2026-11-26", None, None).to_json()["days"] == 1.0)
try:
    mod.resolve_window(None, "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z")
    check("window-rejects-long", False, "no error")
except mod.ScorecardError:
    check("window-rejects-long", True)
try:
    mod.resolve_window("2026-11-26", "2026-11-26T00:00:00Z", None)
    check("window-rejects-mixed", False, "no error")
except mod.ScorecardError:
    check("window-rejects-mixed", True)

# --- real entry point over --fixture (arg parsing, files, determinism) -----
fixture_path = os.path.join(tmp, "fixture.json")
cards_path = os.path.join(tmp, "cards.json")
with open(fixture_path, "w", encoding="utf-8") as handle:
    json.dump(fixture, handle)
with open(cards_path, "w", encoding="utf-8") as handle:
    json.dump({"version": 1, "cards": cards}, handle)

out_one = os.path.join(tmp, "out1")
out_two = os.path.join(tmp, "out2")
base = [sys.executable, "./dogfood-scorecard", "--fixture", fixture_path, "--cards", cards_path, "--date", "2026-11-26"]
proc = subprocess.run(base + ["--out-dir", out_one], capture_output=True, text=True)
check("cli-exit", proc.returncode == 0, proc.stderr)
written = os.path.join(out_one, "scorecard-2026-11-26.json")
check("cli-json-file", os.path.exists(written), proc.stderr)
check("cli-md-file", os.path.exists(os.path.join(out_one, "scorecard-2026-11-26.md")), proc.stderr)
with open(written, "r", encoding="utf-8") as handle:
    on_disk = json.load(handle)
check("cli-json-shape", on_disk["tool"] == "dogfood-scorecard" and len(on_disk["cards"]) == 2, on_disk.get("tool"))

proc2 = subprocess.run(base + ["--out-dir", out_two], capture_output=True, text=True)
check("cli-second-exit", proc2.returncode == 0, proc2.stderr)
with open(written, "rb") as handle:
    bytes_one = handle.read()
with open(os.path.join(out_two, "scorecard-2026-11-26.json"), "rb") as handle:
    bytes_two = handle.read()
check("cli-byte-identical", bytes_one == bytes_two)

proc3 = subprocess.run(base + ["--out-dir", out_one, "--stdout"], capture_output=True, text=True)
check("cli-stdout-json", proc3.returncode == 0 and json.loads(proc3.stdout)["tool"] == "dogfood-scorecard", proc3.stderr)

arm_cards_path = os.path.join(tmp, "arm-cards.json")
with open(arm_cards_path, "w", encoding="utf-8") as handle:
    json.dump({"version": 1, "cards": arm_cards}, handle)
proc_arm = subprocess.run(
    [sys.executable, "./dogfood-scorecard", "--fixture", fixture_path,
     "--cards", arm_cards_path, "--date", "2026-11-26", "--by-arm", "--stdout",
     "--out-dir", os.path.join(tmp, "out-arm")],
    capture_output=True, text=True)
arm_cli = json.loads(proc_arm.stdout) if proc_arm.returncode == 0 else {}
check("cli-by-arm", proc_arm.returncode == 0 and "by_arm" in arm_cli, proc_arm.stderr)
check("cli-by-arm-cards", len(arm_cli.get("cards", [])) == 4
      and all("arm_label" in card for card in arm_cli.get("cards", [])), arm_cli.get("tool"))

proc4 = subprocess.run([sys.executable, "./dogfood-scorecard", "--date", "2026-11-26", "--since", "2026-11-26T00:00:00Z"], capture_output=True, text=True)
check("cli-rejects-mixed", proc4.returncode == 2, proc4.returncode)

print("")
if failures:
    print("%d failure(s): %s" % (len(failures), ", ".join(failures)))
    sys.exit(1)
print("all dogfood-scorecard checks passed")
PY
