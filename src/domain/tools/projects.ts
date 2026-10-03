/**
 * Project/track creation tools — port of tools/projects.py.
 * All functions return plain dicts, never throw to the caller (the MCP
 * envelope converts escapes to {"ok": False, "error": "unexpected: ..."}).
 */
/* eslint-disable complexity, max-depth -- faithful port of mcp-orchestration:
 * control structure mirrors the Python source arm-for-arm; the parity harness
 * (138 same-input cases over MCP stdio) guards behavior, not style metrics. */

import { execFileSync } from "node:child_process";
import { isReservedProjectSlug } from "../config.js";
import { projectDump, queueItemDump, trackDump } from "../dump.js";
import {
  KNOWN_HARNESSES,
  SYSTEM_PROJECT_NAME,
  SYSTEM_PROJECT_SLUG,
  TASK_GATES,
  TASK_STATUSES,
  makeQueueItem,
  pyRepr,
  pyStr,
  pyTypeName,
  slugify,
  utcnowIso,
} from "../models.js";
import { StateError, type Store } from "../../store/store-interface.js";
import { refuseSystemTrackWrite } from "./leader-guards.js";

// ---------------------------------------------------------------------------
// gh subprocess helpers (CPython-identical error synthesis)
// ---------------------------------------------------------------------------

interface GhResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

function runGh(
  args: string[],
  timeoutSec: number,
):
  | { ok: true; result: GhResult }
  | { ok: false; kind: "missing" | "timeout" | "os"; message: string } {
  try {
    const out = execFileSync(args[0], args.slice(1), {
      encoding: "utf-8",
      timeout: timeoutSec * 1000,
      windowsHide: true,
    }) as string;
    return { ok: true, result: { returncode: 0, stdout: out ?? "", stderr: "" } };
  } catch (exc) {
    const err = exc as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number;
      killed?: boolean;
      signal?: string;
    };
    if (err.code === "ENOENT") {
      return { ok: false, kind: "missing", message: "[Errno 2] No such file or directory: 'gh'" };
    }
    if (err.killed) {
      const cmdStr = pyStr(args);
      return {
        ok: false,
        kind: "timeout",
        message: `Command '${cmdStr}' timed out after ${timeoutSec} seconds`,
      };
    }
    if (typeof err.status === "number") {
      // execFileSync throws on nonzero exit carrying stdout/stderr.
      return {
        ok: true,
        result: {
          returncode: err.status,
          stdout: String(err.stdout ?? ""),
          stderr: String(err.stderr ?? ""),
        },
      };
    }
    return { ok: false, kind: "os", message: String((exc as Error).message ?? exc) };
  }
}

export function verifyPrDelivered(pr: string): [boolean, string] {
  const r = runGh(["gh", "pr", "view", pr, "--json", "state,reviewDecision"], 30);
  if (!r.ok) return [false, `gh unavailable: ${r.message}`];
  const { result } = r;
  if (result.returncode !== 0) {
    return [false, (result.stderr.trim() || `gh exit ${result.returncode}`).slice(0, 300)];
  }
  let data: Record<string, unknown>;
  const parsed: unknown = JSON.parse(result.stdout);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`'${pyTypeName(parsed)}' object has no attribute 'get'`);
  }
  data = parsed as Record<string, unknown>;
  const state = String((data["state"] as string) || "").toUpperCase();
  const review = String((data["reviewDecision"] as string) || "").toUpperCase();
  if (state === "MERGED" || review === "APPROVED") return [true, `state=${state} review=${review}`];
  return [false, `state=${state} review=${review} — not merged/approved yet`];
}

// ---------------------------------------------------------------------------
// project_create
// ---------------------------------------------------------------------------

