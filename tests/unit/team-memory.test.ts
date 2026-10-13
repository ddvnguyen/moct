/**
 * Team memory (schema v8, design v5). Real fleet.db files in a scratch dir and a
 * fake clock; the HTTP cases run the real server through the shared harness.
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
  type MemoryRecord,
  type NoteInput,
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
const LEAD: MemoryActor = { kind: "member", id: "member:lead" };
const ARCH: MemoryActor = { kind: "member", id: "member:architect" };
const ALICE: MemoryActor = { kind: "member", id: "member:alice" };
const BOB: MemoryActor = { kind: "member", id: "member:bob" };
const WS = "ws-1";
const CH = "channel:c1";
const CH2 = "channel:c2";
const TASK = "task:t1";

interface World {
  root: string;
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
  await team.memory.updateSettings({ orchestrators: [LEAD.id, ARCH.id], actor: HUMAN });
  return { root, repo, memory: team.memory, clock };
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

type Input = Record<string, unknown>;
type Home = { kind: string; ref: string };
const homes = {
  team: { kind: "team", ref: WS },
  channel: { kind: "channel", ref: CH },
  task: { kind: "task", ref: TASK },
};
const rule = (title: string, home: Home = homes.channel, extra: Input = {}): Input => ({
  type: "rule",
  title,
  body: `${title} — body`,
  attrs: { level: "must" },
  home,
  workspaceId: WS,
  ...extra,
});
const convention = (title: string, home: Home = homes.channel, extra: Input = {}): Input => ({
  type: "convention",
  title,
  body: `${title} — body`,
  home,
  workspaceId: WS,
  ...extra,
});
const decision = (title: string, home: Home = homes.task, extra: Input = {}): Input => ({
  type: "decision",
  title,
  body: `${title} — body`,
  attrs: { decidedBy: "human", sourceRef: "thread:d1" },
  home,
  workspaceId: WS,
  taskRef: TASK,
  ...extra,
});
const task = (state = "open", extra: Input = {}): Input => ({
  type: "task",
  title: "Team memory backend",
  body: "",
  attrs: { taskRef: TASK, state, owner: "member:alice" },
  home: homes.task,
  workspaceId: WS,
  ...extra,
});
const branch = (state = "open", extra: Input = {}): Input => ({
  type: "branch",
  title: "feat/team-memory-v8",
  attrs: { repo: "ddvnguyen/moct", branch: "feat/team-memory-v8", state },
  home: homes.channel,
  workspaceId: WS,
  taskRef: TASK,
  ...extra,
});
const howTo = (title: string, expert: MemoryActor): Input => ({
  type: "how_to_work",
  title,
  body: `${title} — body`,
  home: { kind: "expert", ref: expert.id },
  workspaceId: WS,
});

const note = (memory: TeamMemoryStore, input: Input, actor: MemoryActor) => memory.note({ ...(input as unknown as NoteInput), actor });

async function write(memory: TeamMemoryStore, input: Input, actor: MemoryActor): Promise<MemoryRecord> {
  const result = await note(memory, input, actor);
  if (result.record === null) throw new Error(`held back by near matches: ${JSON.stringify(result.nearMatches)}`);
  return result.record;
}

const scope = (expert: MemoryActor, extra: { channels?: string[]; tasks?: string[]; all?: boolean } = {}) => ({
  workspaceId: WS,
  expertId: expert.id,
  ...extra,
});

/** A body that puts one record near a third of the always-load cap. */
const big = (n: number) => `${n}`.padEnd(1999, "x");

describe("team memory — types, homes and validation", () => {
  it("refuses a type in a home it cannot live in, and bad attrs", async () => {
    const { memory } = await makeWorld();
    expect((await refusal(note(memory, rule("r", homes.task), HUMAN))).code).toBe("SCOPE_FORBIDDEN");
    expect((await refusal(note(memory, convention("c", { kind: "team", ref: "ws-other" }), HUMAN))).code).toBe("SCOPE_FORBIDDEN");
    expect((await refusal(note(memory, rule("r", homes.channel, { attrs: { level: "maybe" } }), HUMAN))).code).toBe("INVALID_INPUT");
    expect((await refusal(note(memory, decision("d", homes.task, { attrs: { decidedBy: "human" } }), HUMAN))).code).toBe("INVALID_INPUT");
    expect((await refusal(note(memory, convention("c", homes.channel, { attrs: { extra: 1 } }), HUMAN))).code).toBe("INVALID_INPUT");
    expect((await refusal(note(memory, convention("x".repeat(201)), HUMAN))).code).toBe("CONTENT_TOO_LONG");
  });

  it("refuses credentials in title, body or attrs and names only the rule", async () => {
    const { memory } = await makeWorld();
    const key = `sk-${"a1B2".repeat(8)}`;
    for (const input of [
      convention(`token ${key}`),
      convention("safe", homes.channel, { body: `use ${key}` }),
      decision("d", homes.task, { attrs: { decidedBy: key, sourceRef: "thread:d1" } }),
    ]) {
      const exc = await refusal(note(memory, input, HUMAN));
      expect(exc.code).toBe("SECRET_DETECTED");
      expect(exc.message).not.toContain(key);
    }
  });

  it("tags the task picture with the team, and branches with repo and branch", async () => {
    const { memory } = await makeWorld();
    const d = await write(memory, decision("use typed records"), HUMAN);
    expect(d.tags).toEqual(expect.arrayContaining([{ kind: "task", ref: TASK }, { kind: "team", ref: WS }]));
    const b = await write(memory, branch(), LEAD);
    expect(b.tags).toEqual(
      expect.arrayContaining([
        { kind: "channel", ref: CH },
        { kind: "team", ref: WS },
        { kind: "repo", ref: "ddvnguyen/moct" },
        { kind: "branch", ref: "ddvnguyen/moct#feat/team-memory-v8" },
      ]),
    );
    expect(b.uniqueKey).toBe("branch:ddvnguyen/moct#feat/team-memory-v8");
    const how = await write(memory, howTo("I review diffs before tests", ALICE), ALICE);
    expect(how.workspaceId).toBeNull();
  });
});

