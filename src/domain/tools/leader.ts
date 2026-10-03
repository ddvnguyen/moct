/**
 * Leader tools — port of tools/leader.py: register, heartbeat, handoff, pack.
 */
/* eslint-disable complexity, max-depth -- faithful port of mcp-orchestration:
 * control structure mirrors the Python source arm-for-arm; the parity harness
 * (138 same-input cases over MCP stdio) guards behavior, not style metrics. */

import {
  CHECKUP_HISTORY_LIMIT,
  CONTRACT_MIN_VERSION,
  KNOWN_HARNESSES,
  SYSTEM_PROJECT_SLUG,
  newId,
  pyRepr,
  pyTypeName,
  utcnowIso,
  wakeProgress,
} from "../models.js";
import {
  deepTickCron,
  describeCron,
  estimateTokens,
  fleetMap,
  heartbeatTimezone,
  modelAllowed,
  orchestratorCadenceWarning,
  orchestratorCheckupCron,
  orchestratorCheckupMinutes,
  orchestratorCwd,
  orchestratorMaxRuns,
  orchestratorRenewCron,
  orchestratorSeedPrompt,
  orchestratorWakesPerLife,
  ORCHESTRATOR_SEED_PROVIDER as SEED_PROVIDER,
} from "../config.js";
import { heartbeatSpecDump, queueItemDump, workerDump } from "../dump.js";
import { StateError, type Store, type Track } from "../../store/store-interface.js";
import { buildRunbook } from "../runbook.js";
import { ensureCollectorTrack, isSystemTrack, refuseOrchestratorWrite } from "./leader-guards.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseSemver(version: string): [number, number, number] {
  if (typeof version !== "string" || !version.trim()) throw new Error("empty version string");
  const v = version.trim().replace(/^v+/, "").trim();
  const parts = v.split(".");
  if (parts.length !== 3) throw new Error(`expected semver X.Y.Z, got ${pyRepr(version)}`);
  const nums = parts.map((p) => {
    if (!/^[+-]?\d+$/.test(p.trim()))
      throw new Error(`non-numeric semver component in ${pyRepr(version)}`);
    return parseInt(p, 10);
  });
  return [nums[0], nums[1], nums[2]];
}

function semverGte(candidate: string, minimum: string): boolean {
  const [a1, b1, c1] = parseSemver(candidate);
  const [a2, b2, c2] = parseSemver(minimum);
  if (a1 !== a2) return a1 > a2;
  if (b1 !== b2) return b1 > b2;
  return c1 >= c2;
}

function obligations(): string[] {
  return [
    "State-first scan: read track_status + history before acting",
    "Spawn subagents with fleet models via team_catalog (verify live)",
    "Final summary must end with DELIVERABLE / VERDICT / KNOWLEDGE",
    `Heartbeat discipline: ONE ${describeCron(deepTickCron())} deep tick only (${heartbeatTimezone()}) — owner 2026-09-28: no 6-min checkup`,
    "Reconcile lessons + docs (OKF v0.2) on each deep tick / handoff",
  ];
}

const CHECKLIST_STEPS = [
  "1. Finish pre-approved in-flight work (do not start new gated items)",
  "2. Relabel successor role=lead (harness agent label step)",
  "3. Successor runs leader_register with fleet leader model",
  "4. Successor re-creates heartbeats via leader_heartbeat_spec + leader_heartbeat_confirm",
  "5. OUTGOING leader deletes its own heartbeats (paseo) — agent-scoped, nobody can do it for you",
  "6. Archive old lead once idle",
];

// ---------------------------------------------------------------------------
// leader_register
// ---------------------------------------------------------------------------

