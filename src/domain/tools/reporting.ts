/**
 * Reporting tools — port of tools/reporting.py: turn deltas, decisions,
 * history queries, track views, evaluations.
 */
/* eslint-disable complexity, max-depth -- faithful port of mcp-orchestration:
 * control structure mirrors the Python source arm-for-arm; the parity harness
 * (138 same-input cases over MCP stdio) guards behavior, not style metrics. */

import {
  TURN_DELTA_TOKEN_MAX,
  estimateTokens,
  orchestratorCheckupCron,
  orchestratorCheckupMinutes,
  orchestratorRenewCron,
  orchestratorWakesPerLife,
} from "../config.js";
import { leaderDump, queueItemDump, scoresDump, workerDump, workerEvalDump } from "../dump.js";
import {
  DECISION_SOURCES,
  EVENT_TYPES,
  TASK_GATES,
  TASK_STATUSES,
  TURN_STATUSES,
  ageSeconds,
  newId,
  pyInt,
  pyJoin,
  pyList,
  pyRepr,
  pyStr,
  pyTruthy,
  pyTypeName,
  utcnowIso,
  wakeProgress,
} from "../models.js";
import { StateError, makeRowFilter, type Store } from "../../store/store-interface.js";
import { systemTrackIds } from "./leader-guards.js";
import { refuseOrchestratorWrite, refuseSystemTrackWrite } from "./leader-guards.js";
import {
  asInt,
  parseEventTypes,
  validateEvaluationArgs,
  validateEvaluationDict,
  validateModelScores,
  validateModelScoresFields,
  validateTelemetry,
  windowCutoff,
} from "../validate.js";

// ---------------------------------------------------------------------------
// shared arg helpers
// ---------------------------------------------------------------------------

function orEmpty(v: unknown): string {
  return pyTruthy(v) ? (v as string) : "";
}

function stripOrThrow(v: unknown): string {
  if (!v) return "";
  if (typeof v !== "string") throw new Error(`'${pyTypeName(v)}' object has no attribute 'strip'`);
  return v.trim();
}

/** `(d.get("decision", "") or "")[:100]` with CPython falsiness + errors. */
function oneLiner(d: Record<string, unknown>): string {
  const raw = "decision" in d ? (d["decision"] ?? "") : "";
  return pySlice(pyTruthy(raw) ? (raw as string) : "", 100);
}

/** str floor slice with CPython subscript errors. */
function pySlice(v: unknown, end: number): string {
  if (typeof v !== "string") throw new TypeError(`'${pyTypeName(v)}' object is not subscriptable`);
  return v.slice(0, end);
}

// ---------------------------------------------------------------------------
// turn_report
// ---------------------------------------------------------------------------

export async function turnReport(
  store: Store,
  trackId: string,
  summary: string,
  status = "running",
  done: unknown = null,
  next: unknown = null,
  blockers: unknown = null,
  decisions: unknown = null,
  knowledgeLessonTopic = "",
  knowledgeDocsUpdated: unknown = null,
  authorAgent = "",
  authorModel = "",
  task = "",
  role = "",
  decision = "",
  decisionRationale = "",
  decisionSource = "leader",
  irreversible: unknown = false,
  evaluation: unknown = null,
  pr = "",
  artifacts: unknown = null,
): Promise<Record<string, unknown>> {
  const doneList = pyTruthy(done) ? done : [];
  const nextList = pyTruthy(next) ? next : [];
  const blockersList = pyTruthy(blockers) ? blockers : [];
  const decisionsList = pyTruthy(decisions) ? decisions : [];
  const docsUpdated = pyTruthy(knowledgeDocsUpdated) ? knowledgeDocsUpdated : [];
  let track;
  try {
    track = await store.getTrack(trackId);
  } catch (exc) {
    return { ok: false, error: (exc as Error).message, hint: "track not found" };
  }
  if (role === "orchestrator") {
    const refusal = await refuseOrchestratorWrite(store, trackId, "turn_report");
    if (refusal !== null) return refusal;
  }
  if (!track.leader) {
    return { ok: false, error: "track has no leader", hint: "register leader first" };
  }
  if (task && !authorAgent) {
    return {
      ok: false,
      error: "author_agent required when task is set",
      hint: "the worker passes its own agent id as author_agent",
    };
  }
  if (!authorAgent) authorAgent = track.leader.agent_id;
  if (!summary)
    return { ok: false, error: "summary must be non-empty", hint: "provide a summary <=50 words" };
  if (typeof summary !== "string")
    throw new Error(`'${pyTypeName(summary)}' object has no attribute 'strip'`);
  if (!summary.trim())
    return { ok: false, error: "summary must be non-empty", hint: "provide a summary <=50 words" };
  if (!(TURN_STATUSES as readonly string[]).includes(status)) {
    return {
      ok: false,
      error: `invalid status ${pyRepr(status)}`,
      hint: `must be one of ${pyRepr([...TURN_STATUSES].sort())}`,
    };
  }
  const tokenText = summary + " " + pyJoin(" ", doneList) + " " + pyJoin(" ", nextList);
  const nTokens = estimateTokens(tokenText);
  if (nTokens > TURN_DELTA_TOKEN_MAX) {
    return {
      ok: false,
      error: `turn delta token estimate ${nTokens} exceeds limit ${TURN_DELTA_TOKEN_MAX}`,
      hint: `reduce summary/done/next to under ${TURN_DELTA_TOKEN_MAX} tokens (~${TURN_DELTA_TOKEN_MAX * 4} chars); leaders aim ~500`,
    };
  }
  const n = await store.nextTurnNumber(track.project_id, track.id);
  const delta = {
    n,
    ts: utcnowIso(),
    summary: summary.trim(),
    status,
    done: pyList(doneList),
    next: pyList(nextList),
    blockers: pyList(blockersList),
    decisions: pyList(decisionsList),
    knowledge: {
      lesson_topic: knowledgeLessonTopic || null,
      docs_updated: pyList(docsUpdated),
    },
    author_agent: authorAgent,
    author_model: authorModel,
  };
  try {
    if (status === "blocked") track.status = "blocked";
    else if (status === "handing_off") track.status = "handing_off";
    else if (status === "running" || status === "idle") track.status = "active";
    track.turn_count = n;
    await store.saveTrack(track);
    await store.saveTurn(track.project_id, track.id, delta);
    await store.appendEvent(
      {
        ts: utcnowIso(),
        type: "turn_reported",
        project_id: track.project_id,
        track_id: track.id,
        payload: { n, status, summary: pySlice(summary, 120) },
      },
      track.project_id,
    );
  } catch (exc) {
    return { ok: false, error: `failed to save turn: ${(exc as Error).message}` };
  }
  const out: Record<string, unknown> = {
    ok: true,
    turn: n,
    md_rebuild_hint:
      "call summary_read(action=spec) then write the content yourself and summary_write (summarizer role removed owner 2026-09-27)",
  };
  if (task) {
    const workerStatus =
      ({ blocked: "blocked", idle: "done", running: "partial" } as Record<string, string>)[
        status
      ] ?? "partial";
    const res = await workerReport(
      store,
      trackId,
      authorAgent,
      task,
      summary.trim(),
      role || "dev",
      authorModel,
      workerStatus,
      evaluation,
      pr,
      pyTruthy(artifacts) ? pyList(artifacts) : [],
    );
    if (!res["ok"]) return res;
    out["worker_reported"] = true;
  }
  if (decision) {
    const res = await decisionRecord(
      store,
      trackId,
      decision,
      decisionRationale,
      decisionSource,
      irreversible,
      authorAgent,
    );
    if (!res["ok"]) return res;
    out["decision_id"] = res["decision_id"];
  }
  return out;
}

