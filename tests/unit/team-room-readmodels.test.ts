/**
 * Team Room read models (schema v7): usage and bindings are folded from stored
 * operations, in the append transaction, against a real scratch fleet.db.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TursoRepository } from "../../src/store/turso-repository.js";
import { TeamRoomStore } from "../../src/team-room/store.js";
import { cleanupHarnesses, postJson, startHarness, type Harness } from "./http-harness.js";

afterEach(cleanupHarnesses);

const WS = "ws-1";
const M1 = "member:one";
const M2 = "member:two";

type Usage = Partial<Record<"uncachedInputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens", number | null>>;

const turnOp = (
  sequence: number,
  memberId: string,
  sessionId: string,
  endedAt: string,
  usage: Usage,
  extra: Record<string, unknown> = {},
) => ({
  sequence,
  operationId: `op-${sequence}`,
  kind: "team/session-turn-recorded",
  data: {
    workspaceId: WS,
    memberId,
    sessionId,
    threadRefs: ["thread:a"],
    turn: sequence,
    startedAt: endedAt,
    endedAt,
    toolCalls: 2,
    runMs: 1000,
    usage: {
      uncachedInputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
      reasoningTokens: null,
      ...usage,
    },
    ...extra,
  },
});

const sessionBound = (sequence: number, threadRef: string, memberId: string, sessionId: string, reason = "new") => ({
  sequence,
  operationId: `op-${sequence}`,
  kind: "team/thread-session-bound",
  data: { workspaceId: WS, threadRef, memberId, sessionId, reason },
});

const instanceBound = (sequence: number, threadRef: string, memberId: string, slot: number) => ({
  sequence,
  operationId: `op-${sequence}`,
  kind: "team/thread-instance-bound",
  data: { workspaceId: WS, threadRef, memberId, slot, boundAt: "2026-10-13T11:52:47.004Z" },
});

async function append(h: Harness, record: unknown, workspaceId = WS): Promise<number> {
  const res = await h.request("/team/v1/operations", postJson({ workspaceId, record }));
  return res.status;
}

async function usage(h: Harness, query: string): Promise<{ status: number; body: any }> {
  const res = await h.get(`/team/v1/usage?${query}`);
  return { status: res.status, body: await res.json() };
}

describe("team room read models — usage", () => {
  it("sums recorded Turns and counts the Turns that did not report a figure", async () => {
    const h = await startHarness();
    expect(await append(h, turnOp(1, M1, "s-1", "2026-10-12T10:00:00.000Z", {}))).toBe(201);
    expect(await append(h, turnOp(2, M1, "s-1", "2026-10-12T11:00:00.000Z", { uncachedInputTokens: null, cacheReadTokens: null }))).toBe(201);
    expect(await append(h, turnOp(3, M2, "s-2", "2026-10-13T09:00:00.000Z", { outputTokens: 40 }))).toBe(201);

    const { status, body } = await usage(h, `workspaceId=${WS}`);
    expect(status).toBe(200);
    expect(body.groupBy).toBe("member");
    expect(body.rows.map((r: any) => r.key)).toEqual([M1, M2]);

    const one = body.rows[0];
    expect(one).toMatchObject({
      turns: 2,
      toolCalls: 4,
      runMs: 2000,
      uncachedInputTokens: 100, // the null Turn adds nothing ...
      unknownInputTurns: 1, // ... and is counted, so the sum is visibly partial
      outputTokens: 20,
      unknownOutputTurns: 0,
      cacheReadTokens: 50,
      unknownCacheReadTurns: 1,
      cacheWriteTokens: 10,
      reasoningTokens: 0,
      unknownReasoningTurns: 2, // never reported: unknown, not zero
      firstEndedAt: "2026-10-12T10:00:00.000Z",
      lastEndedAt: "2026-10-12T11:00:00.000Z",
    });
    expect(body.rows[1]).toMatchObject({ turns: 1, outputTokens: 40 });
  });

  it("groups by day, session and total, and filters by member and time", async () => {
    const h = await startHarness();
    await append(h, turnOp(1, M1, "s-1", "2026-10-12T10:00:00.000Z", {}));
    await append(h, turnOp(2, M1, "s-2", "2026-10-12T23:59:59.000Z", {}));
    await append(h, turnOp(3, M2, "s-3", "2026-10-13T00:00:00.000Z", {}));

    const byDay = await usage(h, `workspaceId=${WS}&groupBy=day`);
    expect(byDay.body.rows.map((r: any) => [r.key, r.turns])).toEqual([["2026-10-12", 2], ["2026-10-13", 1]]);

    const bySession = await usage(h, `workspaceId=${WS}&groupBy=session&memberId=${M1}`);
    expect(bySession.body.rows.map((r: any) => r.key)).toEqual(["s-1", "s-2"]);

    const total = await usage(h, `workspaceId=${WS}&groupBy=total`);
    expect(total.body.rows).toHaveLength(1);
    expect(total.body.rows[0]).toMatchObject({ key: "total", turns: 3 });

    // since is inclusive, until is exclusive.
    const window = await usage(h, `workspaceId=${WS}&groupBy=total&since=2026-10-12T23:59:59.000Z&until=2026-10-13T00:00:00.000Z`);
    expect(window.body.rows[0]).toMatchObject({ turns: 1 });

    const none = await usage(h, `workspaceId=${WS}&memberId=member:nobody`);
    expect(none.body.rows).toEqual([]);
  });

  it("projects once: a replayed POST and a second workspace do not double count", async () => {
    const h = await startHarness();
    const op = turnOp(1, M1, "s-1", "2026-10-12T10:00:00.000Z", {});
    expect(await append(h, op)).toBe(201);
    expect(await append(h, op)).toBe(200); // replay
    expect(await append(h, turnOp(1, M1, "s-9", "2026-10-12T10:00:00.000Z", {}), "ws-other")).toBe(409); // operationId reuse, rejected

    const { body } = await usage(h, `workspaceId=${WS}&groupBy=total`);
    expect(body.rows[0].turns).toBe(1);
    const other = await usage(h, "workspaceId=ws-other&groupBy=total");
    expect(other.body.rows).toEqual([]);
  });

  it("stores an operation it cannot project and leaves the read model alone", async () => {
    const h = await startHarness();
    // Missing sessionId, data not an object, a different kind: all are plain log entries.
    expect(await append(h, { ...turnOp(1, M1, "s-1", "2026-10-12T10:00:00.000Z", {}), data: { memberId: M1, endedAt: "2026-10-12T10:00:00.000Z" } })).toBe(201);
    expect(await append(h, { sequence: 2, operationId: "op-2", kind: "team/session-turn-recorded", data: "nope" })).toBe(201);
    expect(await append(h, { sequence: 3, operationId: "op-3", kind: "team/message-sent", data: { text: "hi" } })).toBe(201);

    expect((await usage(h, `workspaceId=${WS}&groupBy=total`)).body.rows).toEqual([]);
    const head = await (await h.get(`/team/v1/operations/head?workspaceId=${WS}`)).json();
    expect(head.sequence).toBe(3);
  });

  it("treats a negative or fractional figure as not reported", async () => {
    const h = await startHarness();
    await append(h, turnOp(1, M1, "s-1", "2026-10-12T10:00:00.000Z", { outputTokens: -5, uncachedInputTokens: 1.5 }));
    const { body } = await usage(h, `workspaceId=${WS}&groupBy=total`);
    expect(body.rows[0]).toMatchObject({ outputTokens: 0, unknownOutputTurns: 1, uncachedInputTokens: 0, unknownInputTurns: 1 });
  });

  it("answers 400 for a bad query", async () => {
    const h = await startHarness();
    expect((await usage(h, "")).status).toBe(400);
    expect((await usage(h, `workspaceId=${WS}&groupBy=model`)).status).toBe(400);
    expect((await usage(h, `workspaceId=${WS}&since=yesterday`)).status).toBe(400);
    expect((await h.request(`/team/v1/usage?workspaceId=${WS}`, { method: "POST" })).status).toBe(405);
  });
});

describe("team room read models — bindings", () => {
  it("folds the session half and the slot half into one row per Thread and Member", async () => {
    const h = await startHarness();
    await append(h, sessionBound(1, "thread:a", M1, "s-1"));
    await append(h, instanceBound(2, "thread:a", M1, 1));
    await append(h, sessionBound(3, "thread:a", M2, "s-9", "cold-restart"));

    const byThread = await (await h.get(`/team/v1/bindings?workspaceId=${WS}&threadRef=thread:a`)).json();
    expect(byThread.bindings).toEqual([
      { threadRef: "thread:a", memberId: M1, sessionId: "s-1", sessionReason: "new", slot: 1, slotBoundAt: "2026-10-13T11:52:47.004Z" },
      { threadRef: "thread:a", memberId: M2, sessionId: "s-9", sessionReason: "cold-restart", slot: null, slotBoundAt: null },
    ]);

    const byMember = await (await h.get(`/team/v1/bindings?workspaceId=${WS}&memberId=${M1}`)).json();
    expect(byMember.bindings).toHaveLength(1);
  });

  it("keeps the newer binding when the same half is bound again", async () => {
    const h = await startHarness();
    await append(h, sessionBound(1, "thread:a", M1, "s-1"));
    await append(h, sessionBound(5, "thread:a", M1, "s-2", "cold-restart"));
    await append(h, instanceBound(6, "thread:a", M1, 0));
    await append(h, instanceBound(9, "thread:a", M1, 1));

    const { bindings } = await (await h.get(`/team/v1/bindings?workspaceId=${WS}&threadRef=thread:a`)).json();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ sessionId: "s-2", sessionReason: "cold-restart", slot: 1 });
  });

  it("does not let an older operation overwrite a newer binding", async () => {
    const h = await startHarness();
    await append(h, sessionBound(7, "thread:a", M1, "s-new"));
    await append(h, sessionBound(3, "thread:a", M1, "s-old")); // arrives late, lower sequence
    const { bindings } = await (await h.get(`/team/v1/bindings?workspaceId=${WS}&threadRef=thread:a`)).json();
    expect(bindings[0].sessionId).toBe("s-new");
  });

  it("answers 400 unless exactly one of threadRef and memberId is given", async () => {
    const h = await startHarness();
    expect((await h.get(`/team/v1/bindings?workspaceId=${WS}`)).status).toBe(400);
    expect((await h.get(`/team/v1/bindings?workspaceId=${WS}&threadRef=t&memberId=m`)).status).toBe(400);
    expect((await h.get("/team/v1/bindings?threadRef=t")).status).toBe(400);
    expect((await h.request(`/team/v1/bindings?workspaceId=${WS}&threadRef=t`, { method: "POST" })).status).toBe(405);
  });
});

describe("team room read models — backfill of operations stored before v7", () => {
  function scratch(): { root: string; dbPath: string } {
    const root = mkdtempSync(path.join(tmpdir(), "moct-team-rm-"));
    dirs.push(root);
    return { root, dbPath: path.join(root, "fleet.db") };
  }
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** An operation as an older build stored it: in the log, with no read-model row. */
  async function storeUnprojected(repo: TursoRepository, workspaceId: string, record: { sequence: number; operationId: string; kind: string }): Promise<void> {
    await repo
      .teamDb()
      .run(
        "INSERT INTO team_operations(workspace_id, sequence, operation_id, kind, record_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
        workspaceId,
        record.sequence,
        record.operationId,
        record.kind,
        JSON.stringify(record),
        "2026-10-12T10:00:00.000Z",
      );
  }

  it("projects every stored operation once, then skips", async () => {
    const { root, dbPath } = scratch();
    const repo = await TursoRepository.open(root, dbPath);
    await storeUnprojected(repo, WS, turnOp(1, M1, "s-1", "2026-10-12T10:00:00.000Z", {}));
    await storeUnprojected(repo, WS, sessionBound(2, "thread:a", M1, "s-1"));
    await storeUnprojected(repo, WS, instanceBound(3, "thread:a", M1, 1));
    await storeUnprojected(repo, "ws-2", { ...turnOp(1, M2, "s-2", "2026-10-13T10:00:00.000Z", {}), operationId: "ws2-op-1" });
    // Page size is 1000; cross it so the paging path runs.
    for (let seq = 4; seq < 1010; seq += 1) {
      await storeUnprojected(repo, WS, { sequence: seq, operationId: `bulk-${seq}`, kind: "team/message-sent" });
    }

    const team = new TeamRoomStore(repo.teamDb());
    expect((await team.usage({ workspaceId: WS, groupBy: "total" }))).toEqual([]);

    const first = await team.backfillProjections();
    expect(first.skipped).toBe(false);
    expect(first.projected).toBe(1009 + 1);
    expect((await team.usage({ workspaceId: WS, groupBy: "total" }))[0]).toMatchObject({ turns: 1 });
    expect((await team.usage({ workspaceId: "ws-2", groupBy: "total" }))[0]).toMatchObject({ turns: 1 });
    expect(await team.bindings(WS, { threadRef: "thread:a" })).toEqual([
      { threadRef: "thread:a", memberId: M1, sessionId: "s-1", sessionReason: "new", slot: 1, slotBoundAt: "2026-10-13T11:52:47.004Z" },
    ]);

    const second = await team.backfillProjections();
    expect(second).toEqual({ projected: 0, skipped: true });
    expect((await team.usage({ workspaceId: WS, groupBy: "total" }))[0]).toMatchObject({ turns: 1 });
    await repo.close();
  });

  it("survives a restart without projecting again, and keeps projecting new appends", async () => {
    const { root, dbPath } = scratch();
    let repo = await TursoRepository.open(root, dbPath);
    let team = new TeamRoomStore(repo.teamDb());
    await team.backfillProjections();
    expect(await team.append(WS, turnOp(1, M1, "s-1", "2026-10-12T10:00:00.000Z", {}))).toEqual({ status: "stored" });
    await repo.close();

    repo = await TursoRepository.open(root, dbPath);
    team = new TeamRoomStore(repo.teamDb());
    expect((await team.backfillProjections()).skipped).toBe(true);
    expect((await team.usage({ workspaceId: WS, groupBy: "total" }))[0]).toMatchObject({ turns: 1 });
    await repo.close();
  });

  it("rebuilds from the log after the read model is dropped, to the same figures", async () => {
    const { root, dbPath } = scratch();
    const repo = await TursoRepository.open(root, dbPath);
    const team = new TeamRoomStore(repo.teamDb());
    await team.backfillProjections();
    await team.append(WS, turnOp(1, M1, "s-1", "2026-10-12T10:00:00.000Z", {}));
    await team.append(WS, turnOp(2, M1, "s-1", "2026-10-12T11:00:00.000Z", { outputTokens: null }));
    const before = await team.usage({ workspaceId: WS, groupBy: "session" });

    const db = repo.teamDb();
    await db.run("DELETE FROM team_turns");
    await db.run("DELETE FROM meta WHERE key = 'team_projection:1'");
    expect(await team.usage({ workspaceId: WS, groupBy: "session" })).toEqual([]);

    expect((await team.backfillProjections()).projected).toBe(2);
    expect(await team.usage({ workspaceId: WS, groupBy: "session" })).toEqual(before);
    await repo.close();
  });
});

