/**
 * Parity case catalog: >=100 same-input cases spanning all 26 tools
 * (happy-path reads, writes, and error cases). Cases run IN ORDER on both
 * servers; `$var` values resolve per-server from each server's own context.
 */
export interface Extract {
  path: string;
  var: string;
}

export interface Case {
  name: string;
  tool?: string;
  args?: Record<string, unknown>;
  extract?: Extract[];
  special?: "tools-list" | "unknown-tool" | "init";
}

export const LEADER_MODEL = "command_code/z-ai/glm-5.3-flash";
export const DEV_MODEL = "opencode-go/muse-spark-1.3-contributor";
const FIXED_DEEP = "aaaabbbb";
const FIXED_CHECKUP = "ccccdddd";
const FIXED_ORCH_CHECKUP = "dddd1111";

/** Summary content builder (per-server ids spliced in, then normalized). */
export function summaryContent(ctx: Record<string, string>): string {
  const leaderId = "parity-successor";
  const lines = [
    "---",
    "type: status-summary",
    `project: ${ctx["project_id"]}`,
    `tracks: [${ctx["track_id"]}]`,
    "generated_by: parity",
    "generated_at: 2026-10-04",
    "last_modified: 2026-10-04",
    "tokens_estimate: 2000",
    "---",
    "# Orchestration Status",
    `Parity probe summary for track ${ctx["track_id"]}.`,
    "## Track Goal",
    "Parity probe track goal",
    "## Leader",
    `Leader: ${leaderId}`,
    "Status: active",
    "## Fleet Status",
    "Workers: 2",
    "## Tasks",
    `- ${ctx["task_id"]} Parity task one — done 100% (parity-worker)`,
    "## Track Summary",
    "The parity probe advanced the track through its queue and recorded turns.",
  ];
  for (let i = 1; i <= 60; i++) {
    lines.push(
      `Parity detail ${i}: checkpoint ${i * 7} verified against expectation ${i * 13 + 1} with note binder-${i}.`,
    );
  }
  lines.push(
    "## Blockers & Decisions",
    "none",
    "## Lessons Snapshot",
    "No lessons snapshotted in the parity probe run.",
    "## Resume Instructions",
    "Resume by reading track_status and history, then continue the queue.",
    "Parity resume marker: reconcile state before acting on anything else.",
  );
  return lines.join("\n") + "\n";
}

export const INVALID_SUMMARY = [
  "---",
  "type: status-summary",
  "project: p-missing",
  "---",
  "# Orchestration Status",
  "Too short and missing sections with a TODO marker.",
  "TODO: finish this",
  "",
].join("\n");