// ---------------------------------------------------------------------------
// decision_record (internal, also used by suggestion_review process path)
// ---------------------------------------------------------------------------

export async function decisionRecord(
  store: Store,
  trackId: string,
  decision: string,
  rationale = "",
  source = "leader",
  irreversible: unknown = false,
  author = "",
): Promise<Record<string, unknown>> {
  if (!(DECISION_SOURCES as readonly string[]).includes(source)) {
    return {
      ok: false,
      error: `invalid source ${pyRepr(source)}`,
      hint: `must be one of ${pyRepr([...DECISION_SOURCES].sort())}`,
    };
  }
  if (!decision) return { ok: false, error: "decision must be non-empty" };
  if (typeof decision !== "string" || !decision.trim()) {
    if (typeof decision !== "string")
      throw new Error(`'${pyTypeName(decision)}' object has no attribute 'strip'`);
    return { ok: false, error: "decision must be non-empty" };
  }
  let track;
  try {
    track = await store.getTrack(trackId);
  } catch (exc) {
    return { ok: false, error: (exc as Error).message };
  }
  assertStr(rationale, "rationale");
  assertStr(author, "author");
  const dec = {
    id: newId("d"),
    ts: utcnowIso(),
    track_id: track.id,
    project_id: track.project_id,
    decision,
    rationale: orEmpty(rationale),
    source,
    irreversible: pyTruthy(irreversible),
    author: orEmpty(author),
  };
  try {
    await store.appendDecision(dec, track.project_id);
    await store.appendEvent(
      {
        ts: utcnowIso(),
        type: "decision_recorded",
        project_id: track.project_id,
        track_id: track.id,
        payload: { decision_id: dec.id, source, irreversible },
      },
      track.project_id,
    );
  } catch (exc) {
    return { ok: false, error: `failed to record decision: ${(exc as Error).message}` };
  }
  return { ok: true, decision_id: dec.id };
}

function assertStr(v: unknown, _field: string): void {
  if (v !== null && v !== undefined && typeof v !== "string") {
    throw new Error(`Input should be a valid string`);
  }
}

// ---------------------------------------------------------------------------
// worker_report (internal, merged into turn_report)
// ---------------------------------------------------------------------------

export async function workerReport(
  store: Store,
  trackId: string,
  agentId: string,
  task: string,
  summary: string,
  role = "dev",
  model = "",
  status = "done",
  evaluation: unknown = null,
  pr = "",
  artifacts: unknown = null,
): Promise<Record<string, unknown>> {
  const refusal = await refuseSystemTrackWrite(store, trackId, "worker_report");
  if (refusal !== null) return refusal;
  try {
    if (!agentId || !task || !summary) {
      return { ok: false, error: "agent_id, task, summary are required" };
    }
    if (status !== "done" && status !== "blocked" && status !== "partial") {
      return {
        ok: false,
        error: `invalid status ${pyRepr(status)}`,
        hint: "one of: done, blocked, partial",
      };
    }
    const [evalObj, evalErr] = validateEvaluationDict(evaluation);
    if (evalErr !== null) return evalErr;
    let track;
    try {
      track = await store.getTrack(trackId);
    } catch (exc) {
      return {
        ok: false,
        error: `track not found: ${trackId}: ${(exc as Error).message}`,
        hint: "ask the leader for the track_id",
      };
    }
    await store.lock(`track-${trackId}`, async () => {
      const now = utcnowIso();
      const existing = track.workers.find((w) => w.agent_id === agentId) ?? null;
      if (existing !== null) {
        existing.status = status;
        if (evalObj !== null) existing.evaluation = evalObj;
      } else {
        track.workers.push({
          agent_id: agentId,
          role,
          model,
          dispatched_at: now,
          status,
          evaluation: evalObj,
        });
      }
      await store.saveTrack(track);
      const payload: Record<string, unknown> = {
        agent_id: agentId,
        role,
        model,
        task,
        summary,
        status,
        pr,
        artifacts: pyTruthy(artifacts) ? pyList(artifacts) : [],
        reported_at: now,
      };
      if (evalObj !== null) {
        payload["evaluation"] = {
          confidence: evalObj.confidence,
          effectiveness: evalObj.effectiveness,
          guideline_adherence: evalObj.guideline_adherence,
          task_complexity: evalObj.task_complexity,
          task_size: evalObj.task_size,
          notes: evalObj.notes,
          telemetry: evalObj.telemetry ? { ...evalObj.telemetry } : null,
        };
      }
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "worker_reported",
          track_id: track.id,
          project_id: track.project_id,
          payload,
        },
        track.project_id,
      );
    });
    return {
      ok: true,
      recorded: true,
      hint: "paseo notifyOnFinish wakes the leader; it verifies via track_status/history_events",
    };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in worker_report: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// history_events / history_turns / history_decisions
// ---------------------------------------------------------------------------

export async function historyEvents(
  store: Store,
  trackId = "",
  projectId = "",
  eventType = "",
  since = "",
  limit: unknown = 50,
  offset: unknown = 0,
  now = "",
): Promise<Record<string, unknown>> {
  let resolvedProject = projectId ? stripOrThrow(projectId) : "";
  if (!resolvedProject && trackId) {
    try {
      const tr = await store.getTrack(trackId);
      resolvedProject = tr.project_id;
    } catch (exc) {
      return { ok: false, error: (exc as Error).message };
    }
  }
  if (!resolvedProject) return { ok: false, error: "project_id or track_id required" };
  let lim: number;
  try {
    lim = pyInt(limit);
  } catch {
    lim = 50;
  }
  if (lim < 1) lim = 1;
  if (lim > 200) lim = 200;
  const off = Math.max(0, asInt(offset, 0));
  const requestedTypes = parseEventTypes(eventType);
  const unknownTypes = requestedTypes.filter((t) => !EVENT_TYPES.has(t));
  if (unknownTypes.length) {
    return {
      ok: false,
      // NOTE: the {…!r} conversion applies to the whole conditional
      // expression, so single unknowns are repr-quoted too.
      error: `unknown event_type ${unknownTypes.length === 1 ? pyRepr(unknownTypes[0]) : pyRepr(unknownTypes)}`,
      hint: "omit event_type to read every type, or pass one or more comma-separated types from valid_event_types (see EVENT_TYPES in state/models.py)",
      valid_event_types: [...EVENT_TYPES].sort(),
    };
  }
  const filter = makeRowFilter({
    types: requestedTypes.length ? new Set(requestedTypes) : null,
    trackIds: trackId ? new Set([trackId]) : null,
    since: since || null,
  });
  let collected: Record<string, unknown>[];
  try {
    collected = await store.tailEvents(resolvedProject, lim, off, filter);
  } catch (exc) {
    return { ok: false, error: `failed to read events: ${(exc as Error).message}` };
  }
  const clock = now || utcnowIso();
  for (const ev of collected) {
    if (ev !== null && typeof ev === "object") ev["age_s"] = ageSeconds(ev["ts"] as string, clock);
  }
  return { ok: true, now: clock, count: collected.length, events: collected };
}

