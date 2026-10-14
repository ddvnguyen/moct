/**
 * Team Room read models. The ledger log (team_operations) stays the source of
 * truth; this file folds operation kinds into tables the backend can query without
 * replaying the log:
 *
 *   team/session-turn-recorded  -> team_turns           (usage per Turn)
 *   team/thread-session-bound   -> team_thread_bindings (Thread -> Session)
 *   team/thread-instance-bound  -> team_thread_bindings (Thread -> Instance slot)
 *   team/thread-summary-committed -> team_thread_summaries (summary generation)
 *
 * Projection runs inside the append transaction, so a stored operation and its
 * read-model row commit together. Every write is idempotent: re-projecting an
 * operation (backfill, replay) changes nothing. A figure the operation does not
 * report is stored NULL, never 0, so a sum can say how many Turns it did not cover.
 */
import { utcnowIso } from "../domain/models.js";
import type { TeamDb } from "../store/team-db.js";
import type { OperationRecord } from "./store.js";

/** One replay page, the shape TeamRoomStore.page returns. */
export type PageReader = (workspaceId: string, afterSequence: number) => Promise<{ operations: OperationRecord[]; hasMore: boolean }>;

export const KIND_TURN_RECORDED = "team/session-turn-recorded";
export const KIND_SESSION_BOUND = "team/thread-session-bound";
export const KIND_INSTANCE_BOUND = "team/thread-instance-bound";
export const KIND_SUMMARY_COMMITTED = "team/thread-summary-committed";

/** meta key that records the one-time backfill of operations stored before v7. */
export const PROJECTION_META_KEY = "team_projection:1";

/**
 * meta key for the one-time fold of thread summaries stored before the projection
 * existed. It is deliberately NOT PROJECTION_META_KEY: the shared marker already
sits in every live DB (it was written by the v7 backfill on 2026-10-13), so reusing
it would make the summary fold a no-op on every existing database and leave every
already-committed summary unread.
 */
export const SUMMARY_PROJECTION_META_KEY = "team_projection:summaries:1";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A reported count. Anything that is not a non-negative safe integer is "not reported". */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Fold one stored operation into every read model it has a projector for. */
export async function projectOperation(db: TeamDb, workspaceId: string, record: OperationRecord): Promise<void> {
  const data = record["data"];
  if (!isObject(data)) return;
  switch (record.kind) {
    case KIND_TURN_RECORDED:
      return projectTurn(db, workspaceId, record, data);
    case KIND_SESSION_BOUND:
      return projectSessionBound(db, workspaceId, record, data);
    case KIND_INSTANCE_BOUND:
      return projectInstanceBound(db, workspaceId, record, data);
    case KIND_SUMMARY_COMMITTED:
      return projectSummaryCommitted(db, record, data);
    default:
      return;
  }
}