export async function leaderRegister(
  store: Store,
  trackId: string,
  agentId: string,
  agentModel: string,
  contractVersion: string,
  overrideReason = "",
  harness = "omp",
): Promise<Record<string, unknown>> {
  try {
    return await store.lock(`track-${trackId}`, async () => {
      let track: Track;
      try {
        track = await store.getTrack(trackId);
      } catch (exc) {
        return {
          ok: false,
          error: (exc as Error).message,
          hint: "track not found; verify track_id via track_list",
        };
      }
      if (await isSystemTrack(store, track)) {
        return {
          ok: false,
          error: "the system collector track cannot take a leader",
          hint: `it is system-owned (${SYSTEM_PROJECT_SLUG}); sign a real track instead — track_list marks it system: true`,
        };
      }
      try {
        if (!semverGte(contractVersion, CONTRACT_MIN_VERSION)) {
          return {
            ok: false,
            error: `contract_version ${contractVersion} < required ${CONTRACT_MIN_VERSION}`,
            hint: `upgrade contract to >= ${CONTRACT_MIN_VERSION}`,
          };
        }
      } catch (exc) {
        return {
          ok: false,
          error: `invalid contract_version ${pyRepr(contractVersion)}: ${(exc as Error).message}`,
          hint: `expected semver >= ${CONTRACT_MIN_VERSION}`,
        };
      }
      if (!(KNOWN_HARNESSES as readonly string[]).includes(harness)) {
        return {
          ok: false,
          error: `unknown harness: ${harness}`,
          hint: `known harnesses: ${KNOWN_HARNESSES.join(", ")} (paseo is the dispatch plane, not a harness)`,
        };
      }
      if (track.status !== "active" && track.status !== "handing_off") {
        return {
          ok: false,
          error: `track status ${track.status} does not allow leader registration`,
          hint: "track must be active or handing_off; check track_status",
        };
      }
      if (
        track.leader !== null &&
        track.leader.agent_id !== agentId &&
        track.handoff.state !== "pending"
      ) {
        return {
          ok: false,
          error: "track already has an active leader",
          hint: "wait for handoff or archive current leader; use leader_handoff to transfer",
        };
      }
      const allowed = modelAllowed("leader", agentModel);
      let verified = false;
      let overrideUsed = false;
      if (allowed) {
        verified = true;
      } else if (overrideReason && overrideReason.trim()) {
        verified = false;
        overrideUsed = true;
        try {
          const dec = {
            id: newId("d"),
            ts: utcnowIso(),
            track_id: track.id,
            project_id: track.project_id,
            decision: `leader model override: ${agentModel}`,
            rationale: overrideReason,
            source: "owner-directive",
            irreversible: false,
            author: agentId,
          };
          await store.appendDecision(dec, track.project_id);
          await store.appendEvent(
            {
              ts: utcnowIso(),
              type: "model_verification",
              track_id: track.id,
              project_id: track.project_id,
              payload: {
                model: agentModel,
                verified: false,
                override_reason: overrideReason,
                agent_id: agentId,
              },
            },
            track.project_id,
          );
        } catch (exc) {
          return {
            ok: false,
            error: `failed to record override decision: ${(exc as Error).message}`,
            hint: "check decisions.jsonl write permissions",
          };
        }
      } else {
        const fleet = fleetMap();
        const positions = fleet.positions || {};
        const leaderEntry = positions["leader"] || {};
        const records = [...(leaderEntry.models || []), ...(leaderEntry.fallback || [])];
        const allAllowed = records.map((r) =>
          r !== null && typeof r === "object" ? (r as { model: string }).model : String(r),
        );
        const hintModels = allAllowed.length ? allAllowed.join(", ") : "no models configured";
        return {
          ok: false,
          error: `model ${pyRepr(agentModel)} not allowed for leader`,
          hint: `allowed models: ${hintModels}; or provide override_reason with owner directive`,
        };
      }
      try {
        const binding = {
          agent_id: agentId,
          model: agentModel,
          harness,
          contract_version: contractVersion,
          signed_at: utcnowIso(),
          model_verified: verified,
          override_reason: overrideUsed ? overrideReason : null,
        };
        track.leader = binding;
        if (track.handoff.state === "pending") {
          track.handoff.state = "completed";
          track.handoff.completed_at = utcnowIso();
          track.status = "active";
        }
        await store.saveTrack(track);
        await store.appendEvent(
          {
            ts: utcnowIso(),
            type: "leader_registered",
            track_id: track.id,
            project_id: track.project_id,
            payload: {
              agent_id: agentId,
              model: agentModel,
              verified,
              contract_version: contractVersion,
            },
          },
          track.project_id,
        );
        if (track.handoff.state === "completed") {
          await store.appendEvent(
            {
              ts: utcnowIso(),
              type: "handoff_completed",
              track_id: track.id,
              project_id: track.project_id,
              payload: { new_leader: agentId, from_agent: track.handoff.from_agent },
            },
            track.project_id,
          );
        }
      } catch (exc) {
        return {
          ok: false,
          error: `failed to save leader binding: ${(exc as Error).message}`,
          hint: "check state store permissions",
        };
      }
      let hbSpecs: Record<string, unknown>[] = [];
      try {
        const hbResult = await leaderHeartbeatSpec(store, trackId);
        hbSpecs = hbResult.ok ? (hbResult["specs"] as Record<string, unknown>[]) : [];
      } catch {
        hbSpecs = [];
      }
      let lastTurnsOut: Record<string, unknown>[] = [];
      try {
        const turns = await store.readTurns(track.project_id, track.id);
        const last = turns.length > 5 ? turns.slice(-5) : turns;
        lastTurnsOut = last.map((t) => ({ n: t["n"], summary: t["summary"] ?? "" }));
      } catch {
        lastTurnsOut = [];
      }
      let decisionsRecent: Record<string, unknown>[] = [];
      try {
        const decs = await store.readDecisions(track.project_id);
        const recent = decs.length > 5 ? decs.slice(-5) : decs;
        decisionsRecent = recent.map((d) => ({
          id: d["id"],
          one_liner: String(d["decision"] ?? "").slice(0, 120),
        }));
      } catch {
        decisionsRecent = [];
      }
      const snapshot = {
        id: track.id,
        project_id: track.project_id,
        goal: track.goal,
        status: track.status,
        turn_count: track.turn_count,
        workers: track.workers.map(workerDump),
        queue: track.queue.map(queueItemDump),
      };
      return {
        ok: true,
        track: snapshot,
        heartbeat_specs: hbSpecs,
        last_turns: lastTurnsOut,
        decisions_recent: decisionsRecent,
        obligations: obligations(),
        runbook: buildRunbook(),
      };
    });
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in leader_register: ${(exc as Error).message}`,
      hint: "check store and inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// leader_heartbeat_spec / leader_heartbeat_confirm
// ---------------------------------------------------------------------------

const CREATE_CLI: Record<string, string> = {
  omp: "no omp-native heartbeat CLI — execute via MCP create_heartbeat (agent-scoped); opencode CLI fallback only when the MCP tool is unreachable",
  opencode:
    "no opencode-native heartbeat CLI — execute via MCP create_heartbeat (agent-scoped); omp fallback for probing",
  pi: "no pi-native heartbeat CLI verified — execute via MCP create_heartbeat (agent-scoped)",
};

export async function leaderHeartbeatSpec(
  store: Store,
  trackId: string,
  harness = "omp",
): Promise<Record<string, unknown>> {
  try {
    if (!(KNOWN_HARNESSES as readonly string[]).includes(harness)) {
      return {
        ok: false,
        error: `unknown harness: ${harness}`,
        hint: `known harnesses: ${KNOWN_HARNESSES.join(", ")}`,
      };
    }
    if (harness === "dsh") {
      return {
        ok: false,
        error: "adapter not implemented (P2), see DESIGN.md §8 - harness dsh",
        hint: "use harness='omp' (default), 'opencode' fallback, or 'pi'",
      };
    }
    let track: Track;
    try {
      track = await store.getTrack(trackId);
    } catch (exc) {
      return {
        ok: false,
        error: `track not found: ${trackId}: ${(exc as Error).message}`,
        hint: "verify track_id",
      };
    }
    const createCli = CREATE_CLI[harness];
    const deepPrompt =
      `LEAD DEEP TICK (${describeCron(deepTickCron())}) track ${trackId}: 1) consult quota check: ` +
      `printf '/usage\\n' | timeout 30 claude 2) research/complex-problem work on track goal ` +
      `3) build summary: summary_read(action='spec', track_id='${trackId}') then ` +
      `summary_write(track_id, <your content>) — the summarizer role was removed ` +
      `(owner 2026-09-27), the leader writes it directly ` +
      `4) reconcile lessons + docs (OKF v0.2) 5) end with turn_report.`;
    const deepSpec = {
      step_name: "deep",
      cron: deepTickCron(),
      timezone: heartbeatTimezone(),
      prompt: deepPrompt,
      tool_mcp: "create_heartbeat",
      tool_cli: createCli,
    };
    try {
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "heartbeat_spec_issued",
          track_id: track.id,
          project_id: track.project_id,
          payload: { specs: [heartbeatSpecDump(deepSpec)], harness },
        },
        track.project_id,
      );
    } catch {
      /* best-effort */
    }
    return { ok: true, specs: [heartbeatSpecDump(deepSpec)] };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in leader_heartbeat_spec: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

export async function leaderHeartbeatConfirm(
  store: Store,
  trackId: string,
  checkupId: string,
  deepId: string,
): Promise<Record<string, unknown>> {
  try {
    if (!deepId || !String(deepId).trim()) {
      return {
        ok: false,
        error: "deep_id must be non-empty",
        hint: "provide the id returned by harness after creating the deep heartbeat (checkup_id is optional — leaders run one heartbeat since owner 2026-09-28)",
      };
    }
    let track: Track;
    try {
      track = await store.getTrack(trackId);
    } catch (exc) {
      return {
        ok: false,
        error: `track not found: ${trackId}: ${(exc as Error).message}`,
        hint: "verify track_id",
      };
    }
    if (track.leader === null) {
      return {
        ok: false,
        error: "no leader bound to track; register leader first",
        hint: "call leader_register before heartbeat confirm",
      };
    }
    try {
      return await store.lock(`track-${trackId}`, async () => {
        let locked: Track;
        try {
          locked = await store.getTrack(trackId);
        } catch (exc) {
          return { ok: false, error: (exc as Error).message, hint: "track not found" };
        }
        if (locked.leader === null) {
          return {
            ok: false,
            error: "no leader bound to track; register leader first",
            hint: "call leader_register before heartbeat confirm",
          };
        }
        locked.heartbeats = {
          checkup_id: String(checkupId).trim() || null,
          deep_id: String(deepId).trim(),
          confirmed_at: utcnowIso(),
          schedule_id: null,
          orchestrator_checkup_id: null,
          generation_started_at: null,
          digest_last_written_at: null,
          checkup_history: [],
        };
        await store.saveTrack(locked);
        await store.appendEvent(
          {
            ts: utcnowIso(),
            type: "heartbeat_confirmed",
            track_id: trackId,
            project_id: locked.project_id,
            payload: { checkup_id: checkupId, deep_id: deepId },
          },
          locked.project_id,
        );
        return {
          ok: true,
          heartbeats: {
            checkup_id: locked.heartbeats.checkup_id,
            deep_id: locked.heartbeats.deep_id,
            confirmed_at: locked.heartbeats.confirmed_at,
            schedule_id: null,
            orchestrator_checkup_id: null,
            generation_started_at: null,
            digest_last_written_at: null,
            checkup_history: [],
          },
        };
      });
    } catch (exc) {
      if (exc instanceof StateError)
        return { ok: false, error: (exc as Error).message, hint: "track not found" };
      throw exc;
    }
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in leader_heartbeat_confirm: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// leader_handoff / handoff_pack
// ---------------------------------------------------------------------------

export async function leaderHandoff(
  store: Store,
  trackId: string,
  action = "start",
  toAgentId = "",
  reason = "",
  targetRole = "dev",
  maxTokens = 6000,
): Promise<Record<string, unknown>> {
  if (action === "pack") return handoffPack(store, trackId, targetRole, maxTokens);
  if (action !== "start") {
    return {
      ok: false,
      error: `invalid action ${pyRepr(action)}`,
      hint: "must be one of: start, pack",
    };
  }
  try {
    return await store.lock(`track-${trackId}`, async () => {
      let track: Track;
      try {
        track = await store.getTrack(trackId);
      } catch (exc) {
        return {
          ok: false,
          error: `track not found: ${trackId}: ${(exc as Error).message}`,
          hint: "verify track_id",
        };
      }
      if (track.leader === null) {
        return {
          ok: false,
          error: "no leader bound to track; cannot handoff",
          hint: "register a leader first",
        };
      }
      if (track.handoff.state === "pending") {
        if (toAgentId && toAgentId !== track.handoff.to_agent) {
          track.handoff.to_agent = toAgentId;
          track.handoff.reason = reason || track.handoff.reason;
          await store.saveTrack(track);
          await store.appendEvent(
            {
              ts: utcnowIso(),
              type: "handoff_redirected",
              track_id: track.id,
              project_id: track.project_id,
              payload: { to_agent: toAgentId, reason },
            },
            track.project_id,
          );
          return {
            ok: true,
            handoff: { ...track.handoff },
            checklist: [...CHECKLIST_STEPS],
            redirected: true,
          };
        }
        return {
          ok: true,
          handoff: { ...track.handoff },
          checklist: [...CHECKLIST_STEPS],
          idempotent: true,
        };
      }
      track.handoff = {
        state: "pending",
        from_agent: track.leader.agent_id,
        to_agent: toAgentId ? toAgentId : null,
        reason,
        started_at: utcnowIso(),
        completed_at: null,
      };
      track.status = "handing_off";
      const stale: string[] = [];
      if (track.heartbeats.checkup_id) stale.push(track.heartbeats.checkup_id);
      if (track.heartbeats.deep_id) stale.push(track.heartbeats.deep_id);
      await store.saveTrack(track);
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "handoff_started",
          track_id: track.id,
          project_id: track.project_id,
          payload: {
            from_agent: track.handoff.from_agent,
            to_agent: toAgentId,
            reason,
            stale_heartbeats: stale,
          },
        },
        track.project_id,
      );
      return {
        ok: true,
        handoff: { ...track.handoff },
        checklist: [...CHECKLIST_STEPS],
        stale_heartbeats: stale,
      };
    });
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in leader_handoff: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

export async function handoffPack(
  store: Store,
  trackId: string,
  _targetRole = "dev",
  maxTokens = 6000,
): Promise<Record<string, unknown>> {
  try {
    let track: Track;
    try {
      track = await store.getTrack(trackId);
    } catch (exc) {
      return {
        ok: false,
        error: `track not found: ${trackId}: ${(exc as Error).message}`,
        hint: "verify track_id",
      };
    }
    const goalSection = `## Goal\n${track.goal}\n`;
    let allDecisions: Record<string, unknown>[] = [];
    try {
      allDecisions = await store.readDecisions(track.project_id);
    } catch {
      allDecisions = [];
    }
    let decisionsBody: string;
    if (allDecisions.length) {
      const lines: string[] = [];
      for (const d of allDecisions) {
        const did = d["id"] ?? "";
        const decisionText = d["decision"] ?? "";
        const rationale = d["rationale"] ?? "";
        const source = d["source"] ?? "";
        let entry = `- ${did}: ${decisionText}`;
        if (rationale) entry += ` | rationale: ${rationale}`;
        if (source) entry += ` (source=${source})`;
        lines.push(entry);
      }
      decisionsBody = lines.join("\n");
    } else {
      decisionsBody = "_No decisions recorded._";
    }
    const decisionsSection = `## Decisions (lossless)\n${decisionsBody}\n`;
    const leaderStr = track.leader ? `${track.leader.agent_id} (${track.leader.model})` : "none";
    const hbCheckup = track.heartbeats.checkup_id || "none";
    const hbDeep = track.heartbeats.deep_id || "none";
    let queuePart = `- Queue: ${track.queue.length} items\n`;
    if (track.queue.length) {
      queuePart +=
        track.queue.map((q) => `  - [${q.gate}] ${q.title}: ${q.detail}`).join("\n") + "\n";
    }
    const workersPart =
      `- Workers: ${track.workers.length}` +
      (track.workers.length ? ` (${track.workers.map((w) => w.agent_id).join(", ")})` : " (none)") +
      "\n";
    const currentStatusFull =
      `## Current Status\n` +
      `- Track: ${track.id} (project ${track.project_id})\n` +
      `- Epic: ${track.epic}\n` +
      `- Status: ${track.status}\n` +
      `- Leader: ${leaderStr}\n` +
      `- Turn count: ${track.turn_count}\n` +
      workersPart +
      queuePart +
      `- Heartbeats: checkup=${hbCheckup}, deep=${hbDeep}\n` +
      `- Handoff: ${track.handoff.state}\n` +
      `- Updated: ${track.updated_at}\n`;
    const currentStatusCompressed =
      `## Current Status\n` +
      `Status: ${track.status} | Leader: ${leaderStr} | Turns: ${track.turn_count} | ` +
      `Queue: ${track.queue.length} | Workers: ${track.workers.length}\n`;
    let turns: Record<string, unknown>[] = [];
    try {
      turns = await store.readTurns(track.project_id, track.id);
    } catch {
      turns = [];
    }
    const recent = turns.length > 5 ? turns.slice(-5) : turns;
    const turnLines = recent.length
      ? recent.map((t) => `- n=${t["n"]}: ${t["summary"] ?? ""}`).join("\n")
      : "_No turns yet._";
    const recentTurnsSection = `## Recent Turns (last 5)\n${turnLines}\n`;
    const taskBriefSection =
      `## Task Brief Skeleton\n` +
      `1. Verify state first: read track_status + orchestration.md and reconcile with server state\n` +
      `2. Work the queue: dispatch ready non-GPU items, poll GPU, hold gated until decision\n` +
      `3. End with turn_report (include done/next/blockers/decisions/knowledge)\n`;
    const sectionsOrder = [
      "goal",
      "decisions",
      "current_status",
      "recent_turns",
      "task_brief_skeleton",
    ];
    const content: Record<string, string> = {
      goal: goalSection,
      decisions: decisionsSection,
      current_status: currentStatusFull,
      recent_turns: recentTurnsSection,
      task_brief_skeleton: taskBriefSection,
    };
    const goalDecisionsTokens = estimateTokens(content["goal"] + content["decisions"]);
    let maxTok: unknown = maxTokens;
    if (typeof maxTok === "boolean") maxTok = maxTok ? 1 : 0;
    if (typeof maxTok !== "number" || goalDecisionsTokens > (maxTok as number)) {
      if (typeof maxTok !== "number") {
        throw new TypeError(
          `'>' not supported between instances of 'int' and '${pyTypeName(maxTok)}'`,
        );
      }
      return {
        ok: false,
        error: "decisions alone exceed budget",
        decisions_tokens: goalDecisionsTokens,
        hint: "raise max_tokens",
      };
    }
    const included = [...sectionsOrder];
    const dropped: string[] = [];
    const totalTokens = () => estimateTokens(included.map((k) => content[k]).join("\n\n"));
    let total = totalTokens();
    if (total > maxTok && included.includes("recent_turns")) {
      included.splice(included.indexOf("recent_turns"), 1);
      dropped.push("recent_turns");
      total = totalTokens();
    }
    if (total > maxTok && included.includes("task_brief_skeleton")) {
      included.splice(included.indexOf("task_brief_skeleton"), 1);
      dropped.push("task_brief_skeleton");
      total = totalTokens();
    }
    if (total > maxTok && included.includes("current_status")) {
      content["current_status"] = currentStatusCompressed;
      total = totalTokens();
    }
    const packText = included.map((k) => content[k]).join("\n\n");
    const tokens = estimateTokens(packText);
    return {
      ok: true,
      pack: packText,
      tokens,
      sections_included: [...included],
      sections_dropped: [...dropped],
    };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in handoff_pack: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

