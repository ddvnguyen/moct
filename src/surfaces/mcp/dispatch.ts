/**
 * Tool dispatch — the 26 MCP tool names (identical to Python TOOL_REGISTRY)
 * bound to their TypeScript implementations. No REST, no resources (M2).
 */
/* eslint-disable complexity, max-depth -- faithful port of mcp-orchestration:
 * control structure mirrors the Python source arm-for-arm; the parity harness
 * (138 same-input cases over MCP stdio) guards behavior, not style metrics. */

import { fleet, fleetUsage } from "../../domain/tools/catalog.js";
import {
  heartbeat,
  leaderHandoff,
  leaderRegister,
  leaderRunbook,
} from "../../domain/tools/leader.js";
import { lessonAdd, lessonList } from "../../domain/tools/lessons.js";
import {
  history,
  modelEvaluate,
  modelEvaluations,
  trackList,
  trackStatus,
  turnReport,
  workerEvaluate,
} from "../../domain/tools/reporting.js";
import {
  projectCreate,
  taskAdd,
  taskUpdate,
  trackClose,
  trackCreate,
  trackOverride,
} from "../../domain/tools/projects.js";
import { suggestionAdd, suggestionList, suggestionReview } from "../../domain/tools/suggestions.js";
import { summaryRead, summaryWrite } from "../../domain/tools/summary.js";
import type { Store } from "../../store/store-interface.js";