export async function historyTurns(
  store: Store,
  trackId: string,
  limit: unknown = 10,
  offset: unknown = 0,
  since = "",
  now = "",
): Promise<Record<string, unknown>> {
  let lim: number;
  try {
    lim = pyInt(limit);
  } catch {
    lim = 10;
  }
  if (lim < 1) lim = 1;
  if (lim > 100) lim = 100;
  let off: number;
  try {
    off = pyInt(offset);
  } catch {
    off = 0;
  }
  if (off < 0) off = 0;
  let track;
  try {
    track = await store.getTrack(trackId);
  } catch (exc) {
    return { ok: false, error: (exc as Error).message };
  }
  let turns: Record<string, unknown>[];
  try {
    turns = await store.readTurnsPaged(track.project_id, track.id, lim, off, since || null);
  } catch (exc) {
    if (exc instanceof StateError) return { ok: false, error: (exc as Error).message };
    return { ok: false, error: `failed to read turns: ${(exc as Error).message}` };
  }
  const clock = now || utcnowIso();
  for (const tn of turns) {
    if (tn !== null && typeof tn === "object") {
      const tsPick = pyTruthy(tn["ts"]) ? (tn["ts"] as string) : (tn["reported_at"] as string);
      tn["age_s"] = ageSeconds(tsPick, clock);
    }
  }
  return { ok: true, now: clock, count: turns.length, turns };
}