export function leaderRunbook(): Record<string, unknown> {
  return { ok: true, runbook: buildRunbook() };
}

// ---------------------------------------------------------------------------
// heartbeat (merged, role-neutral)
// ---------------------------------------------------------------------------

export async function heartbeat(
  store: Store,
  trackId = "",
  action = "spec",
  role = "leader",
  harness = "omp",
  checkupId = "",
  deepId = "",
  scheduleId = "",
): Promise<Record<string, unknown>> {
  if (role !== "leader" && role !== "orchestrator") {
    return {
      ok: false,
      error: `invalid role ${pyRepr(role)}`,
      hint: "must be one of: leader, orchestrator",
    };
  }
  if (action !== "spec" && action !== "confirm") {
    return {
      ok: false,
      error: `invalid action ${pyRepr(action)}`,
      hint: "must be one of: spec, confirm",
    };
  }
  if (role === "leader") {
    if (!String(trackId).trim()) {
      return {
        ok: false,
        error: "track_id must be non-empty",
        hint: "leader heartbeat timers belong to a leader's track; list ids with track_list",
      };
    }
    if (action === "spec") return leaderHeartbeatSpec(store, trackId, harness);
    return leaderHeartbeatConfirm(store, trackId, checkupId, deepId);
  }
  if (!String(trackId).trim()) {
    try {
      const track = await ensureCollectorTrack(store);
      trackId = track.id;
    } catch (exc) {
      if (exc instanceof StateError) {
        return {
          ok: false,
          error: `failed to provision the system collector track: ${(exc as Error).message}`,
          hint: "check the state store and the reserved project name",
        };
      }
      return {
        ok: false,
        error: `failed to provision the system collector track: ${(exc as Error).message}`,
        hint: "check state store permissions",
      };
    }
  } else {
    const refusal = await refuseOrchestratorWrite(store, trackId, "heartbeat");
    if (refusal !== null) return refusal;
  }
  if (action === "spec") return orchestratorScheduleSpec(store, trackId);
  return orchestratorScheduleConfirm(store, trackId, scheduleId, checkupId);
}

