/**
 * Round-2 regression tests for external-review findings F1-F3
 * (ddvnguyen/paseo#37): transactional lock + re-read-inside-lock.
 *
 * (a) rollback — a mid-sequence failure inside saveTrack's flow leaves NO
 *     partial state (queue/workers/turn_count unchanged);
 * (b) concurrent task_add x2 — BOTH tasks persist (lost-update guard);
 * (c) concurrent turn_report x2 — distinct turn numbers, both rows present,
 *     turn_count consistent (no orphaned turn_count);
 * (d) cross-connection exclusion — BEGIN IMMEDIATE on the repo connection
 *     makes a second connection's write fail busy/locked until commit.
 *
 * Each test opens a fresh temp fleet.db via TursoRepository (the ONLY module
 * importing @tursodatabase/database, per the turso-import gate). Temp dirs
 * are removed in afterEach; the probe row in (d) needs no DELETE cleanup
 * (orch_events is INSERT-only by schema trigger).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeQueueItem, utcnowIso, type TurnDelta } from "../../src/domain/models.js";
import { leaderRegister } from "../../src/domain/tools/leader.js";
import { taskAdd } from "../../src/domain/tools/projects.js";
import { turnReport } from "../../src/domain/tools/reporting.js";
import { TursoRepository } from "../../src/store/turso-repository.js";

// Mirrors tests/parity/cases.ts LEADER_MODEL (accepted by the default fleet map).
const LEADER_MODEL = "command_code/z-ai/glm-5.3-flash";

const openRepos: TursoRepository[] = [];
const tmpDirs: string[] = [];

async function makeStore(): Promise<{
  repo: TursoRepository;
  dbPath: string;
  projectId: string;
  trackId: string;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-round2-"));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, "fleet.db");
  const repo = await TursoRepository.open(dir, dbPath);
  openRepos.push(repo);
  const project = await repo.createProject("round2", [], "omp");
  const track = await repo.createTrack(project.id, "epic", "goal");
  return { repo, dbPath, projectId: project.id, trackId: track.id };
}

afterEach(async () => {
  for (const repo of openRepos) await repo.close().catch(() => undefined);
  openRepos.length = 0;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function turnDelta(n: number): TurnDelta {
  return {
    n,
    ts: utcnowIso(),
    summary: "s",
    status: "running",
    done: [],
    next: [],
    blockers: [],
    decisions: [],
    knowledge: { lesson_topic: null, docs_updated: [] },
    author_agent: "a",
    author_model: "m",
  };
}

describe("round2: transactional lock + re-read-inside-lock (F1-F3)", () => {
  it("(a) rollback: mid-sequence saveTrack failure leaves no partial state", async () => {
    const { repo, trackId } = await makeStore();
    const base = await repo.getTrack(trackId);
    const keepA = makeQueueItem({ title: "keep-a" });
    const keepB = makeQueueItem({ title: "keep-b" });
    base.queue.push(keepA, keepB);
    await repo.saveTrack(base);
    const before = await repo.getTrack(trackId);

    // Poison: a valid new task (would persist as partial state without a
    // transaction) + a duplicate PK (fails mid-sequence) + bumped turn_count.
    const poison = await repo.getTrack(trackId);
    const fresh = makeQueueItem({ title: "fresh-partial" });
    poison.queue.push(fresh);
    poison.queue.push({ ...keepA, title: "dup" });
    poison.turn_count = 999;
    await expect(repo.lock("track-poison", () => repo.saveTrack(poison))).rejects.toThrow();

    const after = await repo.getTrack(trackId);
    expect(after.queue.map((q) => q.id).sort()).toEqual([keepA.id, keepB.id].sort());
    expect(after.queue.map((q) => q.title).sort()).toEqual(["keep-a", "keep-b"]);
    expect(after.turn_count).toBe(before.turn_count);
    expect(after.workers).toEqual(before.workers);
  });

  it("(a) rollback: turn_count never persists without its turn row", async () => {
    const { repo, projectId, trackId } = await makeStore();
    await expect(
      repo.lock("track-turn", async () => {
        const track = await repo.getTrack(trackId);
        track.turn_count = 1;
        await repo.saveTrack(track);
        await repo.saveTurn(projectId, trackId, turnDelta(1));
        // Duplicate (track_id, n) PK: must roll back the turn_count too.
        await repo.saveTurn(projectId, trackId, turnDelta(1));
      }),
    ).rejects.toThrow();

    const after = await repo.getTrack(trackId);
    expect(after.turn_count).toBe(0);
    expect(await repo.readTurns(projectId, trackId)).toEqual([]);
  });

  it("(b) concurrent task_add x2: BOTH tasks persist", async () => {
    const { repo, trackId } = await makeStore();
    const [r1, r2] = await Promise.all([
      taskAdd(repo, trackId, "alpha"),
      taskAdd(repo, trackId, "beta"),
    ]);
    expect(r1["ok"]).toBe(true);
    expect(r2["ok"]).toBe(true);
    const after = await repo.getTrack(trackId);
    expect(after.queue.map((q) => q.title).sort()).toEqual(["alpha", "beta"]);
  });

  it("(c) concurrent turn_report x2: distinct turns, consistent turn_count", async () => {
    const { repo, trackId } = await makeStore();
    const reg = await leaderRegister(repo, trackId, "test-leader", LEADER_MODEL, "0.0.1");
    expect(reg["ok"]).toBe(true);
    const [r1, r2] = await Promise.all([
      turnReport(repo, trackId, "first turn"),
      turnReport(repo, trackId, "second turn"),
    ]);
    expect(r1["ok"]).toBe(true);
    expect(r2["ok"]).toBe(true);
    expect([r1["turn"], r2["turn"]].sort()).toEqual([1, 2]);
    const rows = await repo.readTurns((await repo.getTrack(trackId)).project_id, trackId);
    expect(rows.map((r) => r["n"]).sort()).toEqual([1, 2]);
    expect((await repo.getTrack(trackId)).turn_count).toBe(2);
  });

  it("(d) BEGIN IMMEDIATE excludes a concurrent writer on a second connection", async () => {
    const { repo, dbPath, projectId, trackId } = await makeStore();
    const probeArgs = [projectId, trackId, "probe", "2030-01-01T00:00:00.000Z", "{}"] as const;
    const insertProbe = (): Promise<Record<string, unknown>[]> =>
      TursoRepository.queryRows(
        dbPath,
        "INSERT INTO orch_events(project_id, track_id, type, ts, payload) VALUES(?, ?, ?, ?, ?)",
        ...probeArgs,
      );

    const holder = repo.lock("hold", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return "held";
    });
    // Let the holder reach BEGIN IMMEDIATE before the rival write lands.
    await new Promise((r) => setTimeout(r, 300));
    await expect(insertProbe()).rejects.toThrow(/busy|locked/i);
    expect(await holder).toBe("held");

    // Same statement succeeds after commit: the failure was the held write
    // lock, not the statement itself.
    await insertProbe();
    const probes = (await repo.readEvents(projectId)).filter((e) => e["type"] === "probe");
    expect(probes.length).toBe(1);
  }, 15000);
});