export async function historyDecisions(
  store: Store,
  trackId = "",
  projectId = "",
  offset: unknown = 0,
  limit: unknown = 0,
  since = "",
  now = "",
  withAge = false,
): Promise<Record<string, unknown>> {
  let resolvedProject = projectId ? stripOrThrow(projectId) : "";
  const filterTrack = trackId ? stripOrThrow(trackId) : "";
  if (!resolvedProject && filterTrack) {
    try {
      const tr = await store.getTrack(filterTrack);
      resolvedProject = tr.project_id;
    } catch (exc) {
      return { ok: false, error: (exc as Error).message };
    }
  }
  if (!resolvedProject) return { ok: false, error: "project_id or track_id required" };
  const off = Math.max(0, asInt(offset, 0));
  const lim = Math.max(0, asInt(limit, 0));
  try {
    const filter = makeRowFilter({
      trackIds: filterTrack ? new Set([filterTrack]) : null,
      since: since || null,
    });
    let collected = await store.streamDecisions(resolvedProject, filter);
    if (off) collected = collected.slice(off);
    if (lim) collected = collected.slice(0, lim);
    if (withAge) {
      const clock = now || utcnowIso();
      for (const row of collected) {
        if (row !== null && typeof row === "object")
          row["age_s"] = ageSeconds(row["ts"] as string, clock);
      }
    }
    return { ok: true, count: collected.length, decisions: collected };
  } catch (exc) {
    return { ok: false, error: `failed to read decisions: ${(exc as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// track_status
// ---------------------------------------------------------------------------

const RECENT_EVENTS_LIMIT = 50;
const RECENT_TASKS_LIMIT = 25;
const RECENT_TURNS_LIMIT = 10;
const RECENT_DECISIONS_LIMIT = 25;
const RECENT_WORKERS_LIMIT = 10;

const RECENT_WORKER_KEYS = new Set([
  "agent_id",
  "role",
  "model",
  "task",
  "summary",
  "status",
  "pr",
  "artifacts",
  "evaluation",
  "reported_at",
]);

async function recentBlock(
  store: Store,
  track: {
    id: string;
    project_id: string;
  },
  now: string,
  sinceMinutes: number,
): Promise<Record<string, unknown>> {
  const cutoff = windowCutoff(sinceMinutes, now);
  const pid = track.project_id;
  const tid = track.id;
  const errors: string[] = [];
  async function tail(
    types: Set<string> | null,
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    return store.tailEvents(
      pid,
      limit,
      0,
      makeRowFilter({ trackIds: new Set([tid]), types, since: cutoff || null }),
    );
  }
  async function bucket(
    label: string,
    read: () => Promise<Record<string, unknown>[]>,
  ): Promise<Record<string, unknown>[]> {
    try {
      return await read();
    } catch (exc) {
      errors.push(`${label}: ${(exc as Error).message}`);
      return [];
    }
  }
  const taskEvents = await bucket("task_updates", () =>
    tail(new Set(["task_updated"]), RECENT_TASKS_LIMIT),
  );
  const workerEvents = await bucket("worker_reports", () =>
    tail(new Set(["worker_reported", "worker_evaluated"]), RECENT_WORKERS_LIMIT),
  );
  const rawEvents = await bucket("events", () => tail(null, RECENT_EVENTS_LIMIT));
  const turnRows = await bucket("turn_reports", () =>
    store.readTurnsPaged(pid, tid, RECENT_TURNS_LIMIT, 0, cutoff || null),
  );
  const decisionRows = await bucket("decisions", () =>
    store.streamDecisions(pid, makeRowFilter({ trackIds: new Set([tid]), since: cutoff || null })),
  );
  const taskUpdates = taskEvents.map((event) => {
    const rawPayload = "payload" in event ? event["payload"] : {};
    const payload =
      rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
        ? (rawPayload as Record<string, unknown>)
        : {};
    return {
      ts: "ts" in event ? (event["ts"] ?? "") : "",
      age_s: ageSeconds(event["ts"] as string, now),
      task_id: payload["task_id"] ?? "",
      title: payload["title"] ?? "",
      changes: "changes" in payload ? payload["changes"] : {},
      by: payload["by"] ?? "",
    };
  });
  const workerReports = workerEvents.map((e) => {
    const rawPayload = "payload" in e ? e["payload"] : {};
    const payload =
      rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
        ? (rawPayload as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {
      ts: "ts" in e ? (e["ts"] ?? "") : "",
      age_s: ageSeconds(e["ts"] as string, now),
      type: "type" in e ? (e["type"] ?? "") : "",
    };
    for (const [k, v] of Object.entries(payload)) {
      if (RECENT_WORKER_KEYS.has(k)) out[k] = v;
    }
    return out;
  });
  const events = rawEvents.map((e) => ({
    ts: "ts" in e ? (e["ts"] ?? "") : "",
    age_s: ageSeconds(e["ts"] as string, now),
    type: "type" in e ? (e["type"] ?? "") : "",
    track_id: "track_id" in e ? e["track_id"] : null,
    payload: "payload" in e ? (e["payload"] ?? {}) : {},
  }));
  const turnReports = turnRows
    .filter((row) => row !== null && typeof row === "object")
    .map((row) => Object.assign({}, row, { age_s: ageSeconds(row["ts"] as string, now) }));
  const newestDecisions = [...decisionRows]
    .slice(-RECENT_DECISIONS_LIMIT)
    .toReversed()
    .map((row) => Object.assign({}, row, { age_s: ageSeconds(row["ts"] as string, now) }));
  const block: Record<string, unknown> = {
    since_minutes: sinceMinutes,
    since: cutoff,
    now,
    task_updates: taskUpdates,
    turn_reports: turnReports,
    decisions: newestDecisions,
    worker_reports: workerReports,
    events,
    order: "newest-first",
    scope: "this track only (track_id equality, no project-level rows)",
    caps: {
      task_updates: RECENT_TASKS_LIMIT,
      turn_reports: RECENT_TURNS_LIMIT,
      decisions: RECENT_DECISIONS_LIMIT,
      worker_reports: RECENT_WORKERS_LIMIT,
      events: RECENT_EVENTS_LIMIT,
    },
    truncated: {
      task_updates: taskEvents.length >= RECENT_TASKS_LIMIT,
      turn_reports: turnReports.length >= RECENT_TURNS_LIMIT,
      decisions: decisionRows.length > RECENT_DECISIONS_LIMIT,
      worker_reports: workerEvents.length >= RECENT_WORKERS_LIMIT,
      events: rawEvents.length >= RECENT_EVENTS_LIMIT,
    },
    counts: {
      task_updates: taskUpdates.length,
      turn_reports: turnReports.length,
      decisions: newestDecisions.length,
      worker_reports: workerReports.length,
      events: events.length,
    },
    note: "status/progress/note rows carry the NEW value only - no previous value - so this block is a change LOG, not a diff; join current state (or track_status.tasks[].note) to know what a value was before. The ONE exception is a body amendment: those rows carry changes.previous_detail and the task's detail_amendments trail.",
  };
  if (errors.length) block["errors"] = errors;
  return block;
}

function taskQueryBlock(
  track: {
    queue: {
      id: string;
      title: string;
      detail: string;
      gate: string;
      status: string;
      progress: number;
      assignee: string;
      added_at: string;
      updated_at: string;
      note: string;
      detail_amendments: Record<string, unknown>[];
    }[];
  },
  now: string,
  status: string,
  gate: string,
  assignee: string,
  sinceMinutes: unknown,
  limit: unknown,
  offset: unknown,
): Record<string, unknown> {
  if (status && !(TASK_STATUSES as readonly string[]).includes(status)) {
    return {
      ok: false,
      error: `invalid task_status ${pyRepr(status)}`,
      hint: "one of: " + TASK_STATUSES.join(" | "),
    };
  }
  if (gate && !(TASK_GATES as readonly string[]).includes(gate)) {
    return {
      ok: false,
      error: `invalid task_gate ${pyRepr(gate)}`,
      hint: "one of: " + TASK_GATES.join(" | "),
    };
  }
  let off: number;
  try {
    off = Math.max(0, pyInt(offset));
  } catch {
    off = 0;
  }
  let lim: number;
  try {
    lim = Math.max(0, pyInt(limit));
  } catch {
    lim = 0;
  }
  let cutoff: string;
  try {
    cutoff = windowCutoff(sinceMinutes, now);
  } catch {
    return {
      ok: false,
      error: `invalid task_since_minutes ${pyRepr(sinceMinutes)}`,
      hint: "pass a number of minutes, or omit it for no time filter",
    };
  }
  const total = track.queue.length;
  const matched = track.queue.filter(
    (item) =>
      (!status || item.status === status) &&
      (!gate || item.gate === gate) &&
      (!assignee || item.assignee === assignee) &&
      (!cutoff || (item.updated_at || "") >= cutoff),
  );
  let page = off ? matched.slice(off) : matched;
  if (lim) page = page.slice(0, lim);
  return {
    ok: true,
    filters: { status, gate, assignee, since_minutes: sinceMinutes },
    since: cutoff,
    order: "queue order",
    offset: off,
    limit: lim,
    total,
    matched: matched.length,
    count: page.length,
    tasks: page.map((item) =>
      Object.assign(queueItemDump(item), { age_s: ageSeconds(item.updated_at, now) }),
    ),
    note: "each row carries the CURRENT note and detail_amendments (the body-revision trail, oldest first); `detail` is the current body. Notes are also in recent.task_updates[].changes.note.",
  };
}

export async function trackStatus(
  store: Store,
  trackId: string,
  sinceMinutes: unknown = 0,
  taskStatus = "",
  taskGate = "",
  taskAssignee = "",
  taskSinceMinutes: unknown = 0,
  taskLimit: unknown = 0,
  taskOffset: unknown = 0,
): Promise<Record<string, unknown>> {
  const now = utcnowIso();
  let track;
  try {
    track = await store.getTrack(trackId);
  } catch (exc) {
    return { ok: false, error: (exc as Error).message };
  }
  let trackEventsSorted: Record<string, unknown>[] = [];
  let workerReports: Record<string, unknown>[] = [];
  let turnEvents: Record<string, unknown>[] = [];
  try {
    trackEventsSorted = await store.tailEvents(
      track.project_id,
      10,
      0,
      makeRowFilter({ trackIds: new Set([trackId]), includeNullTrack: true }),
    );
    const workerEvents = await store.tailEvents(
      track.project_id,
      5,
      0,
      makeRowFilter({
        trackIds: new Set([trackId]),
        types: new Set(["worker_reported", "worker_evaluated"]),
      }),
    );
    workerReports = workerEvents.map((e) => {
      const rawPayload = "payload" in e ? e["payload"] : {};
      const payload =
        rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
          ? (rawPayload as Record<string, unknown>)
          : {};
      const out: Record<string, unknown> = { ts: "ts" in e ? (e["ts"] ?? "") : "" };
      for (const k of [
        "agent_id",
        "role",
        "model",
        "task",
        "summary",
        "status",
        "pr",
        "artifacts",
        "evaluation",
      ]) {
        if (k in payload) out[k] = payload[k];
      }
      return out;
    });
    turnEvents = await store.tailEvents(
      track.project_id,
      1,
      0,
      makeRowFilter({ trackIds: new Set([trackId]), types: new Set(["turn_reported"]) }),
    );
  } catch {
    const events = await store.readEvents(track.project_id).catch(() => []);
    const trackEvents = events.filter((e) => e["track_id"] === trackId || e["track_id"] === null);
    trackEventsSorted = [...trackEvents].sort((a, b) =>
      cmpStr(String(a["ts"] ?? ""), String(b["ts"] ?? "")),
    );
    workerReports = trackEventsSorted
      .filter((e) => e["type"] === "worker_reported" || e["type"] === "worker_evaluated")
      .slice(0, 5)
      .map((e) => {
        const rawPayload = e["payload"];
        const payload =
          rawPayload !== null && typeof rawPayload === "object" && !Array.isArray(rawPayload)
            ? (rawPayload as Record<string, unknown>)
            : {};
        const out: Record<string, unknown> = { ts: "ts" in e ? (e["ts"] ?? "") : "" };
        for (const k of [
          "agent_id",
          "role",
          "model",
          "task",
          "summary",
          "status",
          "pr",
          "artifacts",
          "evaluation",
        ]) {
          if (k in payload) out[k] = payload[k];
        }
        return out;
      });
    turnEvents = trackEventsSorted.filter((e) => e["type"] === "turn_reported").slice(0, 1);
  }
  const recentEventsRaw = trackEventsSorted.slice(0, 10);
  const recentEvents = recentEventsRaw.map(
    (e) =>
      `${pyStr("ts" in e ? (e["ts"] ?? "") : "")} ${pyStr("type" in e ? (e["type"] ?? "") : "")} ${pyStr("payload" in e ? (e["payload"] ?? {}) : {})}`,
  );
  let recentDecisions: Record<string, unknown>[];
  try {
    const decTail = await store.tailDecisions(
      track.project_id,
      5,
      0,
      makeRowFilter({ trackIds: new Set([trackId]) }),
    );
    recentDecisions = decTail.length
      ? [...decTail].toReversed().map((d) => ({
          id: "id" in d ? (d["id"] ?? "") : "",
          one_liner: oneLiner(d),
          source: "source" in d ? d["source"] : "leader",
        }))
      : [];
  } catch {
    const decisions = await store.readDecisions(track.project_id).catch(() => []);
    const trackDecisions = decisions.filter((d) => d["track_id"] === trackId);
    const last5 = trackDecisions.length > 5 ? trackDecisions.slice(-5) : trackDecisions;
    recentDecisions = last5.map((d) => ({
      id: "id" in d ? (d["id"] ?? "") : "",
      one_liner: oneLiner(d),
      source: "source" in d ? d["source"] : "leader",
    }));
  }
  let stale = false;
  const confirmedAt = track.heartbeats.confirmed_at;
  let lastTurnTs = "";
  if (turnEvents.length) lastTurnTs = (turnEvents[0]["ts"] as string) ?? "";
  if (!lastTurnTs) {
    for (const ev of trackEventsSorted) {
      if (ev["type"] === "turn_reported") {
        lastTurnTs = (ev["ts"] as string) ?? "";
        break;
      }
    }
  }
  // The Python source spells two arms here whose conditions commute to the same
  // test; a single evaluation is behavior-identical.
  if (confirmedAt && lastTurnTs && track.handoff.state === "pending" && confirmedAt < lastTurnTs)
    stale = true;
  if (!confirmedAt && lastTurnTs && track.handoff.state === "pending") stale = true;
  const leaderDict = track.leader ? leaderDump(track.leader) : null;
  let pendingSuggestions = 0;
  let suggestionsBreakdown = { pending: 0, approved: 0, rejected: 0, total: 0 };
  try {
    const allSugg = await store.readSuggestions(track.project_id);
    pendingSuggestions = allSugg.filter(
      (s) => s["track_id"] === trackId && s["status"] === "pending",
    ).length;
    suggestionsBreakdown = {
      pending: pendingSuggestions,
      approved: allSugg.filter((s) => s["track_id"] === trackId && s["status"] === "approved")
        .length,
      rejected: allSugg.filter((s) => s["track_id"] === trackId && s["status"] === "rejected")
        .length,
      total: allSugg.filter((s) => s["track_id"] === trackId).length,
    };
  } catch {
    pendingSuggestions = 0;
    suggestionsBreakdown = { pending: 0, approved: 0, rejected: 0, total: 0 };
  }
  let overrides: Record<string, unknown> = {};
  let overridesProvenance: Record<string, unknown> = {};
  try {
    overrides =
      track.overrides !== null && typeof track.overrides === "object" ? { ...track.overrides } : {};
    overridesProvenance =
      track.overrides_provenance !== null && typeof track.overrides_provenance === "object"
        ? { ...track.overrides_provenance }
        : {};
  } catch {
    overrides = {};
    overridesProvenance = {};
  }
  let latestEvaluations: Record<string, unknown>[] = [];
  let modelEvaluationsOut: Record<string, unknown>[] = [];
  let fleetHealth: Record<string, unknown> = { per_model: {}, total_evaluations: 0 };
  try {
    const allEvals = await store.readModelEvaluations(track.project_id);
    const trackEvals = allEvals.filter((e) => e["track_id"] === trackId);
    const sorted = [...trackEvals].sort((a, b) =>
      cmpStr(String(a["evaluated_at"] ?? ""), String(b["evaluated_at"] ?? "")),
    );
    latestEvaluations = sorted.slice(0, 10);
    const perModel: Record<string, Record<string, unknown>> = {};
    const perModelCounts: Record<string, number> = {};
    const accum: Record<string, Record<string, number>> = {};
    const taskAccum: Record<string, Record<string, number>> = {};
    const telemetryAccum: Record<string, Record<string, number>> = {};
    for (const ev of trackEvals) {
      const m = ev["model"];
      const sc = ev["scores"] || {};
      if (!m || sc === null || typeof sc !== "object" || Array.isArray(sc)) continue;
      const model = m as string;
      if (!(model in accum)) {
        accum[model] = { truthfulness: 0, confidence: 0, effectiveness: 0, guideline_adherence: 0 };
        taskAccum[model] = { task_complexity: 0, task_size: 0 };
        telemetryAccum[model] = { compactions: 0, tokens_in: 0, tokens_out: 0 };
        perModelCounts[model] = 0;
      }
      for (const k of ["truthfulness", "confidence", "effectiveness", "guideline_adherence"]) {
        let v: number;
        try {
          v = pyInt((sc as Record<string, unknown>)[k] ?? 0);
        } catch {
          v = 0;
        }
        accum[model][k] += v;
      }
      for (const tk of ["task_complexity", "task_size"]) {
        let tv: number;
        try {
          const raw = ev[tk];
          tv = pyInt(pyTruthy(raw) ? raw : 0);
        } catch {
          tv = 0;
        }
        taskAccum[model][tk] += tv;
      }
      const tel = ev["telemetry"] || {};
      if (tel !== null && typeof tel === "object" && !Array.isArray(tel)) {
        for (const tk of ["compactions", "tokens_in", "tokens_out"]) {
          try {
            const val = (tel as Record<string, unknown>)[tk];
            if (val === null || val === undefined) continue;
            telemetryAccum[model][tk] += pyInt(val);
          } catch {
            /* pass */
          }
        }
      }
      perModelCounts[model] += 1;
    }
    for (const [m, sums] of Object.entries(accum)) {
      const cnt = perModelCounts[m];
      const entry: Record<string, unknown> = { count: cnt };
      for (const k of ["truthfulness", "confidence", "effectiveness", "guideline_adherence"]) {
        entry[`${k}_avg`] = cnt ? pyRound2(sums[k] / cnt) : 0;
      }
      entry["task_complexity_avg"] = cnt ? pyRound2(taskAccum[m]["task_complexity"] / cnt) : 0;
      entry["task_size_avg"] = cnt ? pyRound2(taskAccum[m]["task_size"] / cnt) : 0;
      entry["total_compactions"] = telemetryAccum[m]["compactions"];
      entry["avg_compactions"] = cnt ? pyRound2(telemetryAccum[m]["compactions"] / cnt) : 0;
      entry["total_tokens_in"] = telemetryAccum[m]["tokens_in"];
      entry["total_tokens_out"] = telemetryAccum[m]["tokens_out"];
      const vals = ["truthfulness", "confidence", "effectiveness", "guideline_adherence"].map(
        (k) => sums[k] / cnt,
      );
      entry["overall_avg"] = vals.length
        ? pyRound2(vals.reduce((a, b) => a + b, 0) / vals.length)
        : 0;
      perModel[m] = entry;
    }
    const totalCompactions = Object.values(perModel).reduce(
      (a, v) => a + Number(v["total_compactions"] ?? 0),
      0,
    );
    fleetHealth = {
      per_model: perModel,
      total_evaluations: trackEvals.length,
      total_compactions: totalCompactions,
    };
    modelEvaluationsOut = latestEvaluations;
  } catch {
    latestEvaluations = [];
    modelEvaluationsOut = [];
    fleetHealth = { per_model: {}, total_evaluations: 0 };
  }
  let eventsBytes = 0;
  try {
    eventsBytes = await store.eventsBytes(track.project_id);
  } catch {
    eventsBytes = 0;
  }
  let decisionsBytes = 0;
  try {
    decisionsBytes = await store.decisionsBytes(track.project_id);
  } catch {
    decisionsBytes = 0;
  }
  const orchestratorState: Record<string, unknown> = {
    ...wakeProgress(
      track.heartbeats.generation_started_at,
      now,
      orchestratorCheckupMinutes(),
      orchestratorWakesPerLife(),
    ),
    schedule_id: track.heartbeats.schedule_id,
    checkup_id: track.heartbeats.orchestrator_checkup_id,
    checkup_cron: orchestratorCheckupCron(),
    renew_cron: orchestratorRenewCron(),
  };
  const windowMinutes = asInt(sinceMinutes, 0);
  let recent: Record<string, unknown> | null = null;
  if (windowMinutes > 0) {
    try {
      recent = await recentBlock(store, track, now, windowMinutes);
    } catch (exc) {
      recent = {
        ok: false,
        since_minutes: windowMinutes,
        now,
        error: `failed to build recent window: ${(exc as Error).message}`,
      };
    }
  }
  const taskArgs: unknown[] = [
    taskStatus,
    taskGate,
    taskAssignee,
    asInt(taskSinceMinutes, 0),
    asInt(taskLimit, 0),
    asInt(taskOffset, 0),
  ];
  let taskQuery: Record<string, unknown> | null = null;
  if (taskArgs.some(pyTruthy)) {
    taskQuery = taskQueryBlock(
      track,
      now,
      taskStatus,
      taskGate,
      taskAssignee,
      taskArgs[3],
      taskArgs[4],
      taskArgs[5],
    );
  }
  const out: Record<string, unknown> = {
    ok: true,
    now,
    goal: track.goal,
    status: track.status,
    leader: leaderDict,
    orchestrator: orchestratorState,
    heartbeats: {
      checkup_id: track.heartbeats.checkup_id,
      deep_id: track.heartbeats.deep_id,
      confirmed_at: track.heartbeats.confirmed_at,
      stale,
    },
    heartbeat_stale: stale,
    last_turn_at: lastTurnTs,
    last_turn_age_s: ageSeconds(lastTurnTs, now),
    updated_at: track.updated_at,
    updated_age_s: ageSeconds(track.updated_at, now),
    workers: track.workers.map(workerDump),
    worker_reports: workerReports,
    tasks: track.queue.map(queueItemDump),
    queue: track.queue.map(queueItemDump),
    turn_count: track.turn_count,
    pending_suggestions: pendingSuggestions,
    suggestions: suggestionsBreakdown,
    overrides,
    overrides_provenance: overridesProvenance,
    recent_events: recentEvents,
    recent_decisions: recentDecisions,
    lessons: "P2 hook: lessons integration pending — see Lessons.md",
    lessons_hook: "P2 hook: lessons integration pending",
    model_evaluations: modelEvaluationsOut,
    latest_evaluations: latestEvaluations,
    fleet_health: fleetHealth,
    evaluations: modelEvaluationsOut,
    events_bytes: eventsBytes,
    decisions_bytes: decisionsBytes,
  };
  if (recent !== null) out["recent"] = recent;
  if (taskQuery !== null) out["task_query"] = taskQuery;
  return out;
}

function cmpStr(a: string, b: string): number {
  // Newest-first strcmp mirroring sorted(..., reverse=True): stable, ties 0.
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

function pyRound2(x: number): number {
  const n = x * 100;
  const lo = Math.floor(n);
  const diff = n - lo;
  if (diff < 0.5 - 1e-9) return lo / 100;
  if (diff > 0.5 + 1e-9) return (lo + 1) / 100;
  return (lo % 2 === 0 ? lo : lo + 1) / 100;
}

// ---------------------------------------------------------------------------
// track_list
// ---------------------------------------------------------------------------

export async function trackList(store: Store, projectId = ""): Promise<Record<string, unknown>> {
  try {
    const tracks = await store.listTracks(pyTruthy(projectId) ? projectId : null);
    const systemIds = await systemTrackIds(store, tracks);
    const compact = tracks.map((t) => ({
      id: t.id,
      epic: t.epic,
      status: t.status,
      leader: t.leader ? t.leader.agent_id : null,
      turn_count: t.turn_count,
      system: systemIds.has(t.id),
    }));
    return { ok: true, count: compact.length, tracks: compact };
  } catch (exc) {
    return { ok: false, error: `failed to list tracks: ${(exc as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// worker_evaluate
// ---------------------------------------------------------------------------

export async function workerEvaluate(
  store: Store,
  trackId: string,
  agentId: string,
  confidence: unknown,
  effectiveness: unknown,
  guidelineAdherence: unknown,
  notes: unknown = "",
  taskComplexity: unknown = null,
  taskSize: unknown = null,
  telemetry: unknown = null,
): Promise<Record<string, unknown>> {
  try {
    if (!trackId || !agentId) {
      return { ok: false, error: "track_id and agent_id are required" };
    }
    const [evalObj, evalErr] = validateEvaluationArgs(
      confidence,
      effectiveness,
      guidelineAdherence,
      notes,
      taskComplexity,
      taskSize,
      telemetry,
    );
    if (evalErr !== null) return evalErr;
    if (!evalObj) throw new Error("evaluation validation produced no object");
    let track;
    try {
      track = await store.getTrack(trackId);
    } catch (exc) {
      return {
        ok: false,
        error: `track not found: ${trackId}: ${(exc as Error).message}`,
        hint: "ask the leader for the track_id",
      };
    }
    await store.lock(`track-${trackId}`, async () => {
      const now = utcnowIso();
      const existing = track.workers.find((w) => w.agent_id === agentId) ?? null;
      if (existing !== null) {
        existing.evaluation = evalObj;
      } else {
        track.workers.push({
          agent_id: agentId,
          role: "dev",
          model: "",
          dispatched_at: now,
          status: "running",
          evaluation: evalObj,
        });
      }
      await store.saveTrack(track);
      const evalPayload = workerEvalDump(evalObj);
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "worker_evaluated",
          track_id: track.id,
          project_id: track.project_id,
          payload: { agent_id: agentId, evaluation: evalPayload, evaluated_at: now },
        },
        track.project_id,
      );
    });
    return { ok: true, recorded: true, evaluation: workerEvalDump(evalObj) };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in worker_evaluate: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// model_evaluate / model_evaluations
// ---------------------------------------------------------------------------

function clampTaskInt(v: number): number {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

export async function modelEvaluate(
  store: Store,
  trackId: string,
  agentId: string,
  model: string,
  scores: unknown,
  notes: unknown = "",
  reviewer: unknown = "",
  taskComplexity: unknown = null,
  taskSize: unknown = null,
  telemetry: unknown = null,
): Promise<Record<string, unknown>> {
  try {
    if (!trackId || !String(trackId).trim()) {
      return {
        ok: false,
        error: "track_id must be non-empty",
        hint: "provide track_id from track_create",
      };
    }
    if (!agentId || !String(agentId).trim()) {
      return {
        ok: false,
        error: "agent_id must be non-empty",
        hint: "provide agent_id being evaluated",
      };
    }
    if (!model || !String(model).trim()) {
      return {
        ok: false,
        error: "model must be non-empty",
        hint: "provide model id like opencode-go/muse-spark-1.3-contributor",
      };
    }
    const [scoresObj, scoresErr] = validateModelScores(scores);
    if (scoresErr !== null) return scoresErr;
    if (!scoresObj) throw new Error("scores validation produced no object");
    if (
      taskComplexity === null ||
      taskComplexity === undefined ||
      taskSize === null ||
      taskSize === undefined
    ) {
      return {
        ok: false,
        error: "task_complexity and task_size are required",
        hint: "provide task_complexity and task_size as ints 0-100",
      };
    }
    for (const [name, val] of [
      ["task_complexity", taskComplexity],
      ["task_size", taskSize],
    ] as [string, unknown][]) {
      if (typeof val === "boolean" || typeof val !== "number" || !Number.isInteger(val)) {
        return {
          ok: false,
          error: `invalid ${name}: must be int 0-100`,
          hint: "task fields must be ints 0-100 (clamped, floats/strings rejected)",
        };
      }
    }
    let telemetryObj: ReturnType<typeof validateTelemetry> = null;
    if (telemetry !== null && telemetry !== undefined) {
      if (telemetry === null || typeof telemetry !== "object" || Array.isArray(telemetry)) {
        return {
          ok: false,
          error: "telemetry must be object or null",
          hint: "provide {compactions, tokens_in, tokens_out, cache_pct} or null",
        };
      }
      try {
        telemetryObj = validateTelemetry(telemetry);
      } catch (exc) {
        return {
          ok: false,
          error: `invalid telemetry: ${(exc as Error).message}`,
          hint: "telemetry fields nullable: compactions/tokens ints, cache_pct float or null",
        };
      }
    }
    if (notes === null || notes === undefined) notes = "";
    if (typeof notes !== "string") {
      return { ok: false, error: "notes must be str", hint: "provide notes as string" };
    }
    let track;
    try {
      track = await store.getTrack(String(trackId).trim());
    } catch (exc) {
      return {
        ok: false,
        error: (exc as Error).message,
        hint: "track not found; verify track_id via track_list",
      };
    }
    if (track.leader === null) {
      return {
        ok: false,
        error: "track has no leader",
        hint: "register leader first via leader_register",
      };
    }
    let reviewerNorm = reviewer ? String(reviewer).trim() : "";
    if (!reviewerNorm) reviewerNorm = track.leader.agent_id;
    if (reviewerNorm !== track.leader.agent_id) {
      return {
        ok: false,
        error: `only leader can evaluate models (leader=${track.leader.agent_id}, reviewer=${reviewerNorm})`,
        hint: "call as the track leader agent",
      };
    }
    const cleanAgentId = String(agentId).trim();
    const cleanModel = String(model).trim();
    const cleanTrackId = String(trackId).trim();
    const cleanNotes = String(notes);
    const record = await store.lock(`model_evaluations-${track.project_id}`, async () => {
      const evaluations = await store.readModelEvaluations(track.project_id);
      const idx = evaluations.findIndex(
        (e) => e["track_id"] === cleanTrackId && e["agent_id"] === cleanAgentId,
      );
      const now = utcnowIso();
      const scoresDict = scoresDump(scoresObj);
      const telemetryDict =
        telemetryObj !== null
          ? {
              compactions: telemetryObj.compactions,
              tokens_in: telemetryObj.tokens_in,
              tokens_out: telemetryObj.tokens_out,
              cache_pct: telemetryObj.cache_pct,
            }
          : null;
      let rec: Record<string, unknown>;
      if (idx !== -1) {
        const existing = evaluations[idx];
        const priorSnapshot = {
          scores: existing["scores"],
          task_complexity: existing["task_complexity"] ?? 0,
          task_size: existing["task_size"] ?? 0,
          telemetry: existing["telemetry"],
          notes: existing["notes"] ?? "",
          reviewer: existing["reviewer"] ?? "",
          model: existing["model"] ?? "",
          evaluated_at: existing["evaluated_at"] ?? "",
        };
        const histRaw = existing["history"];
        const hist = Array.isArray(histRaw) ? histRaw : [];
        hist.push(priorSnapshot);
        existing["model"] = cleanModel;
        existing["scores"] = scoresDict;
        existing["task_complexity"] = taskComplexity;
        existing["task_size"] = taskSize;
        existing["telemetry"] = telemetryDict;
        existing["notes"] = cleanNotes;
        existing["reviewer"] = reviewerNorm;
        existing["evaluated_at"] = now;
        existing["history"] = hist;
        existing["track_id"] = cleanTrackId;
        existing["project_id"] = track.project_id;
        try {
          const validatedScores = validateModelScoresFields(
            existing["scores"] as Record<string, unknown>,
          );
          const tc = existing["task_complexity"];
          const ts = existing["task_size"];
          if (typeof tc === "boolean" || !Number.isInteger(tc))
            throw new Error("must be int 0-100");
          if (typeof ts === "boolean" || !Number.isInteger(ts))
            throw new Error("must be int 0-100");
          const tel = existing["telemetry"];
          const validatedTel = tel === null || tel === undefined ? null : validateTelemetry(tel);
          const nt = existing["notes"];
          const validatedNotes =
            nt === null || nt === undefined
              ? ""
              : (() => {
                  if (typeof nt !== "string") throw new Error("notes must be str");
                  return nt;
                })();
          evaluations[idx] = {
            id: existing["id"],
            track_id: cleanTrackId,
            project_id: track.project_id,
            agent_id: cleanAgentId,
            model: cleanModel,
            scores: scoresDump(validatedScores),
            task_complexity: clampTaskInt(tc as number),
            task_size: clampTaskInt(ts as number),
            telemetry: validatedTel ? { ...validatedTel } : null,
            notes: validatedNotes,
            reviewer: reviewerNorm,
            evaluated_at: now,
            history: hist,
          };
        } catch {
          evaluations[idx] = existing;
        }
        rec = evaluations[idx];
      } else {
        rec = {
          id: newId("eval"),
          track_id: cleanTrackId,
          project_id: track.project_id,
          agent_id: cleanAgentId,
          model: cleanModel,
          scores: scoresDict,
          task_complexity: clampTaskInt(taskComplexity as number),
          task_size: clampTaskInt(taskSize as number),
          telemetry: telemetryDict,
          notes: cleanNotes,
          reviewer: reviewerNorm,
          evaluated_at: now,
          history: [],
        };
        evaluations.push(rec);
      }
      await store.writeModelEvaluations(track.project_id, evaluations);
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "model_evaluated",
          track_id: cleanTrackId,
          project_id: track.project_id,
          payload: {
            agent_id: cleanAgentId,
            model: cleanModel,
            scores: scoresDict,
            task_complexity: taskComplexity,
            task_size: taskSize,
            telemetry: telemetryDict,
            notes: cleanNotes,
            reviewer: reviewerNorm,
            evaluated_at: now,
            evaluation_id: rec["id"],
          },
        },
        track.project_id,
      );
      return rec;
    });
    return { ok: true, evaluation: record, hint: "evaluation upserted; history preserved" };
  } catch (exc) {
    if (exc instanceof StateError) return { ok: false, error: (exc as Error).message };
    return {
      ok: false,
      error: `unexpected error in model_evaluate: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

export async function modelEvaluations(
  store: Store,
  trackId: string,
  agentId = "",
  limit: unknown = 50,
): Promise<Record<string, unknown>> {
  try {
    if (!trackId || !String(trackId).trim()) {
      return { ok: false, error: "track_id must be non-empty", hint: "provide track_id" };
    }
    const cleanTrackId = String(trackId).trim();
    const cleanAgentId = agentId ? String(agentId).trim() : "";
    let lim: number;
    try {
      lim = pyInt(limit);
    } catch {
      lim = 50;
    }
    if (lim < 1) lim = 1;
    if (lim > 100) lim = 100;
    let track;
    try {
      track = await store.getTrack(cleanTrackId);
    } catch (exc) {
      return {
        ok: false,
        error: (exc as Error).message,
        hint: "track not found; verify track_id via track_list",
      };
    }
    let allEvals: Record<string, unknown>[];
    try {
      allEvals = await store.readModelEvaluations(track.project_id);
    } catch (exc) {
      return { ok: false, error: `failed to read evaluations: ${(exc as Error).message}` };
    }
    let filtered = allEvals.filter((e) => e["track_id"] === cleanTrackId);
    if (cleanAgentId) filtered = filtered.filter((e) => e["agent_id"] === cleanAgentId);
    filtered.sort((a, b) =>
      cmpStr(String(a["evaluated_at"] ?? ""), String(b["evaluated_at"] ?? "")),
    );
    const sliced = filtered.slice(0, lim);
    return { ok: true, count: sliced.length, evaluations: sliced, total: filtered.length };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in model_evaluations: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// history (merged)
// ---------------------------------------------------------------------------

export async function history(
  store: Store,
  trackId = "",
  projectId = "",
  type = "all",
  eventType = "",
  since = "",
  limit: unknown = 50,
  offset: unknown = 0,
  sinceMinutes: unknown = 0,
  decisionLimit: unknown = 0,
): Promise<Record<string, unknown>> {
  const wanted = new Set(["all", "event", "turn", "decision"]);
  if (!wanted.has(type)) {
    return {
      ok: false,
      error: `invalid type ${pyRepr(type)}`,
      hint: `must be one of ${pyRepr(["all", "decision", "event", "turn"])}`,
    };
  }
  if ((type === "event" || type === "all") && !(trackId || projectId)) {
    return { ok: false, error: "project_id or track_id required", hint: "scope the history query" };
  }
  let now: string;
  let window: string;
  try {
    now = utcnowIso();
    window = windowCutoff(sinceMinutes, now);
  } catch (exc) {
    return {
      ok: false,
      error: (exc as Error).message,
      hint: "since_minutes must be a number of minutes, or omit it and use `since`",
    };
  }
  const effectiveSince = window || since || "";
  const off = Math.max(0, asInt(offset, 0));
  const decLim = Math.max(0, asInt(decisionLimit, 0));
  const out: Record<string, unknown> = {
    ok: true,
    type,
    now,
    since: effectiveSince,
    events: [],
    turns: [],
    decisions: [],
  };
  if (type === "all" || type === "event") {
    const res = await historyEvents(
      store,
      trackId,
      projectId,
      eventType,
      effectiveSince,
      limit,
      offset,
      now,
    );
    if (!res["ok"]) return res;
    out["events"] = res["events"];
  }
  if (type === "all" || type === "turn") {
    if (!trackId) {
      return { ok: false, error: "track_id required for type=turn", hint: "turns are per-track" };
    }
    const res = await historyTurns(store, trackId, limit, offset, effectiveSince, now);
    if (!res["ok"]) return res;
    out["turns"] = res["turns"];
  }
  if (type === "all" || type === "decision") {
    const res = await historyDecisions(
      store,
      trackId,
      projectId,
      off,
      decLim,
      effectiveSince,
      now,
      true,
    );
    if (!res["ok"]) return res;
    out["decisions"] = res["decisions"];
  }
  out["count"] =
    (out["events"] as unknown[]).length +
    (out["turns"] as unknown[]).length +
    (out["decisions"] as unknown[]).length;
  return out;
}
