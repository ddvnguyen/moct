/**
 * Team Room HTTP surface (/team/v1, moct contract v0.3 §2) against a real
 * scratch fleet.db. No mocked store: the sequence and idempotency rules are
 * enforced by the table, and a fake would hide that.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHarnesses, postJson, putJson, startHarness } from "./http-harness.js";

afterEach(cleanupHarnesses);

const WS = "ws-1";
const op = (sequence: number, operationId = `op-${sequence}`, extra: Record<string, unknown> = {}) => ({
  sequence,
  operationId,
  kind: "message.post",
  at: "2026-10-11T00:00:00.000Z",
  ...extra,
});

const summary = (generation: number, extra: Record<string, unknown> = {}) => ({
  generation,
  trigger: "rolling",
  text: `summary ${generation}`,
  coversThroughSequence: generation * 10,
  tokens: 900,
  model: "opencode-go/mimo-v2.6-flash",
  at: "2026-10-11T00:00:00.000Z",
  ...extra,
});

const run = (sessionId: string, memberId: string, threadRefs: string[]) => ({
  sessionId,
  memberId,
  threadRefs,
  startedAt: "2026-10-11T00:00:00.000Z",
  tokensIn: 1200,
  tokensOut: 340,
  cacheReadTokens: 900,
  cacheWriteTokens: 0,
  toolCalls: 7,
  runMs: 12000,
  model: { provider: "claude", model: "claude-haiku-5-5" },
  state: "warm",
});

describe("team room — operations log", () => {
  it("stores, replays idempotently, and rejects sequence and operationId conflicts", async () => {
    const h = await startHarness();
    const first = await h.request("/team/v1/operations", postJson({ workspaceId: WS, record: op(1) }));
    expect(first.status).toBe(201);

    const replay = await h.request("/team/v1/operations", postJson({ workspaceId: WS, record: op(1) }));
    expect(replay.status).toBe(200);

    // Same operationId, re-serialised with keys reordered: still a replay, not a conflict.
    const reordered = { kind: "message.post", operationId: "op-1", sequence: 1, at: "2026-10-11T00:00:00.000Z" };
    const reorderedReplay = await h.request("/team/v1/operations", postJson({ workspaceId: WS, record: reordered }));
    expect(reorderedReplay.status).toBe(200);

    const seqTaken = await h.request(
      "/team/v1/operations",
      postJson({ workspaceId: WS, record: op(1, "op-other") }),
    );
    expect(seqTaken.status).toBe(409);
    expect((await seqTaken.json()).code).toBe("SEQUENCE_CONFLICT");

    const idTaken = await h.request(
      "/team/v1/operations",
      postJson({ workspaceId: WS, record: op(2, "op-1") }),
    );
    expect(idTaken.status).toBe(409);
    expect((await idTaken.json()).code).toBe("OPERATION_ID_CONFLICT");
  });

  it("keeps sequences per workspace", async () => {
    const h = await startHarness();
    await h.request("/team/v1/operations", postJson({ workspaceId: "a", record: op(1, "a-1") }));
    const other = await h.request("/team/v1/operations", postJson({ workspaceId: "b", record: op(1, "b-1") }));
    expect(other.status).toBe(201);
  });

  it("replays pages in sequence order and reports the head", async () => {
    const h = await startHarness();
    for (let seq = 1; seq <= 5; seq++) {
      await h.request("/team/v1/operations", postJson({ workspaceId: WS, record: op(seq) }));
    }
    const headRes = await h.get(`/team/v1/operations/head?workspaceId=${WS}`);
    expect(await headRes.json()).toEqual({ sequence: 5 });

    const page1 = await (await h.get(`/team/v1/operations?workspaceId=${WS}&afterSequence=0&limit=2`)).json();
    expect(page1.operations.map((r: { sequence: number }) => r.sequence)).toEqual([1, 2]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextAfterSequence).toBe(2);

    const page2 = await (await h.get(`/team/v1/operations?workspaceId=${WS}&afterSequence=2&limit=10`)).json();
    expect(page2.operations.map((r: { sequence: number }) => r.sequence)).toEqual([3, 4, 5]);
    expect(page2.hasMore).toBe(false);
  });

  it("answers an empty workspace with head 0", async () => {
    const h = await startHarness();
    expect(await (await h.get(`/team/v1/operations/head?workspaceId=none`)).json()).toEqual({ sequence: 0 });
  });

  it("returns 400 for malformed operations", async () => {
    const h = await startHarness();
    const bad = await h.request("/team/v1/operations", postJson({ workspaceId: WS, record: { operationId: "x" } }));
    expect(bad.status).toBe(400);
    const notJson = await h.request("/team/v1/operations", { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("streams records after the cursor over SSE", async () => {
    const h = await startHarness();
    await h.request("/team/v1/operations", postJson({ workspaceId: WS, record: op(1) }));
    await h.request("/team/v1/operations", postJson({ workspaceId: WS, record: op(2) }));
    const controller = new AbortController();
    const res = await h.request(`/team/v1/stream?workspaceId=${WS}&afterSequence=1`, { signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes('"sequence":2')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    controller.abort();
    expect(text).toContain("event: operation");
    expect(text).not.toContain('"sequence":1,');
  });
});

describe("team room — session runs", () => {
  it("upserts a SessionRun and finds it by member and by thread", async () => {
    const h = await startHarness();
    expect((await h.request("/team/v1/session-runs", postJson(run("s-1", "seat-a", ["t-1"])))).status).toBe(200);
    await h.request("/team/v1/session-runs", postJson({ ...run("s-1", "seat-a", ["t-1", "t_2"]), tokensOut: 999 }));
    await h.request("/team/v1/session-runs", postJson(run("s-2", "seat-a", ["t_2x"])));

    const byMember = await (await h.get("/team/v1/session-runs?memberId=seat-a")).json();
    expect(byMember.runs.map((r: { sessionId: string }) => r.sessionId)).toEqual(["s-1", "s-2"]);
    expect(byMember.runs[0].tokensOut).toBe(999);
    expect(byMember.runs[0].threadRefs).toEqual(["t-1", "t_2"]);

    // "t_2" must not match "t_2x": LIKE wildcards are escaped and the match is exact.
    const byThread = await (await h.get("/team/v1/session-runs?threadRef=t_2")).json();
    expect(byThread.runs.map((r: { sessionId: string }) => r.sessionId)).toEqual(["s-1"]);
  });

  it("rejects a run with an unknown state", async () => {
    const h = await startHarness();
    const res = await h.request("/team/v1/session-runs", postJson({ ...run("s-9", "seat-a", []), state: "hot" }));
    expect(res.status).toBe(400);
  });
});

describe("team room — thread summaries", () => {
  it("stores generations in order and serves the latest", async () => {
    const h = await startHarness();
    expect((await h.request("/team/v1/thread-summaries/t-1", putJson(summary(1)))).status).toBe(201);
    expect((await h.request("/team/v1/thread-summaries/t-1", putJson(summary(1)))).status).toBe(200);
    expect((await h.request("/team/v1/thread-summaries/t-1", putJson(summary(2, { trigger: "wrapup" })))).status).toBe(201);

    const latest = await (await h.get("/team/v1/thread-summaries/t-1")).json();
    expect(latest.generation).toBe(2);
    expect(latest.trigger).toBe("wrapup");
  });

  it("refuses an older generation and a changed replay of the same generation", async () => {
    const h = await startHarness();
    await h.request("/team/v1/thread-summaries/t-1", putJson(summary(3)));
    const stale = await h.request("/team/v1/thread-summaries/t-1", putJson(summary(2)));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("GENERATION_STALE");

    const changed = await h.request("/team/v1/thread-summaries/t-1", putJson(summary(3, { text: "different" })));
    expect(changed.status).toBe(409);
    expect((await changed.json()).code).toBe("GENERATION_CONFLICT");
  });

  it("answers 404 when a thread has no summary, and rejects an unknown trigger", async () => {
    const h = await startHarness();
    expect((await h.get("/team/v1/thread-summaries/nothing")).status).toBe(404);
    const bad = await h.request("/team/v1/thread-summaries/t-1", putJson(summary(1, { trigger: "daily" })));
    expect(bad.status).toBe(400);
  });
});

describe("team room — health and routing", () => {
  it("reports the v7 schema", async () => {
    const h = await startHarness();
    const body = await (await h.get("/team/v1/health")).json();
    expect(body).toMatchObject({ ok: true, schema: 7 });
  });

  it("answers 404 for an unknown team route and 405 for a wrong method", async () => {
    const h = await startHarness();
    expect((await h.get("/team/v1/nope")).status).toBe(404);
    expect((await h.request("/team/v1/operations/head?workspaceId=x", { method: "DELETE" })).status).toBe(405);
  });
});
