/**
 * Team Room store (contract v0.3 §2–3). Owns the three v6 tables and nothing
 * else: team_operations (append-only ledger log), team_session_runs (SessionRun
 * stats), team_thread_summaries (rolling and wrap-up summaries). It codes
 * against TeamDb, so it never touches the Turso driver.
 *
 * Writes run inside TeamDb.transaction (BEGIN IMMEDIATE on the shared
 * connection). The duplicate checks happen inside that transaction, so two
 * concurrent POSTs cannot both pass them.
 */
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { TeamDb } from "../store/team-db.js";
import { utcnowIso } from "../domain/models.js";
import { PROJECTION_META_KEY, projectOperation } from "./projection.js";
import { TeamMemoryStore } from "./memory.js";

export type OperationRecord = Record<string, unknown> & {
  sequence: number;
  operationId: string;
  kind: string;
};

export type AppendOutcome =
  | { status: "stored" }
  | { status: "replayed" }
  | { status: "sequence-conflict" }
  | { status: "operation-id-conflict" };

export interface SessionRunRow {
  sessionId: string;
  memberId: string;
  parentSessionId?: string;
  threadRefs: string[];
  startedAt: string;
  endedAt?: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  runMs: number;
  model: { provider: string; model: string };
  lastAssistantAt?: string;
  state: "warm" | "cold" | "closed";
}

export interface SummaryRow {
  threadRef: string;
  generation: number;
  trigger: "rolling" | "wrapup";
  text: string;
  coversThroughSequence: number;
  tokens: number;
  model: string;
  at: string;
}

export interface UsageQuery {
  workspaceId: string;
  groupBy: "member" | "day" | "session" | "total";
  memberId?: string;
  since?: string;
  until?: string;
}

export interface UsageRow {
  key: string;
  turns: number;
  toolCalls: number;
  runMs: number;
  uncachedInputTokens: number;
  unknownInputTurns: number;
  outputTokens: number;
  unknownOutputTurns: number;
  cacheReadTokens: number;
  unknownCacheReadTurns: number;
  cacheWriteTokens: number;
  unknownCacheWriteTurns: number;
  reasoningTokens: number;
  unknownReasoningTurns: number;
  firstEndedAt: string;
  lastEndedAt: string;
}

export interface BindingRecord {
  threadRef: string;
  memberId: string;
  sessionId: string | null;
  sessionReason: string | null;
  slot: number | null;
  slotBoundAt: string | null;
}

const MAX_BACKFILL_PAGE = 1000;

export type SummaryOutcome =
  | { status: "stored" }
  | { status: "replayed" }
  | { status: "generation-stale"; latest: number }
  | { status: "generation-conflict" };

