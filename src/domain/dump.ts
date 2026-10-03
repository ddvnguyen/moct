/**
 * model_dump() equivalents — explicit key sets matching pydantic output.
 * Every dump returns EXACTLY the keys the Python model_dump() emits.
 */
import type {
  HeartbeatBinding,
  HeartbeatSpec,
  LeaderBinding,
  ModelEvaluation,
  ModelScores,
  Project,
  QueueItem,
  SuggestionRecord,
  Telemetry,
  Track,
  TurnDelta,
  WorkerEvaluation,
  WorkerRecord,
  Decision,
  Handoff,
  Repo,
} from "./models.js";

export function repoDump(r: Repo): Record<string, unknown> {
  return { name: r.name, validated: r.validated, validated_at: r.validated_at };
}

export function projectDump(p: Project): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    repos: p.repos.map(repoDump),
    harness: p.harness,
    created_at: p.created_at,
    system: p.system,
  };
}

export function leaderDump(l: LeaderBinding): Record<string, unknown> {
  return {
    agent_id: l.agent_id,
    model: l.model,
    harness: l.harness,
    contract_version: l.contract_version,
    signed_at: l.signed_at,
    model_verified: l.model_verified,
    override_reason: l.override_reason,
  };
}

export function heartbeatDump(h: HeartbeatBinding): Record<string, unknown> {
  return {
    checkup_id: h.checkup_id,
    deep_id: h.deep_id,
    confirmed_at: h.confirmed_at,
    schedule_id: h.schedule_id,
    orchestrator_checkup_id: h.orchestrator_checkup_id,
    generation_started_at: h.generation_started_at,
    digest_last_written_at: h.digest_last_written_at,
    checkup_history: [...h.checkup_history],
  };
}

export function handoffDump(h: Handoff): Record<string, unknown> {
  return {
    state: h.state,
    from_agent: h.from_agent,
    to_agent: h.to_agent,
    reason: h.reason,
    started_at: h.started_at,
    completed_at: h.completed_at,
  };
}

export function telemetryDump(t: Telemetry | null): Record<string, unknown> | null {
  if (!t) return null;
  return {
    compactions: t.compactions,
    tokens_in: t.tokens_in,
    tokens_out: t.tokens_out,
    cache_pct: t.cache_pct,
  };
}

export function workerEvalDump(e: WorkerEvaluation): Record<string, unknown> {
  return {
    confidence: e.confidence,
    effectiveness: e.effectiveness,
    guideline_adherence: e.guideline_adherence,
    task_complexity: e.task_complexity,
    task_size: e.task_size,
    notes: e.notes,
    telemetry: telemetryDump(e.telemetry),
  };
}

export function workerDump(w: WorkerRecord): Record<string, unknown> {
  return {
    agent_id: w.agent_id,
    role: w.role,
    model: w.model,
    dispatched_at: w.dispatched_at,
    status: w.status,
    evaluation: w.evaluation ? workerEvalDump(w.evaluation) : null,
  };
}

export function queueItemDump(q: QueueItem): Record<string, unknown> {
  return {
    id: q.id,
    title: q.title,
    detail: q.detail,
    gate: q.gate,
    status: q.status,
    progress: q.progress,
    assignee: q.assignee,
    added_at: q.added_at,
    updated_at: q.updated_at,
    note: q.note,
    detail_amendments: q.detail_amendments,
  };
}

export function trackDump(t: Track): Record<string, unknown> {
  return {
    id: t.id,
    project_id: t.project_id,
    epic: t.epic,
    goal: t.goal,
    repo: t.repo,
    branch: t.branch,
    status: t.status,
    leader: t.leader ? leaderDump(t.leader) : null,
    heartbeats: heartbeatDump(t.heartbeats),
    workers: t.workers.map(workerDump),
    queue: t.queue.map(queueItemDump),
    handoff: handoffDump(t.handoff),
    turn_count: t.turn_count,
    created_at: t.created_at,
    updated_at: t.updated_at,
    overrides: t.overrides,
    overrides_provenance: t.overrides_provenance,
  };
}

export function turnDump(t: TurnDelta): Record<string, unknown> {
  return {
    n: t.n,
    ts: t.ts,
    summary: t.summary,
    status: t.status,
    done: t.done,
    next: t.next,
    blockers: t.blockers,
    decisions: t.decisions,
    knowledge: { lesson_topic: t.knowledge.lesson_topic, docs_updated: t.knowledge.docs_updated },
    author_agent: t.author_agent,
    author_model: t.author_model,
  };
}

export function decisionDump(d: Decision): Record<string, unknown> {
  return {
    id: d.id,
    ts: d.ts,
    track_id: d.track_id,
    project_id: d.project_id,
    decision: d.decision,
    rationale: d.rationale,
    source: d.source,
    irreversible: d.irreversible,
    author: d.author,
  };
}

export function suggestionDump(s: SuggestionRecord): Record<string, unknown> {
  return {
    id: s.id,
    track_id: s.track_id,
    project_id: s.project_id,
    agent_id: s.agent_id,
    kind: s.kind,
    title: s.title,
    body: s.body,
    tags: s.tags,
    status: s.status,
    slug: s.slug,
    created_at: s.created_at,
    reviewed_at: s.reviewed_at,
    reviewer: s.reviewer,
    note: s.note,
    result: s.result,
  };
}

export function scoresDump(s: ModelScores): Record<string, unknown> {
  return {
    truthfulness: s.truthfulness,
    confidence: s.confidence,
    effectiveness: s.effectiveness,
    guideline_adherence: s.guideline_adherence,
  };
}

export function modelEvalDump(e: ModelEvaluation): Record<string, unknown> {
  return {
    id: e.id,
    track_id: e.track_id,
    project_id: e.project_id,
    agent_id: e.agent_id,
    model: e.model,
    scores: scoresDump(e.scores),
    task_complexity: e.task_complexity,
    task_size: e.task_size,
    telemetry: telemetryDump(e.telemetry),
    notes: e.notes,
    reviewer: e.reviewer,
    evaluated_at: e.evaluated_at,
    history: e.history,
  };
}

export function heartbeatSpecDump(s: HeartbeatSpec): Record<string, unknown> {
  return {
    step_name: s.step_name,
    cron: s.cron,
    timezone: s.timezone,
    prompt: s.prompt,
    tool_mcp: s.tool_mcp,
    tool_cli: s.tool_cli,
  };
}