const summaryOp = (
  sequence: number,
  overrides: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
) => ({
  sequence,
  operationId: `op-${sequence}`,
  kind: "team/thread-summary-committed",
  data: {
    workspaceId: WS,
    threadRef: "thread:a",
    generation: 1,
    trigger: "rolling",
    text: "## Conversation Summary\n\nHeadline.",
    coversThroughSequence: 40,
    transcriptTokens: 1521,
    model: { provider: "dsh-opencode-go", model: "mimo-v2.6-flash" },
    usage: { inputTokens: 4772, outputTokens: 1666 },
    at: "2026-10-13T12:00:00.000Z",
    ...data,
  },
  ...overrides,
});

describe("team room read models — summaries", () => {
  function scratch(): { root: string; dbPath: string } {
    const root = mkdtempSync(path.join(tmpdir(), "moct-team-sm-"));
    dirs.push(root);
    return { root, dbPath: path.join(root, "fleet.db") };
  }
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** An operation as an older build stored it: in the log, with no summary row. */
  async function storeSummaryUnprojected(
    repo: TursoRepository,
    record: { sequence: number; operationId: string; kind: string },
  ): Promise<void> {
    await repo
      .teamDb()
      .run(
        "INSERT INTO team_operations(workspace_id, sequence, operation_id, kind, record_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
        WS,
        record.sequence,
        record.operationId,
        record.kind,
        JSON.stringify(record),
        "2026-10-13T12:00:00.000Z",
      );
  }
  it("projects team/thread-summary-committed into the readable summary", async () => {
    const h = await startHarness();
    // The real shape of op 385 from the TEST ledger: transcriptTokens, a model object, usage.
    expect(await append(h, summaryOp(1))).toBe(201);

    const res = await h.get("/team/v1/thread-summaries/thread:a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      threadRef: "thread:a",
      generation: 1,
      trigger: "rolling",
      text: "## Conversation Summary\n\nHeadline.",
      // transcriptTokens is the table's tokens column.
      coversThroughSequence: 40,
      tokens: 1521,
      model: "dsh-opencode-go/mimo-v2.6-flash",
      at: "2026-10-13T12:00:00.000Z",
    });
  });

  it("projects each generation and serves the latest", async () => {
    const h = await startHarness();
    await append(h, summaryOp(1));
    await append(h, summaryOp(2, {}, { generation: 2, trigger: "wrapup", text: "wrap up", at: "2026-10-13T13:00:00.000Z" }));
    await append(h, summaryOp(3, {}, { generation: 3, trigger: "rolling", text: "third", at: "2026-10-13T14:00:00.000Z" }));

    const latest = await (await h.get("/team/v1/thread-summaries/thread:a")).json();
    expect(latest.generation).toBe(3);
    expect(latest.text).toBe("third");
    expect(await (await h.get("/team/v1/thread-summaries/thread:other")).status).toBe(404);
  });

  it("is idempotent: appending the same operation again changes nothing", async () => {
    const h = await startHarness();
    expect(await append(h, summaryOp(1))).toBe(201);
    expect(await append(h, summaryOp(1))).toBe(200); // replay of the same operation_id
    const after = await (await h.get("/team/v1/thread-summaries/thread:a")).json();
    expect(after.tokens).toBe(1521);
  });

  it("does not let a re-sent generation with different text overwrite the stored one", async () => {
    const h = await startHarness();
    await append(h, summaryOp(1));
    // A different operation_id, same generation, different text: the ledger guards this,
    // but the projection must not be the place where the guard is missing.
    await append(h, summaryOp(2, { operationId: "op-other" }, { text: "rewritten" }));
    const latest = await (await h.get("/team/v1/thread-summaries/thread:a")).json();
    expect(latest.generation).toBe(1);
    expect(latest.text).toBe("## Conversation Summary\n\nHeadline.");
  });

  it("leaves an operation it cannot project stored and unread, never a zeroed summary", async () => {
    const h = await startHarness();
    // No threadRef, a bad trigger, a fractional generation, no text: all stay plain log entries.
    for (const [index, bad] of [
      { threadRef: undefined },
      { trigger: "daily" },
      { generation: 1.5 },
      { text: undefined },
    ].entries()) {
      expect(await append(h, summaryOp(index + 1, {}, bad))).toBe(201);
    }
    expect(await (await h.get("/team/v1/thread-summaries/thread:a")).status).toBe(404);
  });

  it("backfills a summary committed before this build, from the operation log", async () => {
    const { root, dbPath } = scratch();
    const repo = await TursoRepository.open(root, dbPath);
    // As an older build stored it: in the log, with no summary row.
    await storeSummaryUnprojected(repo, summaryOp(1));
    const team = new TeamRoomStore(repo.teamDb());
    expect(await team.latestSummary("thread:a")).toBeUndefined();

    const first = await team.backfillProjections();
    expect(first.skipped).toBe(false);
    expect(first.projected).toBe(1);
    expect(await team.latestSummary("thread:a")).toMatchObject({
      generation: 1,
      tokens: 1521,
      model: "dsh-opencode-go/mimo-v2.6-flash",
    });

    // Second start projects nothing again.
    expect((await team.backfillProjections()).skipped).toBe(true);
    await repo.close();
  });

  it("backfills summaries on a database whose shared backfill marker is already set", async () => {
    // The blocker this pass exists for: the v7 marker is already written in every live
    // database (on TEST it dates from 2026-10-13), so a summary fold that reuses it is a
    // no-op there and committed summaries stay unread.
    const { root, dbPath } = scratch();
    const repo = await TursoRepository.open(root, dbPath);
    const team = new TeamRoomStore(repo.teamDb());
    await team.backfillProjections();
    expect((await team.backfillProjections()).skipped).toBe(true);
    await storeSummaryUnprojected(repo, summaryOp(7));
    expect(await team.latestSummary("thread:a")).toBeUndefined();

    const first = await team.backfillThreadSummaries();
    expect(first).toEqual({ projected: 1, skipped: false });
    expect(await team.latestSummary("thread:a")).toMatchObject({
      generation: 1,
      tokens: 1521,
      model: "dsh-opencode-go/mimo-v2.6-flash",
      coversThroughSequence: 40,
    });

    // One-time: the second start skips, and the fold does not disturb the v7 pass.
    const second = await team.backfillThreadSummaries();
    expect(second).toEqual({ projected: 0, skipped: true });
    expect((await team.backfillProjections()).skipped).toBe(true);
    expect(await team.latestSummary("thread:a")).toMatchObject({ tokens: 1521 });
    await repo.close();
  });

  it("is a no-op when the summaries are already projected, on a fresh database", async () => {
    // The append transaction already folded them, so the backfill must leave the rows alone.
    const { root, dbPath } = scratch();
    const repo = await TursoRepository.open(root, dbPath);
    const team = new TeamRoomStore(repo.teamDb());
    expect(await team.append(WS, summaryOp(1))).toEqual({ status: "stored" });
    const before = await team.latestSummary("thread:a");
    expect(before?.tokens).toBe(1521);

    const pass = await team.backfillThreadSummaries();
    expect(pass).toEqual({ projected: 1, skipped: false });
    expect(await team.latestSummary("thread:a")).toEqual(before);
    await repo.close();
  });
});