/** Stable JSON: sorted keys at every depth, so a re-serialised retry compares equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** LIKE pattern for a JSON-array member, with %, _ and \ escaped. */
function likeMember(ref: string): string {
  const escaped = JSON.stringify(ref).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

export class TeamRoomStore {
  /** Team memory (schema v8): backend-owned tables on the same connection. */
  readonly memory: TeamMemoryStore;

  /** `dbPath` is reported by /team/v1/health so an operator can see which fleet.db is live. */
  constructor(
    private readonly db: TeamDb,
    readonly dbPath: string | null = null,
    readonly backupDir: string | null = null,
    now?: () => Date,
  ) {
    this.memory = new TeamMemoryStore(db, now);
  }

  /** Consistent copy of fleet.db into backupDir, on the live connection. */
  async backup(stamp: string): Promise<string> {
    if (this.backupDir === null) throw new Error("backup directory is not configured");
    await mkdir(this.backupDir, { recursive: true });
    const file = path.join(this.backupDir, `moct-${stamp}.db`);
    await this.db.vacuumInto(file);
    return file;
  }

  /** `sequence` is never renumbered; a duplicate sequence is a conflict, not a retry. */
  async append(workspaceId: string, record: OperationRecord): Promise<AppendOutcome> {
    return this.db.transaction(async () => {
      const existing = await this.db.get(
        "SELECT workspace_id, record_json FROM team_operations WHERE operation_id = ?",
        record.operationId,
      );
      if (existing !== undefined) {
        const same =
          existing["workspace_id"] === workspaceId &&
          canonicalJson(JSON.parse(String(existing["record_json"]))) === canonicalJson(record);
        return { status: same ? "replayed" : "operation-id-conflict" } as const;
      }
      const taken = await this.db.get(
        "SELECT 1 AS taken FROM team_operations WHERE workspace_id = ? AND sequence = ?",
        workspaceId,
        record.sequence,
      );
      if (taken !== undefined) return { status: "sequence-conflict" } as const;
      const occurredAt = typeof record["at"] === "string" ? record["at"] : utcnowIso();
      await this.db.run(
        "INSERT INTO team_operations(workspace_id, sequence, operation_id, kind, record_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
        workspaceId,
        record.sequence,
        record.operationId,
        record.kind,
        JSON.stringify(record),
        occurredAt,
      );
      await projectOperation(this.db, workspaceId, record);
      return { status: "stored" } as const;
    });
  }

  /**
   * One-time fold of operations stored before schema v7 into the read models.
   * The marker is written in the same transaction, so a failed backfill leaves no
   * marker and the next start tries again. Projection is idempotent, so a retry
   * after a partial run changes nothing it already wrote.
   */
  async backfillProjections(): Promise<{ projected: number; skipped: boolean }> {
    return this.db.transaction(async () => {
      const done = await this.db.get("SELECT value FROM meta WHERE key = ?", PROJECTION_META_KEY);
      if (done !== undefined) return { projected: 0, skipped: true };
      const workspaces = await this.db.all("SELECT DISTINCT workspace_id FROM team_operations ORDER BY workspace_id");
      let projected = 0;
      for (const row of workspaces) {
        const workspaceId = String(row["workspace_id"]);
        let after = 0;
        for (;;) {
          const page = await this.page(workspaceId, after, MAX_BACKFILL_PAGE);
          for (const record of page.operations) {
            await projectOperation(this.db, workspaceId, record);
            projected += 1;
          }
          const last = page.operations[page.operations.length - 1];
          if (!page.hasMore || last === undefined) break;
          after = last.sequence;
        }
      }
      await this.db.run("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)", PROJECTION_META_KEY, utcnowIso());
      return { projected, skipped: false };
    });
  }

  /**
   * Token and Turn totals from team_turns. A figure a Turn did not report is NULL,
   * so `unknown*Turns` says how many Turns a sum does not cover. since/until are
   * ISO instants compared against the Turn's endedAt (inclusive / exclusive).
   */
  async usage(query: UsageQuery): Promise<UsageRow[]> {
    const keyExpr =
      query.groupBy === "day"
        ? "substr(ended_at, 1, 10)"
        : query.groupBy === "session"
          ? "session_id"
          : query.groupBy === "total"
            ? "'total'"
            : "member_id";
    const where = ["workspace_id = ?"];
    const params: unknown[] = [query.workspaceId];
    if (query.memberId !== undefined) {
      where.push("member_id = ?");
      params.push(query.memberId);
    }
    if (query.since !== undefined) {
      where.push("ended_at >= ?");
      params.push(query.since);
    }
    if (query.until !== undefined) {
      where.push("ended_at < ?");
      params.push(query.until);
    }
    const rows = await this.db.all(
      `SELECT ${keyExpr} AS key,
         COUNT(*) AS turns,
         COALESCE(SUM(tool_calls), 0) AS tool_calls,
         COALESCE(SUM(run_ms), 0) AS run_ms,
         COALESCE(SUM(uncached_input_tokens), 0) AS uncached_input_tokens,
         COUNT(*) - COUNT(uncached_input_tokens) AS unknown_input_turns,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COUNT(*) - COUNT(output_tokens) AS unknown_output_turns,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COUNT(*) - COUNT(cache_read_tokens) AS unknown_cache_read_turns,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COUNT(*) - COUNT(cache_write_tokens) AS unknown_cache_write_turns,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COUNT(*) - COUNT(reasoning_tokens) AS unknown_reasoning_turns,
         MIN(ended_at) AS first_ended_at,
         MAX(ended_at) AS last_ended_at
       FROM team_turns WHERE ${where.join(" AND ")} GROUP BY ${keyExpr} ORDER BY ${keyExpr}`,
      ...params,
    );
    return rows.map((row) => ({
      key: String(row["key"]),
      turns: Number(row["turns"]),
      toolCalls: Number(row["tool_calls"]),
      runMs: Number(row["run_ms"]),
      uncachedInputTokens: Number(row["uncached_input_tokens"]),
      unknownInputTurns: Number(row["unknown_input_turns"]),
      outputTokens: Number(row["output_tokens"]),
      unknownOutputTurns: Number(row["unknown_output_turns"]),
      cacheReadTokens: Number(row["cache_read_tokens"]),
      unknownCacheReadTurns: Number(row["unknown_cache_read_turns"]),
      cacheWriteTokens: Number(row["cache_write_tokens"]),
      unknownCacheWriteTurns: Number(row["unknown_cache_write_turns"]),
      reasoningTokens: Number(row["reasoning_tokens"]),
      unknownReasoningTurns: Number(row["unknown_reasoning_turns"]),
      firstEndedAt: String(row["first_ended_at"]),
      lastEndedAt: String(row["last_ended_at"]),
    }));
  }

  /** Current Thread -> Session and Thread -> slot bindings, for one Thread or one Member. */
  async bindings(workspaceId: string, by: { threadRef: string } | { memberId: string }): Promise<BindingRecord[]> {
    const rows =
      "threadRef" in by
        ? await this.db.all(
            "SELECT * FROM team_thread_bindings WHERE workspace_id = ? AND thread_ref = ? ORDER BY member_id",
            workspaceId,
            by.threadRef,
          )
        : await this.db.all(
            "SELECT * FROM team_thread_bindings WHERE workspace_id = ? AND member_id = ? ORDER BY thread_ref",
            workspaceId,
            by.memberId,
          );
    return rows.map((row) => ({
      threadRef: String(row["thread_ref"]),
      memberId: String(row["member_id"]),
      sessionId: row["session_id"] == null ? null : String(row["session_id"]),
      sessionReason: row["session_reason"] == null ? null : String(row["session_reason"]),
      slot: row["slot"] == null ? null : Number(row["slot"]),
      slotBoundAt: row["slot_bound_at"] == null ? null : String(row["slot_bound_at"]),
    }));
  }

  /** One replay page, ordered by sequence. Reads one row past the limit to report hasMore. */
  async page(
    workspaceId: string,
    afterSequence: number,
    limit: number,
  ): Promise<{ operations: OperationRecord[]; hasMore: boolean }> {
    const rows = await this.db.all(
      "SELECT sequence, record_json FROM team_operations WHERE workspace_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
      workspaceId,
      afterSequence,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const operations = rows
      .slice(0, limit)
      .map((row) => JSON.parse(String(row["record_json"])) as OperationRecord);
    return { operations, hasMore };
  }

  async head(workspaceId: string): Promise<number> {
    const row = await this.db.get(
      "SELECT MAX(sequence) AS head FROM team_operations WHERE workspace_id = ?",
      workspaceId,
    );
    return Number(row?.["head"] ?? 0);
  }

  async upsertSessionRun(run: SessionRunRow): Promise<void> {
    await this.db.transaction(() =>
      this.db.run(
        `INSERT INTO team_session_runs(session_id, member_id, parent_session_id, thread_refs_json, started_at, ended_at,
           tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, tool_calls, run_ms,
           model_provider, model_name, last_assistant_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           member_id = excluded.member_id,
           parent_session_id = excluded.parent_session_id,
           thread_refs_json = excluded.thread_refs_json,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           tokens_in = excluded.tokens_in,
           tokens_out = excluded.tokens_out,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_write_tokens = excluded.cache_write_tokens,
           tool_calls = excluded.tool_calls,
           run_ms = excluded.run_ms,
           model_provider = excluded.model_provider,
           model_name = excluded.model_name,
           last_assistant_at = excluded.last_assistant_at,
           state = excluded.state`,
        run.sessionId,
        run.memberId,
        run.parentSessionId ?? null,
        JSON.stringify(run.threadRefs),
        run.startedAt,
        run.endedAt ?? null,
        run.tokensIn,
        run.tokensOut,
        run.cacheReadTokens,
        run.cacheWriteTokens,
        run.toolCalls,
        run.runMs,
        run.model.provider,
        run.model.model,
        run.lastAssistantAt ?? null,
        run.state,
      ),
    );
  }

  async sessionRunsForMember(memberId: string): Promise<SessionRunRow[]> {
    const rows = await this.db.all(
      "SELECT * FROM team_session_runs WHERE member_id = ? ORDER BY started_at",
      memberId,
    );
    return rows.map(toSessionRun);
  }

  /** Runs whose thread_refs contain the ref. LIKE narrows; the exact check is in code. */
  async sessionRunsForThread(threadRef: string): Promise<SessionRunRow[]> {
    const rows = await this.db.all(
      "SELECT * FROM team_session_runs WHERE thread_refs_json LIKE ? ESCAPE '\\' ORDER BY started_at",
      likeMember(threadRef),
    );
    return rows.map(toSessionRun).filter((run) => run.threadRefs.includes(threadRef));
  }

  /**
   * Generation N+1 must be strictly newer than the latest stored generation.
   * Re-sending the same generation with the same content is a replay (200).
   * The same generation with different content is a conflict (409).
   */
  async putSummary(summary: SummaryRow): Promise<SummaryOutcome> {
    return this.db.transaction(async () => {
      const same = await this.db.get(
        "SELECT * FROM team_thread_summaries WHERE thread_ref = ? AND generation = ?",
        summary.threadRef,
        summary.generation,
      );
      if (same !== undefined) {
        return (toSummary(same) as SummaryRow).text === summary.text &&
          (toSummary(same) as SummaryRow).coversThroughSequence === summary.coversThroughSequence
          ? ({ status: "replayed" } as const)
          : ({ status: "generation-conflict" } as const);
      }
      const latest = await this.latestSummary(summary.threadRef);
      if (latest !== undefined && latest.generation > summary.generation) {
        return { status: "generation-stale", latest: latest.generation } as const;
      }
      await this.db.run(
        "INSERT INTO team_thread_summaries(thread_ref, generation, trigger, text, covers_through_sequence, tokens, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        summary.threadRef,
        summary.generation,
        summary.trigger,
        summary.text,
        summary.coversThroughSequence,
        summary.tokens,
        summary.model,
        summary.at,
      );
      return { status: "stored" } as const;
    });
  }

  async latestSummary(threadRef: string): Promise<SummaryRow | undefined> {
    const row = await this.db.get(
      "SELECT * FROM team_thread_summaries WHERE thread_ref = ? ORDER BY generation DESC LIMIT 1",
      threadRef,
    );
    return row === undefined ? undefined : toSummary(row);
  }
}

function toSessionRun(row: Record<string, unknown>): SessionRunRow {
  return {
    sessionId: String(row["session_id"]),
    memberId: String(row["member_id"]),
    ...(row["parent_session_id"] != null ? { parentSessionId: String(row["parent_session_id"]) } : {}),
    threadRefs: JSON.parse(String(row["thread_refs_json"])) as string[],
    startedAt: String(row["started_at"]),
    ...(row["ended_at"] != null ? { endedAt: String(row["ended_at"]) } : {}),
    tokensIn: Number(row["tokens_in"]),
    tokensOut: Number(row["tokens_out"]),
    cacheReadTokens: Number(row["cache_read_tokens"]),
    cacheWriteTokens: Number(row["cache_write_tokens"]),
    toolCalls: Number(row["tool_calls"]),
    runMs: Number(row["run_ms"]),
    model: { provider: String(row["model_provider"]), model: String(row["model_name"]) },
    ...(row["last_assistant_at"] != null
      ? { lastAssistantAt: String(row["last_assistant_at"]) }
      : {}),
    state: String(row["state"]) as SessionRunRow["state"],
  };
}

function toSummary(row: Record<string, unknown>): SummaryRow {
  return {
    threadRef: String(row["thread_ref"]),
    generation: Number(row["generation"]),
    trigger: String(row["trigger"]) as SummaryRow["trigger"],
    text: String(row["text"]),
    coversThroughSequence: Number(row["covers_through_sequence"]),
    tokens: Number(row["tokens"]),
    model: String(row["model"]),
    at: String(row["at"]),
  };
}