export function buildCases(fx: { projectId: string; trackId: string }): Case[] {
  const C: Case[] = [];
  const add = (c: Case): void => {
    C.push(c);
  };

  // -- projects --
  add({
    name: "project_create/ok",
    tool: "project_create",
    args: { name: "Parity Probe", repos: [], harness: "omp", validate_repos: false },
    extract: [{ path: "project.id", var: "project_id" }],
  });
  add({
    name: "project_create/blank-name",
    tool: "project_create",
    args: { name: "  ", repos: [] },
  });
  add({
    name: "project_create/bad-harness",
    tool: "project_create",
    args: { name: "X", repos: [], harness: "nope" },
  });
  add({
    name: "project_create/reserved",
    tool: "project_create",
    args: { name: "Orchestration System", repos: [], validate_repos: false },
  });
  add({
    name: "project_create/duplicate-slug",
    tool: "project_create",
    args: { name: "Parity Probe", repos: [], validate_repos: false },
  });
  add({
    name: "project_create/repo-invalid",
    tool: "project_create",
    args: { name: "Repo Probe", repos: ["nope/nonexistent-xyz-123"] },
  });

  // -- tracks --
  add({
    name: "track_create/ok",
    tool: "track_create",
    args: { project_id: "$project_id", epic: "parity-epic", goal: "Parity probe track goal" },
    extract: [{ path: "track.id", var: "track_id" }],
  });
  add({
    name: "track_create/blank-goal",
    tool: "track_create",
    args: { project_id: "$project_id", epic: "e", goal: "  " },
  });
  add({
    name: "track_create/unknown-project",
    tool: "track_create",
    args: { project_id: "p-nope", epic: "e", goal: "g" },
  });

  // -- leader --
  add({
    name: "leader_register/ok",
    tool: "leader_register",
    args: {
      track_id: "$track_id",
      agent_id: "parity-leader",
      agent_model: LEADER_MODEL,
      contract_version: "0.0.1",
    },
    extract: [{ path: "track.id", var: "track_id" }],
  });
  add({
    name: "leader_register/bad-contract",
    tool: "leader_register",
    args: {
      track_id: "$track_id",
      agent_id: "x",
      agent_model: LEADER_MODEL,
      contract_version: "spam",
    },
  });
  add({
    name: "leader_register/bad-model",
    tool: "leader_register",
    args: {
      track_id: "$track_id",
      agent_id: "x",
      agent_model: "nope/model",
      contract_version: "0.0.1",
    },
  });
  add({
    name: "leader_register/reregister-same",
    tool: "leader_register",
    args: {
      track_id: "$track_id",
      agent_id: "parity-leader",
      agent_model: LEADER_MODEL,
      contract_version: "0.0.1",
    },
  });
  add({
    name: "leader_register/second-leader",
    tool: "leader_register",
    args: {
      track_id: "$track_id",
      agent_id: "parity-other",
      agent_model: LEADER_MODEL,
      contract_version: "0.0.1",
    },
  });

  // -- tasks --
  add({
    name: "task_add/ok",
    tool: "task_add",
    args: { track_id: "$track_id", title: "Parity task one", detail: "first body", gate: "ready" },
    extract: [{ path: "task.id", var: "task_id" }],
  });
  add({
    name: "task_add/bad-gate",
    tool: "task_add",
    args: { track_id: "$track_id", title: "t", gate: "nope" },
  });
  add({
    name: "task_add/empty-title",
    tool: "task_add",
    args: { track_id: "$track_id", title: "" },
  });
  add({
    name: "task_update/status-progress",
    tool: "task_update",
    args: {
      track_id: "$track_id",
      task_id: "$task_id",
      status: "running",
      progress: 10,
      assignee: "parity-worker",
    },
  });
  add({
    name: "task_update/amend",
    tool: "task_update",
    args: {
      track_id: "$track_id",
      task_id: "$task_id",
      detail: "amended body",
      amend_reason: "clarify",
      author: "parity-leader",
    },
  });
  add({
    name: "task_update/amend-noop",
    tool: "task_update",
    args: { track_id: "$track_id", task_id: "$task_id", detail: "amended body" },
  });
  add({
    name: "task_update/bad-status",
    tool: "task_update",
    args: { track_id: "$track_id", task_id: "$task_id", status: "nope" },
  });
  add({
    name: "task_update/progress-range",
    tool: "task_update",
    args: { track_id: "$track_id", task_id: "$task_id", progress: 101 },
  });
  add({
    name: "task_update/unknown-task",
    tool: "task_update",
    args: { track_id: "$track_id", task_id: "task-nope" },
  });
  add({
    name: "task_update/note",
    tool: "task_update",
    args: { track_id: "$track_id", task_id: "$task_id", note: "parity note" },
  });

  // -- turns --
  add({
    name: "turn_report/basic",
    tool: "turn_report",
    args: {
      track_id: "$track_id",
      summary: "Parity turn one summary",
      status: "running",
      done: ["a"],
      next: ["b"],
    },
  });
  add({
    name: "turn_report/with-task-decision",
    tool: "turn_report",
    args: {
      track_id: "$track_id",
      summary: "Parity worker turn",
      status: "idle",
      task: "Parity task one",
      author_agent: "parity-worker",
      author_model: DEV_MODEL,
      role: "dev",
      decision: "Parity decision one",
      decision_rationale: "because parity",
      decision_source: "leader",
      evaluation: {
        confidence: 80,
        effectiveness: 80,
        guideline_adherence: 80,
        task_complexity: 60,
        task_size: 50,
      },
    },
  });
  add({
    name: "turn_report/bad-status",
    tool: "turn_report",
    args: { track_id: "$track_id", summary: "s", status: "nope" },
  });
  add({
    name: "turn_report/empty-summary",
    tool: "turn_report",
    args: { track_id: "$track_id", summary: "  " },
  });
  add({
    name: "turn_report/over-budget",
    tool: "turn_report",
    args: { track_id: "$track_id", summary: "word ".repeat(1500) },
  });
  add({
    name: "turn_report/unknown-track",
    tool: "turn_report",
    args: { track_id: "t-nope", summary: "s" },
  });

  // -- history --
  add({ name: "history/all", tool: "history", args: { track_id: "$track_id", type: "all" } });
  add({
    name: "history/events-filtered",
    tool: "history",
    args: {
      track_id: "$track_id",
      type: "event",
      event_type: "task_updated,turn_reported",
      limit: 5,
    },
  });
  add({
    name: "history/turns",
    tool: "history",
    args: { track_id: "$track_id", type: "turn", limit: 3 },
  });
  add({
    name: "history/decisions",
    tool: "history",
    args: { project_id: "$project_id", type: "decision" },
  });
  add({ name: "history/bad-type", tool: "history", args: { track_id: "$track_id", type: "nope" } });
  add({ name: "history/no-scope", tool: "history", args: { type: "event" } });
  add({
    name: "history/unknown-event-type",
    tool: "history",
    args: { track_id: "$track_id", type: "event", event_type: "nope" },
  });
  add({
    name: "history/window-paged",
    tool: "history",
    args: {
      track_id: "$track_id",
      type: "all",
      since_minutes: 60,
      limit: 4,
      offset: 1,
      decision_limit: 2,
    },
  });

  // -- track views --
  add({ name: "track_status/basic", tool: "track_status", args: { track_id: "$track_id" } });
  add({
    name: "track_status/recent",
    tool: "track_status",
    args: { track_id: "$track_id", since_minutes: 60000 },
  });
  add({
    name: "track_status/task-query",
    tool: "track_status",
    args: { track_id: "$track_id", task_status: "running", task_limit: 5 },
  });
  add({
    name: "track_status/task-query-bad",
    tool: "track_status",
    args: { track_id: "$track_id", task_gate: "nope" },
  });
  add({ name: "track_status/unknown", tool: "track_status", args: { track_id: "t-nope" } });
  add({ name: "track_list/all", tool: "track_list", args: {} });

  // -- heartbeats --
  add({
    name: "heartbeat/leader-spec",
    tool: "heartbeat",
    args: { track_id: "$track_id", action: "spec", role: "leader" },
  });
  add({
    name: "heartbeat/leader-confirm",
    tool: "heartbeat",
    args: {
      track_id: "$track_id",
      action: "confirm",
      role: "leader",
      deep_id: FIXED_DEEP,
      checkup_id: FIXED_CHECKUP,
    },
  });
  add({
    name: "heartbeat/leader-confirm-no-deep",
    tool: "heartbeat",
    args: { track_id: "$track_id", action: "confirm", role: "leader" },
  });
  add({ name: "heartbeat/bad-role", tool: "heartbeat", args: { role: "nope" } });
  add({
    name: "heartbeat/bad-action",
    tool: "heartbeat",
    args: { track_id: "$track_id", action: "nope" },
  });
  add({
    name: "heartbeat/orchestrator-spec",
    tool: "heartbeat",
    args: { role: "orchestrator", action: "spec" },
  });
  add({
    name: "heartbeat/orchestrator-confirm",
    tool: "heartbeat",
    args: { role: "orchestrator", action: "confirm", checkup_id: FIXED_ORCH_CHECKUP },
    extract: [
      { path: "track.id", var: "sys_track_id" },
      { path: "track.project_id", var: "sys_project_id" },
    ],
  });
  // LAO #69 (pin 13fc0cb): holder re-confirm is an idempotent no-op (NOT
  // stale); only a DIFFERENT id already in history is a late predecessor.
  add({
    name: "heartbeat/orchestrator-confirm-reconfirm",
    tool: "heartbeat",
    args: { role: "orchestrator", action: "confirm", checkup_id: FIXED_ORCH_CHECKUP },
  });
  add({
    name: "heartbeat/orchestrator-confirm-new-gen",
    tool: "heartbeat",
    args: { role: "orchestrator", action: "confirm", checkup_id: "eeee2222" },
  });
  add({
    name: "heartbeat/orchestrator-confirm-late",
    tool: "heartbeat",
    args: { role: "orchestrator", action: "confirm", checkup_id: FIXED_ORCH_CHECKUP },
  });
  add({
    name: "heartbeat/orchestrator-on-leader-track",
    tool: "heartbeat",
    args: { track_id: "$track_id", role: "orchestrator", action: "spec" },
  });
  add({
    name: "heartbeat/orchestrator-confirm-empty",
    tool: "heartbeat",
    args: { role: "orchestrator", action: "confirm" },
  });

  // -- handoff --
  add({
    name: "leader_handoff/start",
    tool: "leader_handoff",
    args: {
      track_id: "$track_id",
      action: "start",
      to_agent_id: "parity-successor",
      reason: "parity rotation",
    },
  });
  add({
    name: "leader_handoff/idempotent",
    tool: "leader_handoff",
    args: {
      track_id: "$track_id",
      action: "start",
      to_agent_id: "parity-successor",
      reason: "parity rotation",
    },
  });
  add({
    name: "leader_handoff/pack",
    tool: "leader_handoff",
    args: { track_id: "$track_id", action: "pack" },
  });
  add({
    name: "leader_handoff/pack-tiny",
    tool: "leader_handoff",
    args: { track_id: "$track_id", action: "pack", max_tokens: 1 },
  });
  add({
    name: "leader_handoff/bad-action",
    tool: "leader_handoff",
    args: { track_id: "$track_id", action: "nope" },
  });
  add({
    name: "leader_register/successor",
    tool: "leader_register",
    args: {
      track_id: "$track_id",
      agent_id: "parity-successor",
      agent_model: LEADER_MODEL,
      contract_version: "0.0.1",
    },
    extract: [{ path: "track.id", var: "track_id" }],
  });
  add({ name: "leader_runbook/ok", tool: "leader_runbook", args: {} });

  // -- fleet --
  add({ name: "fleet/catalog", tool: "fleet", args: { mode: "catalog" } });
  add({ name: "fleet/catalog-dev", tool: "fleet", args: { mode: "catalog", position: "dev" } });
  add({
    name: "fleet/catalog-bad-position",
    tool: "fleet",
    args: { mode: "catalog", position: "nope" },
  });
  add({
    name: "fleet/recommend",
    tool: "fleet",
    args: {
      mode: "recommend",
      position: "dev",
      usage: { [DEV_MODEL]: 2 },
      quota: { [DEV_MODEL]: 0.2 },
    },
  });
  add({
    name: "fleet/recommend-unknown",
    tool: "fleet",
    args: { mode: "recommend", position: "nope" },
  });
  add({ name: "fleet/recommend-no-position", tool: "fleet", args: { mode: "recommend" } });
  add({
    name: "fleet/spawn",
    tool: "fleet",
    args: {
      mode: "spawn",
      position: "dev",
      count: 1,
      title: "parity work",
      track_id: "$track_id",
      purpose: "parity purpose",
      task_id: "$task_id",
    },
  });
  add({ name: "fleet/spawn-leader", tool: "fleet", args: { mode: "spawn", position: "leader" } });
  add({
    name: "fleet/spawn-bad-count",
    tool: "fleet",
    args: { mode: "spawn", position: "dev", count: 9 },
  });
  add({ name: "fleet/bad-mode", tool: "fleet", args: { mode: "nope" } });
  add({ name: "fleet_usage/get-empty", tool: "fleet_usage", args: { action: "get" } });
  add({
    name: "fleet_usage/report",
    tool: "fleet_usage",
    args: {
      action: "report",
      usage: { [DEV_MODEL]: 3 },
      source: "parity",
      note: "parity snapshot",
    },
  });
  add({ name: "fleet_usage/get-fresh", tool: "fleet_usage", args: { action: "get" } });
  add({ name: "fleet_usage/bad-action", tool: "fleet_usage", args: { action: "nope" } });
  add({
    name: "fleet_usage/report-empty",
    tool: "fleet_usage",
    args: { action: "report", usage: {} },
  });
  add({
    name: "fleet_usage/report-bad-entry",
    tool: "fleet_usage",
    args: { action: "report", usage: { a: -1 } },
  });

  // -- lessons --
  add({
    name: "lesson_add/ok",
    tool: "lesson_add",
    args: {
      track_id: "$track_id",
      title: "Parity Lesson One",
      body: "Evidence with [[wikilink]] for parity.",
      tags: ["workflow"],
    },
    extract: [{ path: "slug", var: "lesson_slug" }],
  });
  add({
    name: "lesson_add/bad-tag",
    tool: "lesson_add",
    args: { track_id: "$track_id", title: "Parity Lesson Two", body: "Body.", tags: ["nope"] },
  });
  add({
    name: "lesson_add/empty-body",
    tool: "lesson_add",
    args: { track_id: "$track_id", title: "Parity Lesson Three", body: "  ", tags: ["build"] },
  });
  add({
    name: "lesson_add/update",
    tool: "lesson_add",
    args: {
      track_id: "$track_id",
      title: "Parity Lesson One",
      body: "Corrected evidence body.",
      tags: ["workflow"],
    },
  });
  add({ name: "lesson_list/all", tool: "lesson_list", args: {} });
  add({ name: "lesson_list/tag", tool: "lesson_list", args: { tag: "workflow" } });
  add({ name: "lesson_list/search", tool: "lesson_list", args: { search: "parity" } });
  add({ name: "lesson_list/bad-tag", tool: "lesson_list", args: { tag: "nope" } });

  // -- suggestions --
  add({
    name: "suggestion_add/lesson",
    tool: "suggestion_add",
    args: {
      track_id: "$track_id",
      agent_id: "parity-worker",
      kind: "lesson",
      title: "Parity Suggestion Lesson",
      body: "Lesson body.",
      tags: ["workflow"],
    },
    extract: [{ path: "suggestion_id", var: "sugg1" }],
  });
  add({
    name: "suggestion_add/bad-kind",
    tool: "suggestion_add",
    args: { track_id: "$track_id", agent_id: "w", kind: "nope", title: "t", body: "b" },
  });
  add({
    name: "suggestion_add/bad-tags",
    tool: "suggestion_add",
    args: {
      track_id: "$track_id",
      agent_id: "w",
      kind: "lesson",
      title: "t",
      body: "b",
      tags: "nope",
    },
  });
  add({ name: "suggestion_list/all", tool: "suggestion_list", args: {} });
  add({
    name: "suggestion_list/filtered",
    tool: "suggestion_list",
    args: { track_id: "$track_id", status: "pending", limit: 5 },
  });
  add({ name: "suggestion_list/bad-status", tool: "suggestion_list", args: { status: "nope" } });
  add({
    name: "suggestion_review/reject",
    tool: "suggestion_review",
    args: {
      track_id: "$track_id",
      suggestion_id: "$sugg1",
      approve: false,
      reviewer: "parity-successor",
      note: "not now",
    },
  });
  add({
    name: "suggestion_add/reference",
    tool: "suggestion_add",
    args: {
      track_id: "$track_id",
      agent_id: "parity-worker",
      kind: "reference",
      title: "Parity Reference",
      body: "Reference body.",
    },
    extract: [{ path: "suggestion_id", var: "sugg2" }],
  });
  add({
    name: "suggestion_review/approve-reference",
    tool: "suggestion_review",
    args: {
      track_id: "$track_id",
      suggestion_id: "$sugg2",
      approve: true,
      reviewer: "parity-successor",
    },
  });
  add({
    name: "suggestion_add/process",
    tool: "suggestion_add",
    args: {
      track_id: "$track_id",
      agent_id: "parity-worker",
      kind: "process",
      title: "Parity Process Decision",
      body: "Process rationale.",
    },
    extract: [{ path: "suggestion_id", var: "sugg3" }],
  });
  add({
    name: "suggestion_review/approve-process",
    tool: "suggestion_review",
    args: {
      track_id: "$track_id",
      suggestion_id: "$sugg3",
      approve: true,
      reviewer: "parity-successor",
    },
  });
  add({
    name: "suggestion_add/lesson-approve",
    tool: "suggestion_add",
    args: {
      track_id: "$track_id",
      agent_id: "parity-worker",
      kind: "lesson",
      title: "Parity Auto Lesson",
      body: "Auto lesson body.",
      tags: ["build"],
    },
    extract: [{ path: "suggestion_id", var: "sugg4" }],
  });
  add({
    name: "suggestion_review/approve-lesson",
    tool: "suggestion_review",
    args: {
      track_id: "$track_id",
      suggestion_id: "$sugg4",
      approve: true,
      reviewer: "parity-successor",
    },
  });
  add({
    name: "suggestion_review/already-reviewed",
    tool: "suggestion_review",
    args: {
      track_id: "$track_id",
      suggestion_id: "$sugg4",
      approve: false,
      reviewer: "parity-successor",
    },
  });
  add({
    name: "suggestion_review/non-leader",
    tool: "suggestion_review",
    args: {
      track_id: "$track_id",
      suggestion_id: "$sugg2",
      approve: false,
      reviewer: "parity-intruder",
    },
  });
  add({
    name: "suggestion_review/unknown-id",
    tool: "suggestion_review",
    args: {
      track_id: "$track_id",
      suggestion_id: "sugg-nope",
      approve: false,
      reviewer: "parity-successor",
    },
  });
  add({
    name: "suggestion_review/bad-approve-type",
    tool: "suggestion_review",
    args: {
      track_id: "$track_id",
      suggestion_id: "$sugg2",
      approve: "yes",
      reviewer: "parity-successor",
    },
  });

  // -- evaluations --
  add({
    name: "model_evaluate/ok",
    tool: "model_evaluate",
    args: {
      track_id: "$track_id",
      agent_id: "parity-worker",
      model: DEV_MODEL,
      scores: { truthfulness: 90, confidence: 85, effectiveness: 88, guideline_adherence: 92 },
      task_complexity: 65,
      task_size: 60,
      reviewer: "parity-successor",
      notes: "parity eval",
    },
  });
  add({
    name: "model_evaluate/upsert",
    tool: "model_evaluate",
    args: {
      track_id: "$track_id",
      agent_id: "parity-worker",
      model: DEV_MODEL,
      scores: { truthfulness: 95, confidence: 90, effectiveness: 88, guideline_adherence: 92 },
      task_complexity: 70,
      task_size: 55,
      reviewer: "parity-successor",
    },
  });
  add({
    name: "model_evaluations/list",
    tool: "model_evaluations",
    args: { track_id: "$track_id" },
  });
  add({
    name: "model_evaluate/bad-scores",
    tool: "model_evaluate",
    args: {
      track_id: "$track_id",
      agent_id: "w",
      model: "m",
      scores: { truthfulness: "high" },
      task_complexity: 1,
      task_size: 1,
    },
  });
  add({
    name: "model_evaluate/hallucination-key",
    tool: "model_evaluate",
    args: {
      track_id: "$track_id",
      agent_id: "w",
      model: "m",
      scores: {
        truthfulness: 1,
        confidence: 1,
        effectiveness: 1,
        guideline_adherence: 1,
        hallucination: 1,
      },
      task_complexity: 1,
      task_size: 1,
    },
  });
  add({
    name: "model_evaluate/non-leader",
    tool: "model_evaluate",
    args: {
      track_id: "$track_id",
      agent_id: "w",
      model: "m",
      scores: { truthfulness: 1, confidence: 1, effectiveness: 1, guideline_adherence: 1 },
      task_complexity: 1,
      task_size: 1,
      reviewer: "parity-intruder",
    },
  });
  add({
    name: "worker_evaluate/ok",
    tool: "worker_evaluate",
    args: {
      track_id: "$track_id",
      agent_id: "parity-eval-worker",
      confidence: 70,
      effectiveness: 75,
      guideline_adherence: 80,
      task_complexity: 50,
      task_size: 40,
      notes: "parity worker eval",
    },
  });
  add({
    name: "worker_evaluate/bad-score",
    tool: "worker_evaluate",
    args: {
      track_id: "$track_id",
      agent_id: "w",
      confidence: "high",
      effectiveness: 1,
      guideline_adherence: 1,
      task_complexity: 1,
      task_size: 1,
    },
  });
  add({
    name: "worker_evaluate/missing-task-fields",
    tool: "worker_evaluate",
    args: {
      track_id: "$track_id",
      agent_id: "w",
      confidence: 1,
      effectiveness: 1,
      guideline_adherence: 1,
    },
  });

  // -- summary pipeline --
  add({
    name: "summary_read/spec",
    tool: "summary_read",
    args: { track_id: "$track_id", action: "spec" },
  });
  add({
    name: "summary_read/bad-action",
    tool: "summary_read",
    args: { track_id: "$track_id", action: "nope" },
  });
  add({ name: "summary_read/unknown-track", tool: "summary_read", args: { track_id: "t-nope" } });
  add({
    name: "summary_write/invalid",
    tool: "summary_write",
    args: { track_id: "$track_id", content: INVALID_SUMMARY },
  });
  add({
    name: "summary_write/ok",
    tool: "summary_write",
    args: { track_id: "$track_id", content: "$summary", generated_by: "parity" },
  });
  add({
    name: "summary_read/diff",
    tool: "summary_read",
    args: { track_id: "$track_id", action: "diff", content: "$summary" },
  });
  add({
    name: "summary_read/diff-from-file",
    tool: "summary_read",
    args: { track_id: "$track_id", action: "diff" },
  });

  // -- overrides + close --
  add({
    name: "track_override/no-approval",
    tool: "track_override",
    args: { track_id: "$track_id", override: { md_token_min: 100 } },
  });
  add({
    name: "track_override/no-evidence",
    tool: "track_override",
    args: { track_id: "$track_id", override: { md_token_min: 100 }, owner_approved: true },
  });
  add({
    name: "track_override/ok",
    tool: "track_override",
    args: {
      track_id: "$track_id",
      override: { parity_flag: true },
      owner_approved: true,
      evidence: "owner directive quote",
    },
  });
  add({ name: "track_close/missing-pr", tool: "track_close", args: { track_id: "$track_id" } });
  add({
    name: "track_close/bogus-pr",
    tool: "track_close",
    args: { track_id: "$track_id", pr: "ddvnguyen/paseo#999999" },
  });
  add({
    name: "track_close/archive",
    tool: "track_close",
    args: { track_id: "$track_id", archive: true, reason: "parity done" },
  });
  add({
    name: "track_close/idempotent",
    tool: "track_close",
    args: { track_id: "$track_id", archive: true },
  });
  add({
    name: "turn_report/closed-track",
    tool: "turn_report",
    args: { track_id: "$track_id", summary: "Parity post-close turn" },
  });
  add({
    name: "task_add/closed-track",
    tool: "task_add",
    args: { track_id: "$track_id", title: "post-close task" },
  });

  // -- system-track guards --
  add({
    name: "track_create/system-project",
    tool: "track_create",
    args: { project_id: "$sys_project_id", epic: "e", goal: "g" },
  });
  add({
    name: "task_add/system-track",
    tool: "task_add",
    args: { track_id: "$sys_track_id", title: "t" },
  });

  // -- fixture reads (seed-fixed ids, exercises real ledger rows incl. orphans) --
  add({ name: "fixture/track_status", tool: "track_status", args: { track_id: fx.trackId } });
  add({
    name: "fixture/history-events",
    tool: "history",
    args: { project_id: fx.projectId, type: "event", event_type: "turn_reported", limit: 5 },
  });
  add({
    name: "fixture/history-decisions",
    tool: "history",
    args: { project_id: fx.projectId, type: "decision", decision_limit: 3 },
  });
  add({ name: "fixture/track_list", tool: "track_list", args: {} });

  // -- protocol-level --
  add({ name: "protocol/tools-list", special: "tools-list" });
  add({ name: "protocol/unknown-tool", special: "unknown-tool" });
  add({ name: "protocol/missing-param", tool: "track_create", args: { epic: "e" } });
  add({
    name: "protocol/wrong-type",
    tool: "task_add",
    args: { track_id: "t-x", title: "t", gate: 5 },
  });
  add({ name: "protocol/init", special: "init" });

  return C;
}