describe("team memory — visibility", () => {
  it("shows a worker its team, its channels, the task picture and its own expert notes, nothing else", async () => {
    const { memory } = await makeWorld();
    const teamConv = await write(memory, convention("team naming", homes.team), HUMAN);
    const ch1 = await write(memory, convention("frontend style guide"), HUMAN);
    const ch2 = await write(memory, convention("backend logging format", { kind: "channel", ref: CH2 }), HUMAN);
    const d = await write(memory, decision("task decision"), HUMAN);
    const mine = await write(memory, howTo("alice habit", ALICE), HUMAN);
    const bobs = await write(memory, howTo("bob habit", BOB), HUMAN);
    const other = await write(memory, convention("other ws", { kind: "team", ref: "ws-2" }, { workspaceId: "ws-2" }), HUMAN);

    const ids = async (s: ReturnType<typeof scope>) => (await memory.search({ scope: s, limit: 20 })).results.map((r) => r.id).sort();
    // No channel or task: team, the task picture (team-tagged) and own expert notes.
    expect(await ids(scope(ALICE))).toEqual([teamConv.id, d.id, mine.id].sort());
    expect(await ids(scope(ALICE, { channels: [CH] }))).toEqual([teamConv.id, ch1.id, d.id, mine.id].sort());
    // Orchestrator scope: everything in the Workspace and every how_to_work, never another Workspace.
    const all = await ids(scope(LEAD, { all: true }));
    expect(all).toEqual([teamConv.id, ch1.id, ch2.id, d.id, mine.id, bobs.id].sort());
    expect(all).not.toContain(other.id);
  });

  it("get answers invisible, unknown and purged ids as missing, and counts as a citation", async () => {
    const { memory } = await makeWorld();
    const hidden = await write(memory, convention("alpha secret plan", { kind: "channel", ref: CH2 }), HUMAN);
    const seen = await write(memory, convention("visible guideline"), HUMAN);
    const gone = await write(memory, convention("purgeable entry"), HUMAN);
    await memory.purge(gone.id, { actor: HUMAN });
    const got = await memory.getMany([hidden.id, seen.id, gone.id, "mem_nope"], scope(ALICE, { channels: [CH] }));
    expect(got.records.map((r) => r.id)).toEqual([seen.id]);
    expect(got.missing.sort()).toEqual([hidden.id, gone.id, "mem_nope"].sort());
    expect((await memory.get(seen.id))?.useCount).toBe(1);
    // search is not a citation
    await memory.search({ scope: scope(ALICE, { channels: [CH] }) });
    expect((await memory.get(seen.id))?.useCount).toBe(1);
  });

  it("finds records by every keyword, case-insensitive, and pages with a cursor", async () => {
    const { memory } = await makeWorld();
    await write(memory, convention("Deploy with copy install", homes.team), HUMAN);
    await write(memory, convention("Release cadence weekly", homes.team), HUMAN);
    const hit = await memory.search({ scope: scope(ALICE), q: "COPY deploy" });
    expect(hit.results.map((r) => r.title)).toEqual(["Deploy with copy install"]);
    const page = await memory.search({ scope: scope(ALICE), limit: 1 });
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBe("1");
    expect((await memory.search({ scope: scope(ALICE), limit: 1, cursor: page.nextCursor })).nextCursor).toBeNull();
  });
});