export type ToolFn = (
  store: Store,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export const TOOL_NAMES = [
  "project_create",
  "track_create",
  "track_close",
  "track_override",
  "task_add",
  "task_update",
  "turn_report",
  "history",
  "fleet",
  "fleet_usage",
  "heartbeat",
  "leader_handoff",
  "summary_read",
  "summary_write",
  "leader_register",
  "leader_runbook",
  "track_status",
  "track_list",
  "lesson_add",
  "lesson_list",
  "suggestion_add",
  "suggestion_review",
  "suggestion_list",
  "model_evaluate",
  "model_evaluations",
  "worker_evaluate",
] as const;

export function dispatchTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "project_create":
      return projectCreate(
        store,
        args["name"] as string,
        (args["repos"] ?? []) as string[],
        (args["harness"] as string) ?? "omp",
        (args["validate_repos"] as boolean) ?? true,
      );
    case "track_create":
      return trackCreate(
        store,
        args["project_id"] as string,
        args["epic"] as string,
        args["goal"] as string,
        (args["repo"] as string) ?? "",
        (args["branch"] as string) ?? "",
      );
    case "track_close":
      return trackClose(
        store,
        args["track_id"] as string,
        (args["reason"] as string) ?? "",
        (args["outcome"] as string) ?? "",
        (args["archive"] as boolean) ?? false,
        (args["pr"] as string) ?? "",
      );
    case "track_override":
      return trackOverride(
        store,
        args["track_id"] as string,
        args["override"],
        (args["owner_approved"] as boolean) ?? false,
        (args["evidence"] as string) ?? "",
        (args["author"] as string) ?? "",
      );
    case "task_add":
      return taskAdd(
        store,
        args["track_id"] as string,
        args["title"] as string,
        (args["detail"] as string) ?? "",
        (args["gate"] as string) ?? "ready",
        (args["assignee"] as string) ?? "",
      );
    case "task_update":
      return taskUpdate(
        store,
        args["track_id"] as string,
        args["task_id"] as string,
        (args["status"] as string) ?? "",
        (args["progress"] as number) ?? -1,
        (args["assignee"] as string) ?? "",
        (args["note"] as string) ?? "",
        (args["detail"] as string) ?? "",
        (args["amend_reason"] as string) ?? "",
        (args["author"] as string) ?? "",
      );
    case "turn_report":
      return turnReport(
        store,
        args["track_id"] as string,
        args["summary"] as string,
        (args["status"] as string) ?? "running",
        args["done"] ?? null,
        args["next"] ?? null,
        args["blockers"] ?? null,
        args["decisions"] ?? null,
        (args["knowledge_lesson_topic"] as string) ?? "",
        args["knowledge_docs_updated"] ?? null,
        (args["author_agent"] as string) ?? "",
        (args["author_model"] as string) ?? "",
        (args["task"] as string) ?? "",
        (args["role"] as string) ?? "",
        (args["decision"] as string) ?? "",
        (args["decision_rationale"] as string) ?? "",
        (args["decision_source"] as string) ?? "leader",
        args["irreversible"] ?? false,
        args["evaluation"] ?? null,
        (args["pr"] as string) ?? "",
        args["artifacts"] ?? null,
      );
    case "history":
      return history(
        store,
        (args["track_id"] as string) ?? "",
        (args["project_id"] as string) ?? "",
        (args["type"] as string) ?? "all",
        (args["event_type"] as string) ?? "",
        (args["since"] as string) ?? "",
        args["limit"] ?? 50,
        args["offset"] ?? 0,
        args["since_minutes"] ?? 0,
        args["decision_limit"] ?? 0,
      );
    case "fleet":
      return fleet(
        store,
        (args["mode"] as string) ?? "catalog",
        (args["harness"] as string) ?? "omp",
        (args["position"] as string) ?? "",
        args["usage"] ?? null,
        args["quota"] ?? null,
        (args["live"] as boolean) ?? false,
        args["count"] ?? 1,
        (args["title"] as string) ?? "",
        (args["track_id"] as string) ?? "",
        (args["purpose"] as string) ?? "",
        (args["task_id"] as string) ?? "",
        (args["model"] as string) ?? "",
      );
    case "fleet_usage":
      // Was advertised in TOOL_NAMES and in the tools/list snapshot but had NO
      // case here, so every client that discovered it got `unknown tool:
      // fleet_usage`. The handler (catalog.ts fleetUsage, mirroring Python
      // tools/catalog.py:801) was written, exported and imported — the wiring
      // was the only missing piece, which is also why the repo-wide lint job
      // reported `fleetUsage` as an unused import on this same line.
      // dispatchTool is Promise-returning; fleetUsage is synchronous.
      return Promise.resolve(
        fleetUsage(
          store,
          (args["action"] as string) ?? "get",
          args["usage"] ?? null,
          (args["source"] as string) ?? "",
          (args["note"] as string) ?? "",
          (args["include_stale"] as boolean) ?? true,
        ),
      );
    case "heartbeat":
      return heartbeat(
        store,
        (args["track_id"] as string) ?? "",
        (args["action"] as string) ?? "spec",
        (args["role"] as string) ?? "leader",
        (args["harness"] as string) ?? "omp",
        (args["checkup_id"] as string) ?? "",
        (args["deep_id"] as string) ?? "",
        (args["schedule_id"] as string) ?? "",
      );
    case "leader_handoff":
      return leaderHandoff(
        store,
        args["track_id"] as string,
        (args["action"] as string) ?? "start",
        (args["to_agent_id"] as string) ?? "",
        (args["reason"] as string) ?? "",
        (args["target_role"] as string) ?? "dev",
        (args["max_tokens"] as number) ?? 6000,
      );
    case "summary_read":
      return summaryRead(
        store,
        args["track_id"] as string,
        (args["action"] as string) ?? "spec",
        (args["content"] as string) ?? "",
      );
    case "summary_write":
      return summaryWrite(
        store,
        args["track_id"] as string,
        args["content"] as string,
        (args["generated_by"] as string) ?? "",
      );
    case "leader_register":
      return leaderRegister(
        store,
        args["track_id"] as string,
        args["agent_id"] as string,
        args["agent_model"] as string,
        args["contract_version"] as string,
        (args["override_reason"] as string) ?? "",
        (args["harness"] as string) ?? "omp",
      );
    case "leader_runbook":
      return Promise.resolve(leaderRunbook());
    case "track_status":
      return trackStatus(
        store,
        args["track_id"] as string,
        args["since_minutes"] ?? 0,
        (args["task_status"] as string) ?? "",
        (args["task_gate"] as string) ?? "",
        (args["task_assignee"] as string) ?? "",
        args["task_since_minutes"] ?? 0,
        args["task_limit"] ?? 0,
        args["task_offset"] ?? 0,
      );
    case "track_list":
      return trackList(store, (args["project_id"] as string) ?? "");
    case "lesson_add":
      return lessonAdd(
        store,
        args["track_id"] as string,
        args["title"] as string,
        args["body"] as string,
        args["tags"] ?? null,
      );
    case "lesson_list":
      return Promise.resolve(
        lessonList(store, args["tag"] ?? "", args["search"] ?? "", args["limit"] ?? 50),
      );
    case "suggestion_add":
      return suggestionAdd(
        store,
        args["track_id"] as string,
        args["agent_id"] as string,
        args["kind"] as string,
        args["title"] as string,
        args["body"] as string,
        args["tags"] ?? null,
      );
    case "suggestion_review":
      return suggestionReview(
        store,
        args["track_id"] as string,
        args["suggestion_id"] as string,
        args["approve"],
        args["reviewer"] as string,
        args["note"] ?? "",
      );
    case "suggestion_list":
      return suggestionList(
        store,
        args["track_id"] ?? "",
        args["status"] ?? "",
        args["kind"] ?? "",
        args["limit"] ?? 50,
      );
    case "model_evaluate":
      return modelEvaluate(
        store,
        args["track_id"] as string,
        args["agent_id"] as string,
        args["model"] as string,
        args["scores"],
        args["notes"] ?? "",
        args["reviewer"] ?? "",
        args["task_complexity"] ?? null,
        args["task_size"] ?? null,
        args["telemetry"] ?? null,
      );
    case "model_evaluations":
      return modelEvaluations(
        store,
        args["track_id"] as string,
        (args["agent_id"] as string) ?? "",
        args["limit"] ?? 50,
      );
    case "worker_evaluate":
      return workerEvaluate(
        store,
        args["track_id"] as string,
        args["agent_id"] as string,
        args["confidence"],
        args["effectiveness"],
        args["guideline_adherence"],
        args["notes"] ?? "",
        args["task_complexity"] ?? null,
        args["task_size"] ?? null,
        args["telemetry"] ?? null,
      );
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
