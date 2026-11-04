import type { AgentTask } from "../fork";

/**
 * Which running MMX turn owns each dsh session, outside React.
 *
 * The composer takeover in the dsh chat has to answer one question at render
 * time — "is this session driven by a Multica run I may steer?" — and it has to
 * answer it from the shell's React 18 tree, where none of this package's hooks
 * can run (see `seat.ts`). So the answer lives here: the island's reporter
 * writes it, `selectOwnedSession` reads it, and the takeover component repaints
 * itself when it changes.
 *
 * Ownership is keyed on `session_id`, the session the run actually writes to.
 * `prior_session_id` is wrong for this: a seeded run may abandon the session it
 * resumed from and continue in a fresh one, so a match on the prior id can miss
 * the live turn or collide with the session that replaced it.
 *
 * A session is taken over only when exactly one *running* task claims it, and
 * only when that task negotiated `task-supplement-v1` and the server says this
 * viewer may supplement it. Anything else — no match, two matches, no
 * capability — declines, and the shell's own composer stays in place.
 */

/** The server-negotiated capability a steerable turn must carry. */
export const TASK_SUPPLEMENT_CAPABILITY = "task-supplement-v1";

/** One running MMX turn, reduced to what the takeover needs. */
export interface OwnedSession {
  /** Exact turn a message is bound to; never resolved by agent or issue. */
  taskId: string;
  /** The issue the run belongs to; the supplement route is issue-scoped. */
  issueId: string;
  /** Agent that owns the run, for the takeover's header line. */
  agentId: string;
}

/** One message this composer queued, with the state the server last reported. */
export interface QueuedSupplement {
  /** The comment the supplement created; the promote route names it. */
  commentId: string;
  /** Task the message was bound to. */
  taskId: string;
  /** What the reader typed, kept so the row can show it. */
  content: string;
  /** `queued` until the server flips it, then `steer`. */
  mode: "steer" | "queue";
  /** Server receipt state: `pending`, `delivered`, `failed`, `steered`. */
  status: string;
}

let owned = new Map<string, OwnedSession>();
const listeners = new Set<() => void>();
const queued = new Map<string, QueuedSupplement[]>();

/** True when the task is a live turn this viewer may add a message to. */
export function isSteerableTask(task: AgentTask): boolean {
  return (
    task.status === "running" &&
    task.supplement_capability === TASK_SUPPLEMENT_CAPABILITY &&
    task.can_supplement === true
  );
}

/**
 * Replace the ownership map from one workspace snapshot.
 *
 * Duplicate claims are dropped rather than resolved: two running tasks pinned
 * to one session is not a case this composer can serve correctly (a message
 * could steer the wrong turn), so both decline and the shell keeps its own
 * composer. The server has no structural guard against it — dsh resumes a
 * session, so the same id can legitimately belong to two sequential runs, and
 * only the running ones are considered here.
 */
export function setAgentTasks(tasks: readonly AgentTask[] | null | undefined): void {
  const next = new Map<string, OwnedSession>();
  const clashes = new Set<string>();
  for (const task of tasks ?? []) {
    if (!isSteerableTask(task)) continue;
    const sessionId = task.session_id?.trim() ?? "";
    if (sessionId === "") continue;
    if (next.has(sessionId)) {
      clashes.add(sessionId);
      continue;
    }
    next.set(sessionId, {
      taskId: task.id,
      issueId: task.issue_id,
      agentId: task.agent_id,
    });
  }
  for (const sessionId of clashes) next.delete(sessionId);
  if (sameOwners(owned, next)) return;
  owned = next;
  notify();
}

/** The turn that owns one session, or null when this composer must decline. */
export function selectOwnedSession(sessionId: string | undefined | null): OwnedSession | null {
  if (sessionId === undefined || sessionId === null) return null;
  return owned.get(sessionId) ?? null;
}

/** Observe ownership and queue changes; the returned function unsubscribes. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every message this composer queued for one task, oldest first. */
export function queuedFor(taskId: string): readonly QueuedSupplement[] {
  return queued.get(taskId) ?? [];
}

/** Record a message the server accepted for a later turn. */
export function addQueued(item: QueuedSupplement): void {
  const rows = queued.get(item.taskId) ?? [];
  if (rows.some((row) => row.commentId === item.commentId)) return;
  queued.set(item.taskId, [...rows, item]);
  notify();
}

/** Update one queued row from a server receipt. Unknown rows are ignored. */
export function updateQueued(
  taskId: string,
  commentId: string,
  patch: Partial<Pick<QueuedSupplement, "mode" | "status">>,
): void {
  const rows = queued.get(taskId);
  if (rows === undefined) return;
  let changed = false;
  const next = rows.map((row) => {
    if (row.commentId !== commentId) return row;
    const merged = { ...row, ...patch };
    if (merged.mode === row.mode && merged.status === row.status) return row;
    changed = true;
    return merged;
  });
  if (!changed) return;
  queued.set(taskId, next);
  notify();
}

/** Drop one queued row, e.g. after the turn ended without delivering it. */
export function removeQueued(taskId: string, commentId: string): void {
  const rows = queued.get(taskId);
  if (rows === undefined) return;
  const next = rows.filter((row) => row.commentId !== commentId);
  if (next.length === rows.length) return;
  queued.set(taskId, next);
  notify();
}

/** Clear everything. Tests only: a page reload is what ends a real store. */
export function resetSteerStore(): void {
  owned = new Map();
  queued.clear();
  notify();
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function sameOwners(a: Map<string, OwnedSession>, b: Map<string, OwnedSession>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined) return false;
    if (other.taskId !== value.taskId) return false;
    if (other.issueId !== value.issueId) return false;
    if (other.agentId !== value.agentId) return false;
  }
  return true;
}