async function projectTurn(db: TeamDb, workspaceId: string, record: OperationRecord, data: Json): Promise<void> {
  const sessionId = text(data["sessionId"]);
  const memberId = text(data["memberId"]);
  const endedAt = text(data["endedAt"]);
  if (sessionId === null || memberId === null || endedAt === null) return;
  const usage = isObject(data["usage"]) ? data["usage"] : {};
  const threadRefs = Array.isArray(data["threadRefs"]) ? data["threadRefs"].filter((ref) => typeof ref === "string") : [];
  await db.run(
    `INSERT OR IGNORE INTO team_turns(workspace_id, sequence, operation_id, session_id, member_id, turn, started_at, ended_at,
       tool_calls, run_ms, uncached_input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, thread_refs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    workspaceId,
    record.sequence,
    record.operationId,
    sessionId,
    memberId,
    count(data["turn"]),
    text(data["startedAt"]),
    endedAt,
    count(data["toolCalls"]) ?? 0,
    count(data["runMs"]) ?? 0,
    count(usage["uncachedInputTokens"]),
    count(usage["outputTokens"]),
    count(usage["cacheReadTokens"]),
    count(usage["cacheWriteTokens"]),
    count(usage["reasoningTokens"]),
    JSON.stringify(threadRefs),
  );
}

interface BindingRow {
  sessionSequence: number | null;
  slotSequence: number | null;
}

async function readBinding(db: TeamDb, workspaceId: string, threadRef: string, memberId: string): Promise<BindingRow | undefined> {
  const row = await db.get(
    "SELECT session_sequence, slot_sequence FROM team_thread_bindings WHERE workspace_id = ? AND thread_ref = ? AND member_id = ?",
    workspaceId,
    threadRef,
    memberId,
  );
  if (row === undefined) return undefined;
  return {
    sessionSequence: row["session_sequence"] == null ? null : Number(row["session_sequence"]),
    slotSequence: row["slot_sequence"] == null ? null : Number(row["slot_sequence"]),
  };
}

async function projectSessionBound(db: TeamDb, workspaceId: string, record: OperationRecord, data: Json): Promise<void> {
  const threadRef = text(data["threadRef"]);
  const memberId = text(data["memberId"]);
  const sessionId = text(data["sessionId"]);
  if (threadRef === null || memberId === null || sessionId === null) return;
  const existing = await readBinding(db, workspaceId, threadRef, memberId);
  if (existing === undefined) {
    await db.run(
      "INSERT INTO team_thread_bindings(workspace_id, thread_ref, member_id, session_id, session_reason, session_sequence) VALUES (?, ?, ?, ?, ?, ?)",
      workspaceId,
      threadRef,
      memberId,
      sessionId,
      text(data["reason"]),
      record.sequence,
    );
    return;
  }
  if (existing.sessionSequence !== null && existing.sessionSequence >= record.sequence) return;
  await db.run(
    "UPDATE team_thread_bindings SET session_id = ?, session_reason = ?, session_sequence = ? WHERE workspace_id = ? AND thread_ref = ? AND member_id = ?",
    sessionId,
    text(data["reason"]),
    record.sequence,
    workspaceId,
    threadRef,
    memberId,
  );
}

async function projectInstanceBound(db: TeamDb, workspaceId: string, record: OperationRecord, data: Json): Promise<void> {
  const threadRef = text(data["threadRef"]);
  const memberId = text(data["memberId"]);
  const slot = count(data["slot"]);
  if (threadRef === null || memberId === null || slot === null) return;
  const boundAt = text(data["boundAt"]);
  const existing = await readBinding(db, workspaceId, threadRef, memberId);
  if (existing === undefined) {
    await db.run(
      "INSERT INTO team_thread_bindings(workspace_id, thread_ref, member_id, slot, slot_bound_at, slot_sequence) VALUES (?, ?, ?, ?, ?, ?)",
      workspaceId,
      threadRef,
      memberId,
      slot,
      boundAt,
      record.sequence,
    );
    return;
  }
  if (existing.slotSequence !== null && existing.slotSequence >= record.sequence) return;
  await db.run(
    "UPDATE team_thread_bindings SET slot = ?, slot_bound_at = ?, slot_sequence = ? WHERE workspace_id = ? AND thread_ref = ? AND member_id = ?",
    slot,
    boundAt,
    record.sequence,
    workspaceId,
    threadRef,
    memberId,
  );
}

/**
 * team/thread-summary-committed -> team_thread_summaries.
 *
 * The v6 table is the read model of a summary generation and is keyed
 * (thread_ref, generation); the ledger is where a summary is written, so this
 * projection exists only to make the ledger's summaries readable through
 * GET /team/v1/thread-summaries/... without replaying the log.
 *
 * Field mapping, and why: the operation's transcriptTokens is the summary's token
 * count and lands in the table's tokens column (the operation calls it
 * transcriptTokens, the column calls it tokens). The operation carries model as a
 * {provider, model} object where the table has one TEXT column, so it is stored as
 * provider/model, which round-trips without guessing which half a bare name meant.
 * The operation also carries usage, which has no column: it is not projected, and
 * adding a column to a v6 table is a schema change this projection does not make.
 *
 * Idempotence follows the table's own rule: a (thread_ref, generation) row that is
 * already stored with the same content is a replay and changes nothing; a different
 * body under a stored generation is also left alone, because the ledger validated
 * the summary's own monotonicity on commit and a second writer for the same
 * generation is a conflict this must not paper over. Nothing here reads
 * latestSummary, so a backfilled generation never hides an earlier one.
 */
async function projectSummaryCommitted(db: TeamDb, record: OperationRecord, data: Json): Promise<void> {
  const threadRef = text(data["threadRef"]);
  const generation = count(data["generation"]);
  const trigger = data["trigger"];
  const body = text(data["text"]);
  if (threadRef === null || generation === null || generation < 1) return;
  if (trigger !== "rolling" && trigger !== "wrapup") return;
  if (body === null) return;
  const coversThroughSequence = count(data["coversThroughSequence"]) ?? 0;
  const tokens = count(data["transcriptTokens"]) ?? 0;
  const at = text(data["at"]) ?? text(record["occurredAt"]) ?? "";
  const model = summaryModel(data["model"]);
  await db.run(
    "INSERT OR IGNORE INTO team_thread_summaries(thread_ref, generation, trigger, text, covers_through_sequence, tokens, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    threadRef,
    generation,
    trigger,
    body,
    coversThroughSequence,
    tokens,
    model,
    at,
  );
}

/** A {provider, model} object on the wire becomes provider/model in the one text column. */
function summaryModel(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isObject(value)) return "";
  const provider = text(value["provider"]);
  const model = text(value["model"]);
  if (provider === null && model === null) return "";
  if (provider === null) return model ?? "";
  if (model === null) return provider;
  return provider + "/" + model;
}

/**
 * One-time fold of the summary operations a database already stored. The pass has its
 * own marker because the shared v7 marker is already set on every live DB, so reusing
 * it would skip this fold there and leave committed summaries unread.
 *
 * Pages by sequence so the pass is bounded by memory, and INSERT OR IGNORE means a
 * fresh database that already projected these operations in the append transaction is
 * left untouched.
 */
export async function backfillSummaryProjection(db: TeamDb, page: PageReader): Promise<{ projected: number; skipped: boolean }> {
  return db.transaction(async () => {
    const done = await db.get("SELECT value FROM meta WHERE key = ?", SUMMARY_PROJECTION_META_KEY);
    if (done !== undefined) return { projected: 0, skipped: true };
    const workspaces = await db.all("SELECT DISTINCT workspace_id FROM team_operations ORDER BY workspace_id");
    let projected = 0;
    for (const row of workspaces) {
      const workspaceId = String(row["workspace_id"]);
      let after = 0;
      for (;;) {
        const batch = await page(workspaceId, after);
        if (batch.operations.length === 0) break;
        for (const record of batch.operations) {
          if (record.kind !== KIND_SUMMARY_COMMITTED) continue;
          await projectOperation(db, workspaceId, record);
          projected += 1;
        }
        const last = batch.operations[batch.operations.length - 1]!;
        if (!batch.hasMore) break;
        after = last.sequence;
      }
    }
    await db.run("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)", SUMMARY_PROJECTION_META_KEY, utcnowIso());
    return { projected, skipped: false };
  });
}