export async function projectCreate(
  store: Store,
  name: string,
  repos: string[],
  harness = "omp",
  validateRepos = true,
): Promise<Record<string, unknown>> {
  try {
    if (!(KNOWN_HARNESSES as readonly string[]).includes(harness)) {
      return {
        ok: false,
        error: `unknown harness: ${harness}`,
        hint: `known harnesses: ${KNOWN_HARNESSES.join(", ")}`,
      };
    }
    if (!name || !String(name).trim()) {
      return {
        ok: false,
        error: "name must be a non-empty string",
        hint: "provide a project name",
      };
    }
    let candidateSlug: string;
    try {
      candidateSlug = slugify(name);
    } catch (exc) {
      return {
        ok: false,
        error: `invalid project name: ${(exc as Error).message}`,
        hint: "use letters, digits, dot, dash or underscore",
      };
    }
    if (isReservedProjectSlug(candidateSlug)) {
      return {
        ok: false,
        error: `project name ${pyRepr(name)} slugifies to ${pyRepr(candidateSlug)}, which is reserved for the system`,
        hint: `that slug belongs to the ${pyRepr(SYSTEM_PROJECT_NAME)} project, which stores the ORCHESTRATOR collector's own state; pick another name`,
      };
    }
    const repoList = [...(repos || [])];
    if (validateRepos) {
      for (const repo of repoList) {
        const repoStr = String(repo).trim();
        if (!repoStr) {
          return {
            ok: false,
            error: "repo validation failed: empty repo name",
            stderr_tail: "",
            hint: "gh must be authenticated; pass validate_repos=false to skip",
          };
        }
        const r = runGh(["gh", "repo", "view", repoStr, "--json", "name"], 20);
        if (!r.ok) {
          const tail = r.kind === "timeout" ? `${r.message} `.slice(-200) : r.message.slice(-200);
          return {
            ok: false,
            error: `repo validation failed: ${repoStr}`,
            stderr_tail: tail,
            hint: "gh must be authenticated; pass validate_repos=false to skip",
          };
        }
        if (r.result.returncode !== 0) {
          const raw = (r.result.stderr || r.result.stdout || "").slice(-200);
          return {
            ok: false,
            error: `repo validation failed: ${repoStr}`,
            stderr_tail: raw,
            hint: "gh must be authenticated; pass validate_repos=false to skip",
          };
        }
      }
    }
    let project;
    try {
      project = await store.createProject(
        name,
        repoList.map((r) => ({ name: r })),
        harness,
      );
    } catch (exc) {
      if (exc instanceof StateError) {
        return {
          ok: false,
          error: (exc as Error).message,
          hint: "project slug already exists or invalid name",
        };
      }
      return { ok: false, error: (exc as Error).message, hint: "project creation failed" };
    }
    if (validateRepos && repoList.length) {
      try {
        for (const repoObj of project.repos) {
          repoObj.validated = true;
          repoObj.validated_at = utcnowIso();
        }
        await store.writeJsonAtomic(store.projectFile(project.id), projectDump(project));
      } catch (exc) {
        return {
          ok: false,
          error: `failed to persist repo validation: ${(exc as Error).message}`,
          hint: "check store permissions",
        };
      }
    }
    return { ok: true, project: projectDump(project) };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in project_create: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// track_create
// ---------------------------------------------------------------------------

export async function trackCreate(
  store: Store,
  projectId: string,
  epic: string,
  goal: string,
  repo = "",
  branch = "",
): Promise<Record<string, unknown>> {
  try {
    if (!projectId || !String(projectId).trim()) {
      return {
        ok: false,
        error: "project_id must be a non-empty string",
        hint: "provide project_id from project_create",
      };
    }
    if (!epic || !String(epic).trim()) {
      return { ok: false, error: "epic must be a non-empty string", hint: "provide epic name" };
    }
    if (!goal || !String(goal).trim()) {
      return {
        ok: false,
        error: "goal must be a non-empty string",
        hint: "provide goal (lossless, verbatim)",
      };
    }
    let targetProject = null;
    try {
      targetProject = await store.getProject(projectId);
    } catch (exc) {
      if (!(exc instanceof StateError)) throw exc;
      targetProject = null;
    }
    if (targetProject !== null && targetProject.system) {
      return {
        ok: false,
        error: `cannot create a track in the reserved system project (${SYSTEM_PROJECT_SLUG})`,
        hint: "it holds only the collector's own track; create a project with project_create for work",
      };
    }
    let track;
    try {
      track = await store.createTrack(projectId, epic, goal, repo || "", branch || "");
    } catch (exc) {
      if (exc instanceof StateError) {
        return {
          ok: false,
          error: (exc as Error).message,
          hint: "track creation failed; check project_id and inputs",
        };
      }
      return { ok: false, error: (exc as Error).message, hint: "track creation failed" };
    }
    return { ok: true, track: trackDump(track), note: "goal stored verbatim — lossless" };
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in track_create: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// track_close
// ---------------------------------------------------------------------------

export async function trackClose(
  store: Store,
  trackId: string,
  reason = "",
  outcome = "",
  archive = false,
  pr = "",
): Promise<Record<string, unknown>> {
  const refusal = await refuseSystemTrackWrite(store, trackId, "track_close");
  if (refusal !== null) return refusal;
  try {
    const target = archive ? "archived" : "done";
    let prVerified = "";
    if (!archive) {
      if (!pr) {
        return {
          ok: false,
          error: "closing as DONE requires a delivered PR",
          hint: "pass pr='owner/repo#N' (merged or approved); or archive=True for a superseded track",
        };
      }
      const [ok, detail] = verifyPrDelivered(pr);
      if (!ok) {
        return {
          ok: false,
          error: `PR not deliverable: ${detail}`,
          hint: "close only when the PR is merged/approved",
        };
      }
      prVerified = detail;
    }
    if (!archive && !reason) reason = `delivered via ${pr}`;
    return await store.lock(`track-${trackId}`, async () => {
      let track;
      try {
        track = await store.getTrack(trackId);
      } catch (exc) {
        if (exc instanceof StateError) {
          return {
            ok: false,
            error: `track not found: ${trackId}: ${(exc as Error).message}`,
            hint: "track_list for valid ids",
          };
        }
        throw exc;
      }
      if (track.status === "done" || track.status === "archived") {
        return { ok: true, track: trackDump(track), idempotent: true };
      }
      track.status = target;
      await store.saveTrack(track);
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "track_closed",
          track_id: track.id,
          project_id: track.project_id,
          payload: {
            status: target,
            reason,
            outcome,
            turn_count: track.turn_count,
            pr,
            pr_verified: prVerified,
          },
        },
        track.project_id,
      );
      return {
        ok: true,
        track: trackDump(track),
        closed_as: target,
        pr_verified: prVerified,
        idempotent: false,
      };
    });
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in track_close: ${(exc as Error).message}`,
      hint: "check state store permissions",
    };
  }
}

// ---------------------------------------------------------------------------
// mirror steps (d-21, d-3)
// ---------------------------------------------------------------------------

const MCP_TO_TODO_OP: Record<string, string> = {
  pending: "append",
  ready: "append",
  running: "start",
  blocked: "block",
  done: "done",
};

async function resolveHarness(
  store: Store,
  track: { project_id: string; leader: { harness: string } | null; epic: string },
): Promise<string> {
  let raw = "";
  try {
    const project = await store.getProject(track.project_id);
    if (project !== null && (project as { harness?: string }).harness)
      raw = (project as { harness: string }).harness;
  } catch {
    /* fall through */
  }
  if (!raw) {
    const leader = track.leader;
    if (leader !== null && leader.harness) raw = leader.harness;
  }
  if (raw === "paseo" || !(KNOWN_HARNESSES as readonly string[]).includes(raw)) return "omp";
  return raw;
}

export async function mirrorStep(
  store: Store,
  track: { project_id: string; leader: { harness: string; agent_id: string } | null; epic: string },
  action: string,
  title: string,
  status = "",
): Promise<Record<string, unknown>> {
  const harness = await resolveHarness(store, track);
  if (harness === "omp") {
    if (action === "add") {
      return {
        harness: "omp",
        tool_mcp: "todo",
        args: { op: "append", phase: track.epic || "track", items: [title] },
        note: "agent-scoped: execute in your native session same turn (server never writes harness state, d-3). Native todos key by text — match by title; the MCP task id stays server-side.",
      };
    }
    if (status) {
      return {
        harness: "omp",
        tool_mcp: "todo",
        args: { op: MCP_TO_TODO_OP[status] ?? "start", task: title },
        note: "agent-scoped: execute in your native session same turn (d-3).",
      };
    }
    return {
      harness: "omp",
      tool_mcp: "todo",
      args: null,
      note: "progress-only update: no native equivalent — MCP is source of truth for %; mirror natively only on status transitions.",
    };
  }
  return {
    harness,
    tool_mcp: null,
    args: { title, action, status },
    note: "mirror manually in the session-native tasks tool same turn; MCP stays source of truth (only omp has a verified native shape).",
  };
}

// ---------------------------------------------------------------------------
// task_add
// ---------------------------------------------------------------------------

export async function taskAdd(
  store: Store,
  trackId: string,
  title: string,
  detail = "",
  gate = "ready",
  assignee = "",
): Promise<Record<string, unknown>> {
  const refusal = await refuseSystemTrackWrite(store, trackId, "task_add");
  if (refusal !== null) return refusal;
  try {
    if (!title) return { ok: false, error: "title is required" };
    if (!(TASK_GATES as readonly string[]).includes(gate)) {
      return { ok: false, error: `invalid gate ${pyRepr(gate)}`, hint: TASK_GATES.join(" | ") };
    }
    let track;
    try {
      track = await store.getTrack(trackId);
    } catch (exc) {
      return { ok: false, error: `track not found: ${trackId}: ${(exc as Error).message}` };
    }
    const item = await store.lock(`track-${trackId}`, async () => {
      const created = makeQueueItem({ title, detail, gate, assignee });
      track.queue.push(created);
      await store.saveTrack(track);
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "task_added",
          track_id: track.id,
          project_id: track.project_id,
          payload: { task_id: created.id, title, gate, assignee },
        },
        track.project_id,
      );
      return created;
    });
    return {
      ok: true,
      task: queueItemDump(item),
      mirror: await mirrorStep(store, track, "add", title),
    };
  } catch (exc) {
    return { ok: false, error: `unexpected error in task_add: ${(exc as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// track_override
// ---------------------------------------------------------------------------

export async function trackOverride(
  store: Store,
  trackId: string,
  override: unknown,
  ownerApproved = false,
  evidence = "",
  author = "",
): Promise<Record<string, unknown>> {
  try {
    if (!trackId || !String(trackId).trim()) {
      return { ok: false, error: "track_id must be a non-empty string", hint: "provide track_id" };
    }
    if (ownerApproved !== true) {
      return {
        ok: false,
        error: "track_override requires owner approval",
        hint: "pass owner_approved=True with evidence quote/reference of owner directive",
      };
    }
    if (typeof evidence !== "string" || !evidence.trim()) {
      return {
        ok: false,
        error: "track_override requires evidence",
        hint: "provide non-empty evidence: quote/reference of owner directive",
      };
    }
    if (
      override === null ||
      typeof override !== "object" ||
      Array.isArray(override) ||
      !Object.keys(override).length
    ) {
      return {
        ok: false,
        error: "override must be a non-empty dict",
        hint: "provide {key: value} overrides (e.g. md_token_min, heartbeat_cadence, dispatch_rules)",
      };
    }
    try {
      await store.getTrack(trackId);
    } catch (exc) {
      if (exc instanceof StateError) {
        return {
          ok: false,
          error: `track not found: ${trackId}: ${(exc as Error).message}`,
          hint: "track_list for valid ids",
        };
      }
      throw exc;
    }
    const result = await store.lock(`track-${trackId}`, async () => {
      const track = await store.getTrack(trackId);
      const now = utcnowIso();
      let authorResolved: string;
      if (typeof author === "string" && author.trim()) authorResolved = author.trim();
      else if (track.leader && track.leader.agent_id) authorResolved = track.leader.agent_id;
      else authorResolved = "owner";
      if (track.overrides === null || track.overrides === undefined) track.overrides = {};
      if (track.overrides_provenance === null || track.overrides_provenance === undefined)
        track.overrides_provenance = {};
      for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
        track.overrides[key] = value;
        track.overrides_provenance[key] = {
          evidence: evidence.trim(),
          author: authorResolved,
          ts: now,
          value,
        };
      }
      await store.saveTrack(track);
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "override_recorded",
          track_id: track.id,
          project_id: track.project_id,
          payload: {
            override: { ...(override as Record<string, unknown>) },
            evidence: evidence.trim(),
            author: authorResolved,
            ts: now,
            overrides: { ...track.overrides },
          },
        },
        track.project_id,
      );
      return {
        ok: true,
        track_id: track.id,
        overrides: { ...track.overrides },
        overrides_provenance: { ...track.overrides_provenance },
      };
    });
    return result;
  } catch (exc) {
    return {
      ok: false,
      error: `unexpected error in track_override: ${(exc as Error).message}`,
      hint: "check inputs",
    };
  }
}

// ---------------------------------------------------------------------------
// task_update
// ---------------------------------------------------------------------------

function resolveAmendAuthor(
  track: { leader: { agent_id: string } | null },
  author: string,
): string {
  if (typeof author === "string" && author.trim()) return author.trim();
  if (track.leader && track.leader.agent_id) return track.leader.agent_id;
  return "leader";
}

export async function taskUpdate(
  store: Store,
  trackId: string,
  taskId: string,
  status = "",
  progress = -1,
  assignee = "",
  note = "",
  detail = "",
  amendReason = "",
  author = "",
): Promise<Record<string, unknown>> {
  try {
    if (status && !(TASK_STATUSES as readonly string[]).includes(status)) {
      return {
        ok: false,
        error: `invalid status ${pyRepr(status)}`,
        hint: TASK_STATUSES.join(" | "),
      };
    }
    let prog: unknown = progress;
    if (typeof prog === "boolean") prog = prog ? 1 : 0;
    if (typeof prog !== "number" || (prog !== -1 && !(prog >= 0 && prog <= 100))) {
      // Mirrors CPython: non-numeric progress raises TypeError out of the
      // chained comparison (bools are ints in Python, hence the coercion
      // above); out-of-range ints return the contract error.
      if (typeof prog !== "number") {
        throw new TypeError(
          `'<=' not supported between instances of 'int' and '${pyTypeName(prog)}'`,
        );
      }
      return { ok: false, error: "progress must be 0..100" };
    }
    const progressNum = prog as number;
    let track;
    try {
      track = await store.getTrack(trackId);
    } catch (exc) {
      return { ok: false, error: `track not found: ${trackId}: ${(exc as Error).message}` };
    }
    const outcome = await store.lock(`track-${trackId}`, async () => {
      const now = utcnowIso();
      const item = track.queue.find((q) => q.id === taskId) ?? null;
      if (item === null) {
        return {
          ok: false as const,
          error: `task not found: ${taskId}`,
          hint: "track_status .tasks for ids",
        };
      }
      const changes: Record<string, unknown> = {};
      let amended = false;
      if (status) {
        item.status = status;
        changes["status"] = status;
      }
      if (prog !== -1) {
        item.progress = progressNum;
        changes["progress"] = progressNum;
      }
      if (assignee) {
        item.assignee = assignee;
        changes["assignee"] = assignee;
      }
      if (note) {
        item.note = note;
        changes["note"] = note;
      }
      if (detail && detail !== item.detail) {
        const previousDetail = item.detail;
        const authorResolved = resolveAmendAuthor(track, author);
        // amend_reason.strip() raises AttributeError on non-strings BEFORE the
        // trail append (dict builds left-to-right) — mirrored here.
        if (typeof amendReason !== "string") {
          throw new Error(`'${pyTypeName(amendReason)}' object has no attribute 'strip'`);
        }
        const reasonStr = amendReason.trim();
        item.detail_amendments.push({
          ts: now,
          by: authorResolved,
          reason: reasonStr,
          previous: previousDetail,
          amended: detail,
        });
        item.detail = detail;
        amended = true;
        changes["detail"] = detail;
        changes["previous_detail"] = previousDetail;
        changes["amended_by"] = authorResolved;
        if (amendReason.trim()) changes["amend_reason"] = amendReason.trim();
      }
      item.updated_at = now;
      await store.saveTrack(track);
      await store.appendEvent(
        {
          ts: utcnowIso(),
          type: "task_updated",
          track_id: track.id,
          project_id: track.project_id,
          payload: { task_id: taskId, title: item.title, changes, by: assignee || "leader" },
        },
        track.project_id,
      );
      return {
        ok: true as const,
        task: queueItemDump(item),
        amended,
        amendments: item.detail_amendments.length,
        mirror: await mirrorStep(store, track, "update", item.title, status),
      };
    });
    return outcome as Record<string, unknown>;
  } catch (exc) {
    return { ok: false, error: `unexpected error in task_update: ${(exc as Error).message}` };
  }
}