describe("team memory — roles", () => {
  it("keeps task and branch records with orchestrators", async () => {
    const { memory } = await makeWorld();
    expect((await refusal(note(memory, task(), ALICE))).code).toBe("SCOPE_FORBIDDEN");
    expect((await refusal(note(memory, branch(), ALICE))).code).toBe("SCOPE_FORBIDDEN");
    const t = await write(memory, task(), LEAD);
    expect(t.status).toBe("active");
    expect((await refusal(memory.patch(t.id, { baseVersion: 1, actor: ALICE, body: "x" }))).code).toBe("SCOPE_FORBIDDEN");
  });

  it("lets a worker change only its own records, and never pins, priority or widen", async () => {
    const { memory } = await makeWorld();
    const conv = await write(memory, convention("alice convention"), ALICE);
    expect((await refusal(memory.patch(conv.id, { baseVersion: 1, actor: BOB, body: "bob was here" }))).code).toBe("NOT_OWNER");
    expect((await refusal(memory.retract(conv.id, { baseVersion: 1, actor: BOB }))).code).toBe("NOT_OWNER");
    expect((await refusal(memory.patch(conv.id, { baseVersion: 1, actor: ALICE, pinned: true }))).code).toBe("PIN_FORBIDDEN");
    expect((await refusal(memory.patch(conv.id, { baseVersion: 1, actor: ALICE, priority: 90 }))).code).toBe("ORCHESTRATOR_ONLY");
    expect((await refusal(memory.widen(conv.id, { to: homes.team, baseVersion: 1, actor: ALICE }))).code).toBe("ORCHESTRATOR_ONLY");
    expect((await refusal(note(memory, howTo("bob habit", BOB), ALICE))).code).toBe("SCOPE_FORBIDDEN");
    const edited = await memory.patch(conv.id, { baseVersion: 1, actor: ALICE, body: "alice convention, revised" });
    expect(edited.version).toBe(2);
    expect((await refusal(memory.patch(conv.id, { baseVersion: 1, actor: ALICE, body: "stale" }))).code).toBe("VERSION_STALE");
    // Orchestrators change anyone's records.
    expect((await memory.patch(conv.id, { baseVersion: 2, actor: LEAD, pinned: true })).pinned).toBe(true);
  });

  it("reserves restore, purge and settings for the human", async () => {
    const { memory } = await makeWorld();
    const conv = await write(memory, convention("lead convention"), LEAD);
    expect((await refusal(memory.purge(conv.id, { actor: LEAD }))).code).toBe("HUMAN_ONLY");
    expect((await refusal(memory.restore(conv.id, { version: 1, baseVersion: 1, actor: LEAD }))).code).toBe("HUMAN_ONLY");
    expect((await refusal(memory.updateSettings({ expertApproval: "off", actor: LEAD }))).code).toBe("HUMAN_ONLY");
    expect((await refusal(memory.updateSettings({ injectLayerTokens: 5000, actor: HUMAN }))).code).toBe("INVALID_SETTING");
    expect((await refusal(memory.updateSettings({ orchestrators: [""], actor: HUMAN }))).code).toBe("INVALID_SETTING");
  });
});

describe("team memory — approval", () => {
  it("holds a worker's rule, decision and how_to_work as pending; conventions go live", async () => {
    const { memory } = await makeWorld();
    expect((await write(memory, rule("worker rule"), ALICE)).status).toBe("pending");
    expect((await write(memory, decision("worker decision"), ALICE)).status).toBe("pending");
    expect((await write(memory, howTo("worker habit", ALICE), ALICE)).status).toBe("pending");
    expect((await write(memory, convention("worker convention"), ALICE)).status).toBe("active");
    expect((await write(memory, rule("lead channel policy"), LEAD)).status).toBe("active");
  });

  it("lets an orchestrator or the human approve, never a worker", async () => {
    const { memory } = await makeWorld();
    const r = await write(memory, rule("alice channel rule"), ALICE);
    expect((await refusal(memory.approve(r.id, { baseVersion: 1, actor: ALICE }))).code).toBe("APPROVER_ONLY");
    expect((await refusal(memory.approve(r.id, { baseVersion: 1, actor: BOB }))).code).toBe("APPROVER_ONLY");
    expect(await memory.approve(r.id, { baseVersion: 1, actor: LEAD })).toMatchObject({ status: "active", version: 2 });
    expect((await refusal(memory.approve(r.id, { baseVersion: 2, actor: ARCH }))).code).toBe("NOT_PENDING");
  });

  it("never lets an author approve its own record (self-approval guard)", async () => {
    const { memory } = await makeWorld();
    const r = await write(memory, rule("lead team rule", homes.team), LEAD);
    expect(r.status).toBe("pending");
    expect((await refusal(memory.approve(r.id, { baseVersion: 1, actor: LEAD }))).code).toBe("SELF_APPROVAL");
    expect((await memory.get(r.id))?.status).toBe("pending");
  });

  it("refuses an approver who edited the record's text (edit-then-approve)", async () => {
    const { memory } = await makeWorld();
    const r = await write(memory, rule("worker drafted rule"), ALICE);
    const edited = await memory.patch(r.id, { baseVersion: 1, actor: LEAD, body: "lead rewrote this" });
    expect(edited.status).toBe("pending");
    expect((await refusal(memory.approve(r.id, { baseVersion: 2, actor: LEAD }))).code).toBe("SELF_APPROVAL");
    expect(await memory.approve(r.id, { baseVersion: 2, actor: ARCH })).toMatchObject({ status: "active", version: 3 });
  });

  it("sends every team-scoped rule from a non-human to the human (team-rule gate)", async () => {
    const { memory } = await makeWorld();
    const r = await write(memory, rule("lead team rule", homes.team), LEAD);
    expect((await refusal(memory.approve(r.id, { baseVersion: 1, actor: ARCH }))).code).toBe("HUMAN_ONLY");
    expect((await memory.approve(r.id, { baseVersion: 1, actor: HUMAN })).status).toBe("active");
    // Widened into the team home by an orchestrator: back to pending for the human.
    const c = await write(memory, rule("architect review gate"), ARCH);
    const widened = await memory.widen(c.id, { to: homes.team, baseVersion: 1, actor: LEAD });
    expect(widened).toMatchObject({ status: "pending", home: homes.team });
    expect((await refusal(memory.approve(c.id, { baseVersion: 2, actor: LEAD }))).code).toBe("HUMAN_ONLY");
    // The human writes team rules directly.
    expect((await write(memory, rule("owner policy statement", homes.team), HUMAN)).status).toBe("active");
  });

  it("goes live when approval is off, and a worker edit re-gates an approved rule", async () => {
    const { memory } = await makeWorld();
    const r = await write(memory, rule("alice rule"), ALICE);
    const live = await memory.approve(r.id, { baseVersion: 1, actor: LEAD });
    expect((await memory.patch(r.id, { baseVersion: live.version, actor: ALICE, body: "changed" })).status).toBe("pending");
    await memory.updateSettings({ expertApproval: "off", actor: HUMAN });
    expect((await write(memory, rule("another worker policy"), ALICE)).status).toBe("active");
  });
});

