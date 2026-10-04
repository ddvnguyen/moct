/**
 * Leader runbook — port of runbook.py (canonical operating procedure).
 * {deep_label} renders at CALL time from live timings.
 */
import { deepTickCron, describeCron } from "./config.js";

export const RUNBOOK_VERSION = "1.11.0";

const SKILL_REFERENCE = {
  name: "epic-track-leader",
  locations: [
    "<repo>/.agents/skills/epic-track-leader/SKILL.md",
    "~/.agents/skills/epic-track-leader/SKILL.md",
  ],
  canonical_source: "mcp-orchestration/skills/epic-track-leader/SKILL.md (symlinked, never copied)",
  contract:
    "the skill is a thin trigger (~250 tokens); THIS runbook is the single source of the operating procedure — on version mismatch, the MCP wins",
};

const RUNBOOK: Record<string, unknown> = {
  version: RUNBOOK_VERSION,
  skill_reference: SKILL_REFERENCE,
  principles: [
    "Response prefix (binding, owner 2026-09-15): EVERY reply starts with `[#Leader]` as the first line — ticks, reports, handoffs, answers. No prefix = not a leader reply.",
    "Harness set (binding, owner 2026-09-16): harnesses are omp (default), opencode (fallback), pi, dsh (P2 stub). Paseo is the orchestration/dispatch plane (create_agent / send_agent_prompt / archive_agent) — never a harness value, never a session to spawn fleet children on.",
    "Dispatch ONLY by paseo tool (binding, owner 2026-09-15): every subagent via create_agent / send_agent_prompt / archive_agent; bare-CLI spawns are fallback-only when the MCP is unreachable, never OMP/opencode sessions.",
    "Worktree rule (binding, owner 2026-09-27; tightened owner 2026-10-03): any task needing an isolated checkout uses paseo `create_worktree` (worktreeSlug / branchName / baseBranch) and attaches agents via the returned workspaceId — NEVER `git worktree add`, in ANY location (no path carve-outs; the old '/tmp or ad-hoc' phrasing wrongly implied other paths were allowed). paseo keeps agent folders under the configured worktrees root (workspace/worktree/<slug>), organized and re-importable, and provisions their MCP config (.mcp.json): an ad-hoc git worktree has none, which silently leaves a session without orchestration MCP tools (observed 2026-10-03, leader session forced to REST fallback).",
    'State-first: read track_status + history(type="event", track_id) before acting; never act on stale state.',
    "The server never acts for you: agent-scoped actions (heartbeats, spawns) are returned as exact steps for YOU to execute.",
    'Models come from the registry ONLY (fleet(mode="catalog") / fleet(mode="spawn")) — never bake model ids into files.',
    'Zero-trust usage: you observe paseo (count running agents per model/family), then report it with fleet_usage(action="report", usage=<those counts>).',
    "Reuse before respawn (binding, owner 2026-09-18, cutoff raised 2026-09-30): same position + same track -> `paseo send` the existing agent; fresh spawn ONLY when none live or its ctx > 200K. Applies to EVERY position — fresh-per-tick spawns are wasted tokens, because a worker's init context and what it learned (file map, failing test names, ruled-out dead ends) is not recoverable by a fresh spawn.",
    "COMPACT <=3 THEN RESPAWN (binding, owner 2026-09-30): an agent may compact its own context up to 3 times — compaction buys tokens, not judgment. After the 3rd compaction the reuse path is CLOSED: create a NEW agent with a self-contained brief and archive the compacted one. Never reuse a compacted-3x agent; never compact a 4th time.",
    "WRONG-DIRECTION -> KILL (binding, owner 2026-09-30): a worker PAST the 200K reuse cutoff whose work is visibly going nowhere is killed (`kill_agent`), not nudged a third time. Observable signals, any ONE is enough and all must be things a tick can SEE: the same fix applied then REVERTED twice; edits landing outside the brief's declared scope; ctx climbing with no commit/test/file to show for it; the `DELIVERABLE:` block restating the brief instead of answering it; stated acceptance criteria silently dropped; re-deriving a conclusion it already reached. KILL is not ARCHIVE: archive is the 12h idle sweep (done or abandoned, slot cleanup); kill means the agent is STILL RUNNING and its next turn will make it worse — stop the session, then archive. Never archive a live worker you mean to stop. The LEADER decides alone: the agent cannot kill itself, and never the orchestrator — its duty ends at flagging. When in doubt prefer a fresh-agent handoff over a kill — a kill discards a run you might still reuse.",
    "ORCHESTRATOR FLAGS, LEADER ACTS (binding intent, owner 2026-09-30, NOT YET IMPLEMENTED — the collector ships in a later task H2; do not act as though these flags exist yet): oversight of oversize / compacted-3x / wrong-direction agents is ALSO the orchestrator's job. It surfaces them as flags in what you already see — ON TAKEOVER (a new leader inherits the watch immediately) and EACH TICK — and its duty ENDS at flagging: it never kills, never archives, never respawns. YOU ACT on every flag via the rules above. Two failure modes: treating a flag as already actioned, and treating the absence of a flag as an all-clear. Until H2 lands, run this same check by hand on takeover and each tick.",
    "AUTO-PERMISSION for dispatched subagents (binding, owner 2026-09-30): READ the spawn spec's `caveats` array (a summary, not a control); `settings.features.auto_accept` at create is the PRIMARY mechanism; run `ensure_scoped_workspace` BEFORE create_agent (else strip `settings.features` and answer prompts by hand) and `verify_scoped_workspace` AFTER `verify_auto_permission` (else revoke auto_accept and escalate); you then run `verify_auto_permission` yourself (get_agent_status; if false, ONE leader-issued update_agent, then ONE re-read; still false -> escalate to the owner, never loop). The subagent never repairs its own flag, and a self-issued write is not reliable — re-verify after any LATER settings write to that agent. _meta['paseo/requireApproval'] is documented for the ACP/freebuff host path but UNVERIFIED for opencode auto_accept — do not rely on it as an escape hatch. Scope: DISPATCHED SUBAGENTS in scoped worktrees, NEVER your own session; you still answer prompts that slip through — allow once for reads/test runs inside YOUR worktree, stop and ask the owner for writes outside it, PROD paths (~/paseo/PROD, live orchestration state), push/merge, or credentials. A worker stalled on a prompt is a defect, not a state. PER-HARNESS HONESTY: auto-permission is the STATED INTENT for every harness, but what is ENFORCED TODAY is narrower — `opencode` is the ONLY harness with a real feature (settings.features.auto_accept, verified); `omp` and `claude` reach the same end via their permissive MODE through `set_mode`, which is not a feature; `pi` has neither and keeps the prompt fallback. Do not promise a stalled prompt away on `pi`, and do not treat permissive mode as the feature.",
    "Consult source (binding, owner 2026-09-18): the owner-provided consult agent first (`paseo send`); a separate consult dispatch ONLY when the owner provided none.",
    "Quota (binding, owner 2026-10-01): leaders read quota ONLY to decide whether claude-code consult models are usable this turn. Quota figures (percentages, minutes, caps) NEVER appear in turn_report, summaries, or user-facing messages — availability is reported as usable / not-usable only.",
    "Same-project dispatch (binding, owner 2026-10-01): dispatch subagents into the SAME project/workspace by default — attach to an existing workspace; create a NEW worktree ONLY when the task requires isolation (concurrent same-file edits). Not every agent needs its own worktree.",
    "Idle/stuck -> ask the USER (binding, owner 2026-10-01): nothing in queue OR blocked -> raise the problem/question with the session ask tool (ask_followup_question), never coast through heartbeat turns with no real effect (the ask tool is what lets the harness block you). Track FINISHED (queue empty, all done/verified) -> ask the owner to CLOSE the track (recommend + evidence; d-21 gate still applies). Track BLOCKED and unresolved after a consult check -> ask the question (state what was checked, what is needed). Waiting on RUNNING work -> GO IDLE and poll (that has real effect).",
  ],
  phases: [
    {
      id: "takeover",
      title: "Takeover checklist (run once, in order)",
      steps: [
        'track_status + history(type="event", track_id) — understand in-flight work before touching anything',
        "If a handoff is pending for you: leader_register (completes the handoff automatically)",
        'heartbeat(action="spec", role="leader") -> create BOTH heartbeats agent-scoped to YOUR session (paseo create_heartbeat) -> heartbeat(action="confirm", role="leader", checkup_id, deep_id)',
        "Label yourself via paseo update_agent: role=lead, project=<name>, epic=<epic>",
        "If YOU are the outgoing leader: delete YOUR OWN heartbeats (paseo) before idling — agent-scoped, nobody can delete them for you",
        "Archive the old leader agent ONLY once errored/idle and your heartbeats are confirmed",
        "AGENT WATCH (owner 2026-09-30): on takeover, scan every live worker for oversize (ctx past 200K), compacted-3x, and wrong-direction — act on each. Until the orchestrator ships these as flags (H2), you run this check by hand; do not skip it because you expect a flag.",
        "End with turn_report, then GO IDLE (heartbeats wake you)",
      ],
    },
    {
      id: "turn",
      title: "Every turn (checkup or event wake-up)",
      steps: [
        'START: track_status + latest history(type="event", track_id)',
        "ACT: one concern per turn — advance queue, dispatch ONE ready item, or poll a running one",
        "AGENT WATCH (owner 2026-09-30): each tick, act on any oversize / compacted-3x / wrong-direction flag you are shown (reuse below 200K, fresh agent after 3 compactions, KILL a wrong-direction agent past 200K). Absent a flag is NOT an all-clear until H2 ships the collector — spot-check a worker or two. Reuse (`paseo send`) before respawn; a fresh spawn discards the worker's learned context.",
        'SPAWN loop: fleet(mode="recommend", position, usage=<observed counts>, live=true) -> fleet(mode="spawn", position) -> execute args_mcp exactly (its settings carry the subagent\'s auto-permission request) -> apply post_spawn_steps IN ORDER (set_mode / concurrency_cap / set_thinking / verify_auto_permission LAST — it is the guarantee, not the request) -> fleet_usage(action="report", usage=<observed counts>) after spawn',
        "END: turn_report (delta <= 1000 tokens — the server enforces it; leaders keep reports ~500 tokens, owner 2026-10-03), final message ends with DELIVERABLE / VERDICT / KNOWLEDGE",
        "IDLE/STUCK (owner 2026-10-01): empty queue or blocked -> raise it with the session ask tool (ask_followup_question) — finished -> suggest close to the owner; blocked after a consult check -> send the question. Never coast on no-effect heartbeat turns (see the Idle/stuck principle). Waiting on RUNNING work -> GO IDLE (polling has real effect).",
      ],
    },
    {
      id: "heartbeats",
      title: "Heartbeat turns",
      steps: [
        'deep ({deep_label}): SINGLE heartbeat (owner 2026-09-28 — no 6-min checkup): consult AVAILABILITY check (claude consult usable this turn? — availability yes/no ONLY, never quota figures, owner 2026-10-01); research on track goal; rebuild orchestration.md (summary_read(action="spec", track_id) -> write the content -> summary_write(track_id, content) -> summary_read(action="diff", track_id); summarizer role removed owner 2026-09-27); reconcile lessons + docs',
      ],
    },
    {
      id: "close",
      title: "Close gate (queue empty -> verified -> owner question -> close)",
      steps: [
        "TRIGGER: queue empty AND every task done/verified. Do NOT call track_close yet.",
        "1) Spawn ONE review via fleet(mode=\"spawn\", 'review') — reviewer reviews the PR diff against acceptance; fix every finding, re-verify (cheap fleet pass first; the PR is the review surface).",
        "2) ONE consult with the architect lens — architect consult reviews the PR diff; `paseo send` the owner-provided consult agent when one is attached (owner's agent first); spawn separate via fleet(mode=\"spawn\", 'consult') ONLY when none provided; message discipline is binding (one-shot briefs, NO-ANSWER when nothing to say, max 2 turns — consult-delegation quiet section); record BOTH verdicts via turn_report(decision=...).",
        "3) Both clean -> end the turn with an explicit close-request QUESTION to the owner via the session ask/question tool (`ask_followup_question` — never plain chat text; state recommendation + option tradeoffs in the tool call) with review + architect verdicts, PR link, DELIVERABLE / VERDICT / KNOWLEDGE. NEVER track_close unilaterally.",
        "4) track_close ONLY after the owner confirms AND the PR is merged/approved (d-21 gate unchanged). Any finding at any step -> back to turn phase.",
      ],
    },
    {
      id: "handoff",
      title: "Handoff / takeover protocol",
      steps: [
        'Planned: leader_handoff(action="start", track_id, to_agent_id, reason) -> successor registers (completes state machine) -> your heartbeats go stale -> DELETE YOUR OWN heartbeats (paseo, agent-scoped) -> successor re-creates theirs -> you are archived once idle',
        "Redirect while pending: leader_handoff again with the new to_agent (allowed, journaled)",
        "Crashed pre-MCP leader: register it as HISTORICAL BINDING (override_reason = provenance) -> leader_handoff -> register yourself (pattern proven on track t-8d42fb7e63 turn 1)",
      ],
    },
  ],
  budgets: {
    turn_report_delta_tokens: 1000,
    orchestration_md_tokens: "4000-8000",
    leader_handoff_default_tokens: 6000,
  },
  tool_index: {
    'fleet(mode="catalog")':
      "registry: positions x models (tier, quality_index, priority, provider_arg)",
    'fleet(mode="spawn")':
      "EXACT paseo create_agent command for a position (leader position refused)",
    'fleet(mode="recommend")':
      "quota/concurrency-aware model pick (usage + quota are YOUR observations; live=true reads the last reported snapshot)",
    'fleet_usage(action="report")': "record observed running-agent counts {model_or_family: count}",
    'fleet_usage(action="get")': "read last usage snapshot + freshness",
    turn_report:
      "file your turn (delta budget enforced); with decision=... it files the lossless decision ledger entry",
    'history(type="event" | "turn" | "decision" | "all")':
      "state-first reading (turn needs track_id; event/decision need track_id or project_id)",
    "track_status / track_list": "current track state",
    leader_register: "sign the contract (completes a pending handoff)",
    'heartbeat(action="spec")': "get exact heartbeat prompts/crons to create",
    'heartbeat(action="confirm")': "bind your created heartbeat ids",
    'leader_handoff(action="start")': "start/redirect the handoff state machine",
    'leader_handoff(action="pack")': "resume bundle for the successor",
    "summary_read / summary_write":
      'orchestration.md pipeline (deep tick): summary_read(action="spec") for the spec -> summary_write(track_id, content) to commit -> summary_read(action="diff") against state',
  },
};

export function buildRunbook(): Record<string, unknown> {
  const runbook = JSON.parse(JSON.stringify(RUNBOOK)) as Record<string, unknown>;
  const labels = { deep_label: describeCron(deepTickCron()) };
  for (const phase of runbook["phases"] as Record<string, unknown>[]) {
    if (phase["id"] === "heartbeats") {
      phase["steps"] = (phase["steps"] as string[]).map((step) =>
        step.split("{deep_label}").join(labels.deep_label),
      );
      break;
    }
  }
  return runbook;
}
