/**
 * Round-3 concurrency tests for owner worth-a-test #4 (ddvnguyen/paseo#37):
 * unlocked writers share the open transaction on the single connection.
 *
 * decision_add (decisionRecord) runs OUTSIDE lock() — a faithful port
 * (Python's decision_add is also unlocked). On one shared connection an
 * unlocked write that lands inside another call's open BEGIN IMMEDIATE is
 * committed or rolled back WITH that transaction. This test pins the
 * observable outcome: a decision recorded mid-transaction beside a throwing
 * locked section is absorbed by the rollback (returns ok, row gone).
 *
 * Python behaves identically (single Store connection, unlocked
 * decision_add), so NO divergence is confirmed and NO lock() wrapping is
 * added — deliberately disclosed in tests/parity/HARNESS.md. If this test
 * ever shows the row surviving, that IS the divergence signal to re-open
 * the wrap decision.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decisionRecord } from "../../src/domain/tools/reporting.js";
import { TursoRepository } from "../../src/store/turso-repository.js";

const openRepos: TursoRepository[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const repo of openRepos) await repo.close().catch(() => undefined);
  openRepos.length = 0;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe("round3: unlocked writer beside a throwing locked section (#4)", () => {
  it("(e) decision recorded inside an open tx is absorbed by its rollback", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fleet-round3-"));
    tmpDirs.push(dir);
    const repo = await TursoRepository.open(dir, path.join(dir, "fleet.db"));
    openRepos.push(repo);
    const project = await repo.createProject("round3", [], "omp");
    const track = await repo.createTrack(project.id, "epic", "goal");

    // Throwing section opens a write tx, mutates, then fails mid-flight.
    const doomed = repo.lock("doomed", async () => {
      const t = await repo.getTrack(track.id);
      t.turn_count = 999;
      await repo.saveTrack(t);
      await new Promise((r) => setTimeout(r, 400));
      throw new Error("boom");
    });
    // Unlocked writer lands while the tx is open (100ms < 400ms margins).
    await new Promise((r) => setTimeout(r, 100));
    const dec = await decisionRecord(repo, track.id, "concurrent decision", "rationale");
    expect(dec["ok"]).toBe(true);
    await expect(doomed).rejects.toThrow("boom");

    // Pinned outcome: the doomed turn_count is rolled back AND the unlocked
    // decision row is absorbed with it (same shared connection, same tx).
    const after = await repo.getTrack(track.id);
    expect(after.turn_count).toBe(0);
    expect(await repo.readDecisions(project.id)).toEqual([]);
  }, 15000);
});
