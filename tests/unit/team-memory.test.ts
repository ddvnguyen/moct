/**
 * Team memory (schema v8). Real fleet.db files in a scratch dir and a fake clock;
 * the HTTP cases run the real server through the shared harness.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TursoRepository } from "../../src/store/turso-repository.js";
import { TeamRoomStore } from "../../src/team-room/store.js";
import {
  MEMORY_EXPIRY_MS,
  MEMORY_INJECT_LAYER_CAP_TOKENS,
  MemoryError,
  type MemoryActor,
  type TeamMemoryStore,
} from "../../src/team-room/memory.js";
import { startHarness } from "./http-harness.js";

const dirs: string[] = [];
const repos: TursoRepository[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const HUMAN: MemoryActor = { kind: "human", id: "human:owner" };
const ALICE: MemoryActor = { kind: "member", id: "member:alice" };
const BOB: MemoryActor = { kind: "member", id: "member:bob" };
const WS = "ws-1";
const CH = "channel:c1";
const TH = "thread:t1";

interface World {
  root: string;
  dbPath: string;
  repo: TursoRepository;
  memory: TeamMemoryStore;
  clock: { t: number };
}

async function makeWorld(): Promise<World> {
  const root = mkdtempSync(path.join(tmpdir(), "moct-memory-"));
  dirs.push(root);
  const dbPath = path.join(root, "fleet.db");
  const repo = await TursoRepository.open(root, dbPath);
  repos.push(repo);
  const clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  const team = new TeamRoomStore(repo.teamDb(), dbPath, null, () => new Date(clock.t));
  return { root, dbPath, repo, memory: team.memory, clock };
}

async function refusal(promise: Promise<unknown>): Promise<MemoryError> {
  try {
    await promise;
  } catch (exc) {
    if (exc instanceof MemoryError) return exc;
    throw exc;
  }
  throw new Error("expected a MemoryError");
}

const team = (content: string, extra: Record<string, unknown> = {}) => ({ layer: "team" as const, workspaceId: WS, content, ...extra });
const channel = (content: string, extra: Record<string, unknown> = {}) => ({
  layer: "channel" as const,
  workspaceId: WS,
  channelRef: CH,
  content,
  ...extra,
});
const task = (content: string, extra: Record<string, unknown> = {}) => ({
  layer: "task" as const,
  workspaceId: WS,
  channelRef: CH,
  threadRef: TH,
  content,
  ...extra,
});

describe("team memory — scope and isolation", () => {
  it("refuses a scope that does not match its layer", async () => {
    const { memory } = await makeWorld();
    expect((await refusal(memory.create({ layer: "team", content: "x", actor: HUMAN }))).code).toBe("INVALID_SCOPE");
    expect((await refusal(memory.create({ ...team("x"), channelRef: CH, actor: HUMAN }))).code).toBe("INVALID_SCOPE");
    expect((await refusal(memory.create({ layer: "task", workspaceId: WS, channelRef: CH, content: "x", actor: HUMAN }))).code).toBe(
      "INVALID_SCOPE",
    );
  });

  it("never returns another Workspace's, Channel's or Thread's notes", async () => {
    const { memory } = await makeWorld();
    await memory.create({ ...team("ws1 team"), actor: HUMAN });
    await memory.create({ layer: "team", workspaceId: "ws-2", content: "ws2 team", actor: HUMAN });
    await memory.create({ ...channel("c1 note"), actor: HUMAN });
    await memory.create({ ...channel("c2 note"), channelRef: "channel:c2", actor: HUMAN });
    await memory.create({ ...task("t1 note"), actor: HUMAN });
    await memory.create({ ...task("t2 note"), threadRef: "thread:t2", actor: HUMAN });
    await memory.create({ layer: "expert", memberId: ALICE.id, content: "alice way", actor: ALICE });
    await memory.create({ layer: "expert", memberId: BOB.id, content: "bob way", actor: BOB });
    await memory.updateSettings({ expertApproval: "off", actor: HUMAN });

    const seen = await memory.list({ memberId: ALICE.id, workspaceId: WS, channelRef: CH, threadRef: TH, status: "all" });
    expect(seen.map((e) => e.content).sort()).toEqual(["alice way", "c1 note", "t1 note", "ws1 team"]);
    expect((await refusal(memory.list({}))).code).toBe("INVALID_SCOPE");
  });

  it("finds notes by every keyword, case-insensitive", async () => {
    const { memory } = await makeWorld();
    await memory.create({ ...team("Deploy TEST with the copy-install procedure"), actor: HUMAN });
    await memory.create({ ...team("Deploy PROD never"), actor: HUMAN });
    const hits = await memory.list({ workspaceId: WS, q: "deploy test" });
    expect(hits.map((e) => e.content)).toEqual(["Deploy TEST with the copy-install procedure"]);
  });
});

describe("team memory — owner checks and human-only verbs", () => {
  it("lets an expert change only its own notes", async () => {
    const { memory } = await makeWorld();
    const note = await memory.create({ ...channel("alice's note"), actor: ALICE });
    expect((await refusal(memory.patch(note.id, { baseVersion: 1, actor: BOB, content: "bob" }))).code).toBe("NOT_OWNER");
    expect((await refusal(memory.retract(note.id, { baseVersion: 1, actor: BOB }))).code).toBe("NOT_OWNER");
    expect((await refusal(memory.promote(note.id, { to: "team", baseVersion: 1, actor: BOB }))).code).toBe("NOT_OWNER");
    expect((await refusal(memory.create({ layer: "expert", memberId: ALICE.id, content: "x", actor: BOB }))).code).toBe("NOT_OWNER");
    const edited = await memory.patch(note.id, { baseVersion: 1, actor: ALICE, content: "alice's note, edited" });
    expect(edited.version).toBe(2);
    expect((await refusal(memory.patch(note.id, { baseVersion: 1, actor: ALICE, content: "stale" }))).code).toBe("VERSION_STALE");
  });

  it("keeps pins with the human, except an expert's own expert notes", async () => {
    const { memory } = await makeWorld();
    expect((await refusal(memory.create({ ...team("x"), pinned: true, actor: ALICE }))).code).toBe("PIN_FORBIDDEN");
    await memory.updateSettings({ expertApproval: "off", actor: HUMAN });
    const own = await memory.create({ layer: "expert", memberId: ALICE.id, content: "how I work", pinned: true, actor: ALICE });
    expect(own.pinned).toBe(true);
  });

  it("reserves restore, purge and settings for the human", async () => {
    const { memory } = await makeWorld();
    const note = await memory.create({ ...team("v1"), actor: ALICE });
    await memory.patch(note.id, { baseVersion: 1, actor: ALICE, content: "v2" });
    expect((await refusal(memory.restore(note.id, { version: 1, baseVersion: 2, actor: ALICE }))).code).toBe("HUMAN_ONLY");
    expect((await refusal(memory.purge(note.id, { actor: ALICE }))).code).toBe("HUMAN_ONLY");
    expect((await refusal(memory.updateSettings({ expertApproval: "off", actor: ALICE }))).code).toBe("HUMAN_ONLY");
    const restored = await memory.restore(note.id, { version: 1, baseVersion: 2, actor: HUMAN });
    expect(restored.content).toBe("v1");
    expect((await memory.versions(note.id)).map((v) => v.action)).toEqual(["restore", "edit", "create"]);
  });
});

describe("team memory — expert approval", () => {
  it("holds an expert's own expert note as pending by default", async () => {
    const { memory } = await makeWorld();
    expect((await memory.settings()).expertApproval).toBe("required");
    const note = await memory.create({ layer: "expert", memberId: ALICE.id, content: "I verify before I report", actor: ALICE });
    expect(note.status).toBe("pending");
    expect(await memory.list({ memberId: ALICE.id })).toHaveLength(0);
  });

  it("lets the human or a first-mate expert approve, never the author or a worker", async () => {
    const { memory } = await makeWorld();
    await memory.updateSettings({ firstMateMembers: [BOB.id, ALICE.id], actor: HUMAN });
    const note = await memory.create({ layer: "expert", memberId: ALICE.id, content: "I verify before I report", actor: ALICE });
    const worker: MemoryActor = { kind: "member", id: "member:carol" };
    expect((await refusal(memory.approve(note.id, { baseVersion: 1, actor: worker }))).code).toBe("APPROVER_ONLY");
    expect((await refusal(memory.approve(note.id, { baseVersion: 1, actor: ALICE }))).code).toBe("SELF_APPROVAL");
    const approved = await memory.approve(note.id, { baseVersion: 1, actor: BOB });
    expect(approved.status).toBe("active");
    expect((await refusal(memory.approve(note.id, { baseVersion: 2, actor: HUMAN }))).code).toBe("NOT_PENDING");
  });

  it("does not hold notes when approval is off, and validates settings", async () => {
    const { memory } = await makeWorld();
    await memory.updateSettings({ expertApproval: "off", actor: HUMAN });
    const note = await memory.create({ layer: "expert", memberId: ALICE.id, content: "x", actor: ALICE });
    expect(note.status).toBe("active");
    expect((await refusal(memory.updateSettings({ expertApproval: "maybe", actor: HUMAN }))).code).toBe("INVALID_SETTING");
    expect((await refusal(memory.updateSettings({ firstMateMembers: "bob", actor: HUMAN }))).code).toBe("INVALID_SETTING");
    expect(
      (await refusal(memory.updateSettings({ injectLayerTokens: MEMORY_INJECT_LAYER_CAP_TOKENS + 1, actor: HUMAN }))).code,
    ).toBe("INVALID_SETTING");
  });
});

describe("team memory — secret filter", () => {
  it("refuses credentials and names only the rule", async () => {
    const { memory } = await makeWorld();
    const cases: Array<[string, string]> = [
      [`key is sk-${"a1B2".repeat(8)}`, "openai-style-key"],
      [`token ghp_${"x9Y8".repeat(9)}`, "github-token"],
      [`aws AKIA${"ABCD2345".repeat(2)}`, "aws-access-key"],
      [`-----BEGIN RSA PRIVATE KEY-----`, "private-key-block"],
    ];
    for (const [content, rule] of cases) {
      const err = await refusal(memory.create({ ...team(content), actor: ALICE }));
      expect(err.status).toBe(422);
      expect(err.code).toBe("SECRET_DETECTED");
      expect(err.message).toContain(rule);
      expect(err.message).not.toContain(content);
    }
    expect(await memory.list({ workspaceId: WS, status: "all" })).toHaveLength(0);
  });
});

describe("team memory — promote", () => {
  it("writes a new unpinned entry and retracts the source, linked both ways", async () => {
    const { memory } = await makeWorld();
    const note = await memory.create({ ...task("branch is feat/x"), pinned: true, actor: HUMAN });
    const { source, promoted } = await memory.promote(note.id, { to: "channel", baseVersion: 1, actor: HUMAN, reason: "keep" });
    expect(source).toMatchObject({ id: note.id, status: "retracted", promotedTo: promoted.id, layer: "task" });
    expect(promoted).toMatchObject({
      layer: "channel",
      channelRef: CH,
      threadRef: null,
      promotedFrom: note.id,
      pinned: false,
      status: "active",
      content: "branch is feat/x",
      version: 1,
    });
    expect((await refusal(memory.promote(promoted.id, { to: "task", baseVersion: 1, actor: HUMAN }))).code).toBe(
      "INVALID_PROMOTION",
    );
    expect((await refusal(memory.promote(note.id, { to: "team", baseVersion: 2, actor: HUMAN }))).code).toBe("NOT_ACTIVE");
  });
});

describe("team memory — purge", () => {
  it("removes the text from the entry, every version and the database files", async () => {
    const { root, memory } = await makeWorld();
    const marker = "PURGE-MARKER-7f3a9c";
    const note = await memory.create({ ...team(`first ${marker}`), actor: HUMAN });
    await memory.patch(note.id, { baseVersion: 1, actor: HUMAN, content: `second ${marker}` });
    const purged = await memory.purge(note.id, { actor: HUMAN, reason: "test" });
    expect(purged).toMatchObject({ status: "purged", content: null, pinned: false });
    expect((await memory.versions(note.id)).every((v) => v.content === null)).toBe(true);
    expect((await memory.versions(note.id))[0]?.action).toBe("purge");
    expect((await refusal(memory.restore(note.id, { version: 1, baseVersion: purged.version, actor: HUMAN }))).code).toBe(
      "PURGED",
    );

    let hits = 0;
    for (const file of readdirSync(root)) {
      const bytes = readFileSync(path.join(root, file));
      for (let i = bytes.indexOf(marker); i !== -1; i = bytes.indexOf(marker, i + 1)) hits += 1;
    }
    expect(hits).toBe(0);
  });
});

describe("team memory — expiry", () => {
  it("expires unpinned notes idle 30 days, keeps pinned and cited ones, deletes nothing", async () => {
    const { memory, clock } = await makeWorld();
    const idle = await memory.create({ ...team("idle note"), actor: HUMAN });
    const cited = await memory.create({ ...team("cited note"), actor: HUMAN });
    const pinned = await memory.create({ ...team("pinned note"), pinned: true, actor: HUMAN });

    clock.t += MEMORY_EXPIRY_MS - 60_000;
    await memory.list({ workspaceId: WS, q: "cited", cite: true });
    clock.t += 120_000;
    expect(await memory.sweep()).toBe(1);

    expect((await memory.get(idle.id))?.status).toBe("expired");
    expect((await memory.get(cited.id))?.status).toBe("active");
    expect((await memory.get(cited.id))?.useCount).toBe(1);
    expect((await memory.get(pinned.id))?.status).toBe("active");
    expect(await memory.list({ workspaceId: WS, status: "all" })).toHaveLength(3);
  });

  it("expires a closed task's notes", async () => {
    const { memory } = await makeWorld();
    await memory.create({ ...task("scratch state"), actor: HUMAN });
    expect(await memory.taskClosed({ workspaceId: WS, channelRef: CH, threadRef: TH, actor: HUMAN })).toBe(1);
    expect(await memory.list({ workspaceId: WS })).toHaveLength(0);
  });
});

describe("team memory — injection", () => {
  it("loads pinned notes narrowest first, within each layer's own budget", async () => {
    const { memory } = await makeWorld();
    // 300 ASCII chars = 100 tokens each.
    const note = (tag: string) => `${tag} `.padEnd(300, "x");
    for (let i = 0; i < 3; i++) await memory.create({ ...task(note(`task${i}`)), pinned: true, actor: HUMAN });
    await memory.create({ ...channel(note("chan")), pinned: true, actor: HUMAN });
    await memory.create({ ...team(note("team")), pinned: true, actor: HUMAN });
    await memory.create({ ...team("team unpinned"), actor: HUMAN });

    const out = await memory.inject({ memberId: ALICE.id, workspaceId: WS, channelRef: CH, threadRef: TH, layerTokens: 250 });
    expect(out.layerTokens).toBe(250);
    expect(out.entries.map((e) => e.layer)).toEqual(["task", "task", "channel", "team"]);
    expect(out.omitted).toBe(1);
    expect(out.tokens).toBe(400);
    // The over-budget task note and the unpinned team note are indexed for lazy load.
    expect(out.index.map((i) => [i.layer, i.more])).toEqual([
      ["task", 1],
      ["team", 1],
    ]);
    expect(out.index[1]?.items[0]).toMatchObject({ pinned: false, snippet: "team unpinned" });
  });

  it("uses the setting by default, never exceeds the cap, and writes nothing", async () => {
    const { memory } = await makeWorld();
    const note = await memory.create({ ...team("short"), pinned: true, actor: HUMAN });
    expect((await memory.inject({ memberId: ALICE.id, workspaceId: WS })).layerTokens).toBe(1000);
    await memory.updateSettings({ injectLayerTokens: 1500, actor: HUMAN });
    expect((await memory.inject({ memberId: ALICE.id, workspaceId: WS })).layerTokens).toBe(1500);
    expect((await memory.inject({ memberId: ALICE.id, workspaceId: WS, layerTokens: 99_999 })).layerTokens).toBe(
      MEMORY_INJECT_LAYER_CAP_TOKENS,
    );
    expect(await memory.get(note.id)).toMatchObject({ version: 1, lastUsedAt: null, useCount: 0 });
  });

  it("skips a wider note whose text a narrower layer already loaded", async () => {
    const { memory } = await makeWorld();
    await memory.create({ ...channel("Use pnpm 11.7"), pinned: true, actor: HUMAN });
    await memory.create({ ...team("use  PNPM 11.7"), pinned: true, actor: HUMAN });
    const out = await memory.inject({ memberId: ALICE.id, workspaceId: WS, channelRef: CH });
    expect(out.entries.map((e) => e.layer)).toEqual(["channel"]);
    expect(out.duplicates).toBe(1);
  });

  it("loads only the asking expert's expert notes", async () => {
    const { memory } = await makeWorld();
    await memory.updateSettings({ expertApproval: "off", actor: HUMAN });
    await memory.create({ layer: "expert", memberId: ALICE.id, content: "alice way", pinned: true, actor: ALICE });
    await memory.create({ layer: "expert", memberId: BOB.id, content: "bob way", pinned: true, actor: BOB });
    const out = await memory.inject({ memberId: ALICE.id, workspaceId: WS });
    expect(out.entries.map((e) => e.content)).toEqual(["alice way"]);
  });
});

describe("team memory — HTTP surface", () => {
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("creates, reads, patches and lists versions", async () => {
    const h = await startHarness();
    const created = await h.request("/team/v1/memory", json("POST", { ...channel("note"), actor: ALICE }));
    expect(created.status).toBe(201);
    const entry = (await created.json()) as { id: string };
    expect((await h.get(`/team/v1/memory/${entry.id}`)).status).toBe(200);
    const patched = await h.request(`/team/v1/memory/${entry.id}`, json("PATCH", { baseVersion: 1, content: "note 2", actor: ALICE }));
    expect(patched.status).toBe(200);
    const listed = (await (await h.get(`/team/v1/memory?workspaceId=${WS}&channelRef=${encodeURIComponent(CH)}`)).json()) as {
      entries: unknown[];
    };
    expect(listed.entries).toHaveLength(1);
    const versions = (await (await h.get(`/team/v1/memory/${entry.id}/versions`)).json()) as { versions: unknown[] };
    expect(versions.versions).toHaveLength(2);
  });

  it("maps refusals to their status and stable code", async () => {
    const h = await startHarness();
    const secret = await h.request("/team/v1/memory", json("POST", { ...team(`sk-${"a1B2".repeat(8)}`), actor: ALICE }));
    expect(secret.status).toBe(422);
    expect(await secret.json()).toMatchObject({ ok: false, code: "SECRET_DETECTED" });
    const purge = await h.request("/team/v1/memory/mem_x/purge", json("POST", { actor: ALICE }));
    expect(purge.status).toBe(403);
    expect(await purge.json()).toMatchObject({ code: "HUMAN_ONLY" });
    expect((await h.get("/team/v1/memory/mem_missing")).status).toBe(404);
    expect((await h.request("/team/v1/memory", json("POST", { layer: "team", workspaceId: WS, content: "x" }))).status).toBe(400);
    expect((await h.request("/team/v1/memory/settings", { method: "DELETE" })).status).toBe(405);
  });

  it("serves settings and injection", async () => {
    const h = await startHarness();
    expect(await (await h.get("/team/v1/memory/settings")).json()).toMatchObject({ expertApproval: "required", injectLayerTokens: 1000 });
    const put = await h.request("/team/v1/memory/settings", json("PUT", { injectLayerTokens: 1200, actor: HUMAN }));
    expect(await put.json()).toMatchObject({ injectLayerTokens: 1200 });
    const inject = await h.get(`/team/v1/memory/inject?memberId=${ALICE.id}&workspaceId=${WS}`);
    expect(await inject.json()).toMatchObject({ entries: [], layerTokens: 1200, index: [] });
  });
});