describe("team memory — always-load budget", () => {
  it("refuses with BUDGET_FULL and names the largest consumers", async () => {
    const { memory } = await makeWorld();
    const a = await write(memory, rule("rule alpha", homes.channel, { body: big(1) }), HUMAN);
    const b = await write(memory, rule("rule beta", homes.channel, { body: big(2) }), HUMAN);
    const exc = await refusal(note(memory, rule("rule gamma", homes.channel, { body: big(3) }), HUMAN));
    expect(exc.code).toBe("BUDGET_FULL");
    expect(exc.details).toMatchObject({ home: homes.channel, capTokens: MEMORY_INJECT_LAYER_CAP_TOKENS, neededTokens: a.tokens });
    expect((exc.details!["usedTokens"] as number) + (exc.details!["neededTokens"] as number)).toBeGreaterThan(MEMORY_INJECT_LAYER_CAP_TOKENS);
    expect((exc.details!["largest"] as { id: string }[]).map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    // A pin counts against the same cap.
    const conv = await write(memory, convention("big convention", homes.channel, { body: big(4) }), HUMAN);
    expect((await refusal(memory.patch(conv.id, { baseVersion: 1, actor: LEAD, pinned: true }))).code).toBe("BUDGET_FULL");
    // Another home has its own cap.
    expect((await write(memory, rule("rule gamma", homes.team, { body: big(3) }), HUMAN)).status).toBe("active");
  });

  it("keeps an approved-but-full rule pending and flags it blocked_budget", async () => {
    const { memory } = await makeWorld();
    const pending = await write(memory, rule("worker big rule", homes.channel, { body: big(9) }), ALICE);
    await write(memory, rule("rule alpha", homes.channel, { body: big(1) }), HUMAN);
    await write(memory, rule("rule beta", homes.channel, { body: big(2) }), HUMAN);
    expect((await refusal(memory.approve(pending.id, { baseVersion: 1, actor: LEAD }))).code).toBe("BUDGET_FULL");
    expect(await memory.get(pending.id)).toMatchObject({ status: "pending", flag: "blocked_budget", version: 1 });
    // It never auto-activates.
    await memory.sweep();
    expect((await memory.get(pending.id))?.status).toBe("pending");
  });
});

describe("team memory — task and branch records", () => {
  it("upserts on the unique key: created, unchanged, updated, one row", async () => {
    const { memory } = await makeWorld();
    const first = await note(memory, task("open"), LEAD);
    expect(first.upsert).toBe("created");
    expect(first.record?.uniqueKey).toBe(TASK);
    const again = await note(memory, task("open"), ARCH);
    expect(again.upsert).toBe("unchanged");
    expect(again.record?.id).toBe(first.record?.id);
    const done = await note(memory, task("done"), ARCH);
    expect(done.upsert).toBe("updated");
    expect(done.record).toMatchObject({ id: first.record!.id, version: 2, attrs: { state: "done" } });
    expect((await memory.search({ scope: scope(LEAD, { all: true }), types: ["task"], status: "all" })).total).toBe(1);
  });

  it("refuses the same key in another home instead of duplicating it", async () => {
    const { memory } = await makeWorld();
    await write(memory, branch("open", { home: { kind: "channel", ref: CH2 } }), LEAD);
    expect((await refusal(note(memory, branch(), LEAD))).code).toBe("UNIQUE_CONFLICT");
  });

  it("links decisions and branches to the task they cite, either order", async () => {
    const { memory } = await makeWorld();
    const d = await write(memory, decision("schema stays additive"), HUMAN);
    const t = await write(memory, task(), LEAD);
    const b = await write(memory, branch(), LEAD);
    const got = await memory.getMany([t.id], scope(LEAD, { all: true }));
    expect(got.records[0]!.links.map((l) => `${l.kind}:${l.id}`).sort()).toEqual([`decided_in:${d.id}`, `on_branch:${b.id}`].sort());
  });
});

describe("team memory — near matches, supersede and conflicts", () => {
  it("holds back a near match unless confirmed, and records the conflict", async () => {
    const { memory } = await makeWorld();
    const first = await write(memory, convention("deploy uses copy install"), HUMAN);
    const held = await note(memory, convention("deploy uses copy install only", homes.team), LEAD);
    expect(held.record).toBeNull();
    expect(held.nearMatches.map((m) => m.id)).toEqual([first.id]);
    const confirmed = await note(memory, convention("deploy uses copy install only", homes.team, { confirmNew: true }), LEAD);
    expect(confirmed.record?.conflictsWith).toEqual([first.id]);
  });

  it("supersedes the named record, retires it, and lets a worker supersede only its own", async () => {
    const { memory } = await makeWorld();
    const old = await write(memory, convention("review before merge"), HUMAN);
    const next = await write(memory, convention("review before merge, two eyes", homes.channel, { supersedes: old.id, supersedesVersion: 1 }), LEAD);
    expect(next).toMatchObject({ supersedes: old.id, conflictsWith: [old.id], status: "active" });
    expect(await memory.get(old.id)).toMatchObject({ status: "superseded", supersededBy: next.id, version: 2 });
    expect((await refusal(note(memory, convention("bob takeover", homes.channel, { supersedes: next.id }), BOB))).code).toBe("NOT_OWNER");
  });
});

describe("team memory — widen", () => {
  it("moves a record to a wider home in place with one version and a tag snapshot", async () => {
    const { memory } = await makeWorld();
    const d = await write(memory, decision("wire format is json"), HUMAN);
    const widened = await memory.widen(d.id, { to: homes.channel, baseVersion: 1, actor: LEAD, reason: "applies channel-wide" });
    expect(widened).toMatchObject({ id: d.id, home: homes.channel, version: 2, status: "active" });
    expect(widened.tags).toEqual(expect.arrayContaining([{ kind: "channel", ref: CH }, { kind: "team", ref: WS }]));
    expect(widened.tags).not.toContainEqual({ kind: "task", ref: TASK });
    expect((await memory.versions(d.id))[0]).toMatchObject({ action: "widen", reason: "applies channel-wide", home: homes.channel });
    expect((await refusal(memory.widen(d.id, { to: homes.team, baseVersion: 2, actor: LEAD }))).code).toBe("INVALID_PROMOTION");
    expect((await refusal(memory.widen(d.id, { to: homes.task, baseVersion: 2, actor: LEAD }))).code).toBe("INVALID_PROMOTION");
  });
});

describe("team memory — purge", () => {
  it("removes the text from the record, every version and the database files", async () => {
    const { root, memory } = await makeWorld();
    const marker = "PURGE-MARKER-7f3a9c";
    const b = await write(memory, branch("open", { title: `branch ${marker}` }), LEAD);
    expect((await note(memory, branch("merged", { title: `branch ${marker} merged` }), LEAD)).upsert).toBe("updated");
    const purged = await memory.purge(b.id, { actor: HUMAN, reason: "test" });
    expect(purged).toMatchObject({ status: "purged", title: null, body: null, attrs: null, pinned: false, uniqueKey: null });
    expect(purged.tags.some((t) => t.kind === "repo" || t.kind === "branch")).toBe(false);
    const versions = await memory.versions(b.id);
    expect(versions.every((v) => v.title === null && v.body === null && v.attrs === null)).toBe(true);
    expect(versions[0]?.action).toBe("purge");
    expect((await refusal(memory.restore(b.id, { version: 1, baseVersion: purged.version, actor: HUMAN }))).code).toBe("PURGED");
    // The unique key is free again.
    expect((await note(memory, branch(), LEAD)).upsert).toBe("created");

    let hits = 0;
    for (const file of readdirSync(root)) {
      const bytes = readFileSync(path.join(root, file));
      for (let i = bytes.indexOf(marker); i !== -1; i = bytes.indexOf(marker, i + 1)) hits += 1;
    }
    expect(hits).toBe(0);
  });

  it("refuses any change to a version row other than the purge scrub", async () => {
    const { repo, memory } = await makeWorld();
    const c = await write(memory, convention("immutable history"), HUMAN);
    const db = repo.teamDb();
    await expect(db.run("UPDATE team_memory_versions SET body = 'rewritten' WHERE memory_id = ?", c.id)).rejects.toThrow();
    await expect(db.run("UPDATE team_memory_versions SET actor_id = 'x' WHERE memory_id = ?", c.id)).rejects.toThrow();
    await expect(db.run("DELETE FROM team_memory_versions WHERE memory_id = ?", c.id)).rejects.toThrow();
  });
});

describe("team memory — restore", () => {
  it("brings an earlier version back as a new version", async () => {
    const { memory } = await makeWorld();
    const c = await write(memory, convention("original wording"), HUMAN);
    await memory.patch(c.id, { baseVersion: 1, actor: HUMAN, body: "new wording" });
    expect(await memory.restore(c.id, { version: 1, baseVersion: 2, actor: HUMAN })).toMatchObject({
      version: 3,
      body: "original wording — body",
    });
  });
});

describe("team memory — expiry", () => {
  it("expires unpinned conventions and how_to_work idle 30 days; keeps rules, the task picture, pinned and cited", async () => {
    const { memory, clock } = await makeWorld();
    const idle = await write(memory, convention("idle convention"), HUMAN);
    const habit = await write(memory, howTo("idle habit", ALICE), HUMAN);
    const pinned = await write(memory, convention("pinned convention", homes.channel, { pinned: true }), HUMAN);
    const cited = await write(memory, convention("cited convention"), HUMAN);
    const r = await write(memory, rule("old rule"), HUMAN);
    const d = await write(memory, decision("old decision"), HUMAN);
    const t = await write(memory, task(), LEAD);
    clock.t += MEMORY_EXPIRY_MS - 1000;
    await memory.getMany([cited.id], scope(LEAD, { all: true }));
    clock.t += 2000;
    expect(await memory.sweep()).toBe(2);
    for (const id of [idle.id, habit.id]) expect((await memory.get(id))?.status).toBe("expired");
    for (const id of [pinned.id, cited.id, r.id, d.id, t.id]) expect((await memory.get(id))?.status).toBe("active");
    expect((await memory.versions(idle.id))[0]).toMatchObject({ action: "expire", actorId: "system:expiry-sweep" });
  });
});

describe("team memory — injection", () => {
  it("loads narrowest first, rules and pins always, the rest within the layer budget", async () => {
    const { memory } = await makeWorld();
    const filler = "y".repeat(1990);
    const teamRule = await write(memory, rule("team rule", homes.team), HUMAN);
    const chConv = await write(memory, convention("channel conv"), HUMAN);
    const fill1 = await write(memory, convention("filler one", homes.team, { body: filler }), HUMAN);
    const fill2 = await write(memory, convention("filler two", homes.team, { body: filler }), HUMAN);
    const d = await write(memory, decision("task decision"), HUMAN);
    const habit = await write(memory, howTo("alice habit", ALICE), HUMAN);
    await write(memory, howTo("bob habit", BOB), HUMAN);

    const inj = await memory.inject({ expertId: ALICE.id, workspaceId: WS, channelRef: CH, taskRef: TASK });
    const order = inj.entries.map((e) => e.id);
    expect(order[0]).toBe(d.id);
    expect(order.indexOf(chConv.id)).toBeLessThan(order.indexOf(teamRule.id));
    // Two ~667-token fillers do not both fit a 1000-token team layer.
    expect([order.includes(fill1.id), order.includes(fill2.id)].filter(Boolean)).toHaveLength(1);
    expect(inj.omitted).toBe(1);
    expect(inj.index.find((i) => i.home.kind === "team")?.items).toHaveLength(1);
    // Only the asking expert's how_to_work.
    expect(inj.entries.filter((e) => e.type === "how_to_work").map((e) => e.id)).toEqual([habit.id]);
  });

  it("loads the current task's linked branch and decisions in the task bucket", async () => {
    const { memory } = await makeWorld();
    await write(memory, task(), LEAD);
    const b = await write(memory, branch(), LEAD);
    expect((await memory.inject({ expertId: ALICE.id, workspaceId: WS, taskRef: TASK })).entries.map((e) => e.id)).toContain(b.id);
    expect((await memory.inject({ expertId: ALICE.id, workspaceId: WS })).entries.map((e) => e.id)).not.toContain(b.id);
  });

  it("skips duplicate text, loads only the winner of a conflict, and writes nothing", async () => {
    const { memory } = await makeWorld();
    // Same title and body as two types, so no near-match conflict between them.
    await write(memory, rule("same text"), HUMAN);
    await write(memory, convention("same text", homes.team), HUMAN);
    const loser = await write(memory, convention("tabs for indent", homes.team), HUMAN);
    const winner = await write(memory, convention("tabs for indent always", homes.channel, { confirmNew: true }), HUMAN);
    expect(winner.conflictsWith).toEqual([loser.id]);
    const before = await memory.get(loser.id);
    const inj = await memory.inject({ expertId: ALICE.id, workspaceId: WS, channelRef: CH });
    expect(inj.duplicates).toBe(1);
    expect(inj.conflicts).toBe(1);
    const ids = inj.entries.map((e) => e.id);
    // Same priority: the narrower (channel) record wins over the team one.
    expect(ids).toContain(winner.id);
    expect(ids).not.toContain(loser.id);
    expect(inj.index.flatMap((i) => i.items).find((i) => i.id === loser.id)).toBeDefined();
    expect(await memory.get(loser.id)).toEqual(before);
  });

  it("uses the setting by default and never exceeds the cap", async () => {
    const { memory } = await makeWorld();
    await memory.updateSettings({ injectLayerTokens: 1200, actor: HUMAN });
    expect((await memory.inject({ expertId: ALICE.id, workspaceId: WS })).layerTokens).toBe(1200);
    expect((await memory.inject({ expertId: ALICE.id, workspaceId: WS, layerTokens: 99_999 })).layerTokens).toBe(
      MEMORY_INJECT_LAYER_CAP_TOKENS,
    );
  });
});

describe("team memory — rule feed", () => {
  it("lists every rule version in the Workspace, newest first", async () => {
    const { memory, clock } = await makeWorld();
    const r = await write(memory, rule("feed rule"), ALICE);
    clock.t += 1000;
    await memory.approve(r.id, { baseVersion: 1, actor: LEAD });
    await write(memory, convention("not a rule"), HUMAN);
    expect((await memory.ruleFeed(WS)).map((v) => [v.memoryId, v.action])).toEqual([
      [r.id, "approve"],
      [r.id, "create"],
    ]);
  });
});

describe("team memory — usage", () => {
  it("reports each home's always-load use with the same numbers the cap enforces", async () => {
    const { memory } = await makeWorld();
    const a = await write(memory, rule("rule alpha", homes.channel, { body: big(1) }), HUMAN);
    const b = await write(memory, rule("rule beta", homes.channel, { body: big(2) }), HUMAN);
    await write(memory, rule("team rule", homes.team), HUMAN);
    // Not always-load: an unpinned convention, an active decision (its task home is not listed),
    // a pending rule, a retracted rule.
    await write(memory, convention("plain convention", homes.channel), HUMAN);
    await write(memory, decision("ship the memory page"), HUMAN);
    await write(memory, rule("queue deploys behind approval", homes.team), ALICE);
    const gone = await write(memory, rule("retracted rule", homes.channel), HUMAN);
    await memory.retract(gone.id, { baseVersion: 1, actor: HUMAN });
    // Another Workspace's home is not listed.
    await write(memory, rule("other ws rule", homes.channel, { workspaceId: "ws-2" }), HUMAN);
    // A pending rule blocked by the full channel home is counted there.
    const blocked = await write(memory, rule("oversized onboarding checklist", homes.channel, { body: big(9) }), ALICE);
    expect((await refusal(memory.approve(blocked.id, { baseVersion: 1, actor: LEAD }))).code).toBe("BUDGET_FULL");

    const usage = await memory.usage(WS);
    expect(usage).toMatchObject({ workspaceId: WS, capTokens: MEMORY_INJECT_LAYER_CAP_TOKENS, injectLayerTokens: { min: 1, max: MEMORY_INJECT_LAYER_CAP_TOKENS } });
    expect(usage.homes.map((h) => h.home)).toEqual([homes.channel, homes.team]);
    const channel = usage.homes[0]!;
    expect(channel).toMatchObject({ records: 2, blockedPending: 1, usedTokens: a.tokens + b.tokens });
    expect(channel.largest.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    // The number the page shows is the one BUDGET_FULL reports.
    const exc = await refusal(note(memory, rule("rule gamma", homes.channel, { body: big(3) }), HUMAN));
    expect(exc.details?.["usedTokens"]).toBe(channel.usedTokens);
    expect(usage.homes[1]).toMatchObject({ records: 1, blockedPending: 0 });
  });

  it("lists an expert home in every Workspace, since how_to_work belongs to none", async () => {
    const { memory } = await makeWorld();
    const mine = await write(memory, howTo("squash before merging", ALICE), ALICE);
    await memory.approve(mine.id, { baseVersion: 1, actor: HUMAN });
    await memory.patch(mine.id, { baseVersion: 2, actor: HUMAN, pinned: true });
    const elsewhere = await write(memory, howTo("review diffs file by file", ALICE), ALICE);
    await memory.approve(elsewhere.id, { baseVersion: 1, actor: HUMAN });
    await memory.patch(elsewhere.id, { baseVersion: 2, actor: HUMAN, pinned: true });
    const usage = await memory.usage(WS);
    const expert = usage.homes.find((h) => h.home.kind === "expert")!;
    expect(expert.home).toEqual({ kind: "expert", ref: ALICE.id });
    expect(expert.records).toBe(2);
    expect(expert.largest.every((c) => c.pinned)).toBe(true);
    expect(mine.workspaceId).toBeNull();
    // Another Workspace sees the same expert home and no team, channel or task home.
    expect((await memory.usage("ws-other")).homes).toEqual([expert]);
    expect((await refusal(memory.usage(""))).code).toBe("INVALID_SCOPE");
  });
});

describe("team memory — HTTP surface", () => {
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("notes, searches, gets, patches, widens and lists versions", async () => {
    const h = await startHarness();
    await h.request("/team/v1/memory/settings", json("PUT", { orchestrators: [LEAD.id], actor: HUMAN }));
    const created = await h.request("/team/v1/memory", json("POST", { ...convention("http convention"), actor: ALICE }));
    expect(created.status).toBe(201);
    const { record } = (await created.json()) as { record: MemoryRecord };
    const search = await h.get(`/team/v1/memory?workspaceId=${WS}&expertId=${ALICE.id}&channels=${CH}`);
    expect(((await search.json()) as { total: number }).total).toBe(1);
    const got = await h.request(`/team/v1/memory/get?workspaceId=${WS}&expertId=${BOB.id}`, json("POST", { ids: [record.id] }));
    expect(await got.json()).toMatchObject({ records: [], missing: [record.id] });
    const patched = await h.request(`/team/v1/memory/${record.id}`, json("PATCH", { baseVersion: 1, body: "revised", actor: ALICE }));
    expect(patched.status).toBe(200);
    const widened = await h.request(`/team/v1/memory/${record.id}/widen`, json("POST", { to: homes.team, baseVersion: 2, actor: LEAD }));
    expect(await widened.json()).toMatchObject({ home: homes.team, version: 3 });
    const versions = (await (await h.get(`/team/v1/memory/${record.id}/versions`)).json()) as { versions: unknown[] };
    expect(versions.versions).toHaveLength(3);
  });

  it("maps refusals to their status, stable code and details", async () => {
    const h = await startHarness();
    const secret = await h.request("/team/v1/memory", json("POST", { ...convention(`sk-${"a1B2".repeat(8)}`), actor: ALICE }));
    expect(secret.status).toBe(422);
    expect(await secret.json()).toMatchObject({ ok: false, code: "SECRET_DETECTED" });
    const purge = await h.request("/team/v1/memory/mem_x/purge", json("POST", { actor: ALICE }));
    expect(await purge.json()).toMatchObject({ code: "HUMAN_ONLY" });
    const workerTask = await h.request("/team/v1/memory", json("POST", { ...task(), actor: ALICE }));
    expect(workerTask.status).toBe(403);
    expect(await workerTask.json()).toMatchObject({ code: "SCOPE_FORBIDDEN" });
    await h.request("/team/v1/memory", json("POST", { ...rule("http alpha", homes.channel, { body: big(1) }), actor: HUMAN }));
    await h.request("/team/v1/memory", json("POST", { ...rule("http beta", homes.channel, { body: big(2) }), actor: HUMAN }));
    const full = await h.request("/team/v1/memory", json("POST", { ...rule("http gamma", homes.channel, { body: big(3) }), actor: HUMAN }));
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: "BUDGET_FULL", details: { capTokens: MEMORY_INJECT_LAYER_CAP_TOKENS } });
    expect((await h.get("/team/v1/memory?workspaceId=ws-1")).status).toBe(400);
    expect((await h.request("/team/v1/memory/settings", { method: "DELETE" })).status).toBe(405);
  });

  it("serves settings, injection and the rule feed", async () => {
    const h = await startHarness();
    const put = await h.request("/team/v1/memory/settings", json("PUT", { injectLayerTokens: 1200, actor: HUMAN }));
    expect(await put.json()).toMatchObject({ injectLayerTokens: 1200, expertApproval: "required", orchestrators: [] });
    const inj = await h.get(`/team/v1/memory/inject?expertId=${ALICE.id}&workspaceId=${WS}`);
    expect(await inj.json()).toMatchObject({ layerTokens: 1200, entries: [] });
    expect(await (await h.get(`/team/v1/memory/rule-feed?workspaceId=${WS}`)).json()).toEqual({ versions: [] });
    expect(await (await h.get(`/team/v1/memory/usage?workspaceId=${WS}`)).json()).toEqual({
      workspaceId: WS,
      capTokens: MEMORY_INJECT_LAYER_CAP_TOKENS,
      injectLayerTokens: { min: 1, max: MEMORY_INJECT_LAYER_CAP_TOKENS },
      homes: [],
    });
    expect((await h.get("/team/v1/memory/usage")).status).toBe(400);
    expect((await h.request(`/team/v1/memory/usage?workspaceId=${WS}`, { method: "POST" })).status).toBe(405);
  });
});