async function orchestratorScheduleSpec(
  store: Store,
  trackId: string,
): Promise<Record<string, unknown>> {
  let track: Track;
  try {
    track = await store.getTrack(trackId);
  } catch (exc) {
    return {
      ok: false,
      error: `track not found: ${trackId}: ${(exc as Error).message}`,
      hint: "verify track_id",
    };
  }
  const prompt = orchestratorSeedPrompt();
  const schedule = {
    name: "mcp-orchestrator",
    cron: orchestratorRenewCron(),
    max_runs: orchestratorMaxRuns(),
    target: "new-agent",
    provider: `omp/${SEED_PROVIDER}`,
    cwd: orchestratorCwd(),
    archive_on_finish: false,
  };
  const cadence = {
    renew_cron: orchestratorRenewCron(),
    checkup_cron: orchestratorCheckupCron(),
    checkup_minutes: orchestratorCheckupMinutes(),
    wakes_per_life: orchestratorWakesPerLife(),
  };
  const steps = [
    {
      step: "seed_orchestrator_schedule",
      tool_mcp: "create_schedule",
      args: { name: schedule.name, cron: schedule.cron, provider: schedule.provider, prompt },
      why: "D1: system seeds, never the leader; every tick is a fresh agent = clean context by construction",
    },
    {
      step: "seed_orchestrator_schedule_cli",
      tool_cli: `paseo schedule create --cron "${schedule.cron}" "<seed_prompt from this response>"`,
      why: "CLI parity (paseo plugin paseo-orchestration does this idempotently)",
    },
    {
      step: "create_orchestrator_checkup",
      tool_mcp: "create_heartbeat",
      args: {
        cron: cadence.checkup_cron,
        maxRuns: cadence.wakes_per_life,
        timezone: heartbeatTimezone(),
        name: "orchestrator-checkup",
        prompt:
          "ORCHESTRATOR CHECKUP: read track_status.orchestrator.wakes_remaining. If > 1, do a narrow poll and finish. If == 1, run the full collection and write the digest.",
      },
      why: "agent-scoped in-life checkup; needs archiveOnFinish: false",
      execute_from: "the ORCHESTRATOR's own session",
    },
  ];
  try {
    await store.appendEvent(
      {
        ts: utcnowIso(),
        type: "heartbeat_spec_issued",
        project_id: track.project_id,
        track_id: track.id,
        payload: {
          role: "orchestrator",
          cron: schedule.cron,
          schedule_name: schedule.name,
          checkup_cron: cadence.checkup_cron,
          wakes_per_life: cadence.wakes_per_life,
        },
      },
      track.project_id,
    );
  } catch {
    /* spec emission must not fail on ledger hiccups */
  }
  return {
    ok: true,
    role: "orchestrator",
    schedule,
    cadence,
    seed_prompt: prompt,
    steps,
    cadence_warning: orchestratorCadenceWarning(),
    hint: "the seed_prompt's BOOT step 2 is the confirm a generation runs: heartbeat(role=orchestrator, action=confirm, checkup_id=<its own id>), no track_id and no schedule_id — the server records it on the system collector track",
  };
}

async function orchestratorScheduleConfirm(
  store: Store,
  trackId: string,
  scheduleId = "",
  checkupId = "",
): Promise<Record<string, unknown>> {
  const schedule = String(scheduleId).trim();
  const checkup = String(checkupId).trim();
  if (!schedule && !checkup) {
    return {
      ok: false,
      error: "schedule_id or checkup_id must be non-empty",
      hint: "pass checkup_id=<the id your own heartbeat returned>; schedule_id is optional (the seeded schedule's id is the system's to record, not yours to look up)",
    };
  }
  try {
    await store.getTrack(trackId);
  } catch (exc) {
    return {
      ok: false,
      error: `track not found: ${trackId}: ${(exc as Error).message}`,
      hint: "verify track_id",
    };
  }
  try {
    const locked = await store.lock(`track-${trackId}`, async () => {
      const inner = await store.getTrack(trackId);
      if (schedule) inner.heartbeats.schedule_id = schedule;
      const history = [...(inner.heartbeats.checkup_history || [])];
      let stale: boolean;
      if (checkup && history.includes(checkup)) {
        stale = true;
      } else if (checkup && inner.heartbeats.orchestrator_checkup_id !== checkup) {
        inner.heartbeats.generation_started_at = utcnowIso();
        inner.heartbeats.orchestrator_checkup_id = checkup;
        history.push(checkup);
        history.splice(0, Math.max(0, history.length - CHECKUP_HISTORY_LIMIT));
        inner.heartbeats.checkup_history = history;
        stale = false;
      } else {
        stale = false;
      }
      if (!stale) {
        await store.saveTrack(inner);
        await store.appendEvent(
          {
            ts: utcnowIso(),
            type: "heartbeat_confirmed",
            project_id: inner.project_id,
            track_id: inner.id,
            payload: {
              role: "orchestrator",
              schedule_id: inner.heartbeats.schedule_id,
              checkup_id: inner.heartbeats.orchestrator_checkup_id,
              stale_generation: stale,
              generation_started_at: inner.heartbeats.generation_started_at,
            },
          },
          inner.project_id,
        );
      }
      return { locked: inner, stale };
    });
    const now = utcnowIso();
    const result: Record<string, unknown> = {
      ok: true,
      track: {
        id: locked.locked.id,
        project_id: locked.locked.project_id,
        epic: locked.locked.epic,
      },
      heartbeats: {
        checkup_id: locked.locked.heartbeats.checkup_id,
        deep_id: locked.locked.heartbeats.deep_id,
        confirmed_at: locked.locked.heartbeats.confirmed_at,
        schedule_id: locked.locked.heartbeats.schedule_id,
        orchestrator_checkup_id: locked.locked.heartbeats.orchestrator_checkup_id,
        generation_started_at: locked.locked.heartbeats.generation_started_at,
        digest_last_written_at: locked.locked.heartbeats.digest_last_written_at,
        checkup_history: [...locked.locked.heartbeats.checkup_history],
      },
      cadence: wakeProgress(
        locked.locked.heartbeats.generation_started_at,
        now,
        orchestratorCheckupMinutes(),
        orchestratorWakesPerLife(),
      ),
    };
    if (locked.stale) {
      result["stale_generation"] = true;
      result["note"] =
        "this checkup_id was confirmed before, so it is a generation that woke after its successor; nothing was stamped and the wake budget belongs to the current generation";
    }
    return result;
  } catch (exc) {
    return { ok: false, error: `failed to confirm schedule: ${(exc as Error).message}` };
  }
}
