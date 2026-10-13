/**
 * Team Room durability (contract §6 A2) and fail-closed writes (A3, backend side).
 * Real fleet.db files in a scratch dir. Restart is a real close and reopen.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TursoRepository } from "../../src/store/turso-repository.js";
import { TeamRoomStore } from "../../src/team-room/store.js";
import { createFleetHttpServer } from "../../src/surfaces/http/router.js";
import type { AddressInfo } from "node:net";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): { root: string; dbPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), "moct-team-"));
  dirs.push(root);
  return { root, dbPath: path.join(root, "fleet.db") };
}

const rec = (sequence: number) => ({ sequence, operationId: `op-${sequence}`, kind: "message.post" });

describe("team room — restart (A2)", () => {
  it("keeps every appended operation across a close and reopen, and the sequence continues", async () => {
    const { root, dbPath } = scratch();
    let repo = await TursoRepository.open(root, dbPath);
    let team = new TeamRoomStore(repo.teamDb());
    for (const seq of [1, 2, 3]) expect(await team.append("ws", rec(seq))).toEqual({ status: "stored" });
    await repo.close();

    repo = await TursoRepository.open(root, dbPath);
    team = new TeamRoomStore(repo.teamDb());
    expect(await team.head("ws")).toBe(3);
    const replayed = await team.page("ws", 0, 10);
    expect(replayed.operations.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(replayed.operations.map((r) => r.operationId)).toEqual(["op-1", "op-2", "op-3"]);

    // A retry of an already-stored operation after restart is a replay, not a duplicate.
    expect(await team.append("ws", rec(3))).toEqual({ status: "replayed" });
    expect(await team.append("ws", rec(4))).toEqual({ status: "stored" });
    expect((await team.page("ws", 0, 10)).operations).toHaveLength(4);
    await repo.close();
  });

  it("stamps schema v6, v7 and v8 on a fresh database", async () => {
    const { root, dbPath } = scratch();
    const repo = await TursoRepository.open(root, dbPath);
    const meta = await TursoRepository.queryRows(dbPath, "SELECT key FROM meta WHERE key = 'schema_version:6'");
    expect(meta).toHaveLength(1);
    const v7 = await TursoRepository.queryRows(dbPath, "SELECT key FROM meta WHERE key = 'schema_version:7'");
    expect(v7).toHaveLength(1);
    const v8 = await TursoRepository.queryRows(dbPath, "SELECT key FROM meta WHERE key = 'schema_version:8'");
    expect(v8).toHaveLength(1);
    await repo.close();
  });
});

describe("team room — fail closed (A3, backend side)", () => {
  it("answers 500 and writes nothing when the store is closed", async () => {
    const { root, dbPath } = scratch();
    const repo = await TursoRepository.open(root, dbPath);
    const team = new TeamRoomStore(repo.teamDb());
    const server = createFleetHttpServer({ store: repo, token: "", team });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await repo.close();
      const res = await fetch(`http://127.0.0.1:${port}/team/v1/operations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws", record: rec(1) }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: "internal error" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const reopened = await TursoRepository.open(root, dbPath);
    expect(await new TeamRoomStore(reopened.teamDb()).head("ws")).toBe(0);
    await reopened.close();
  });
});

describe("team room — backup (contract §1)", () => {
  it("copies the live database on its own connection and the copy holds every operation", async () => {
    const { root, dbPath } = scratch();
    const backupDir = path.join(root, "backups");
    const repo = await TursoRepository.open(root, dbPath);
    const team = new TeamRoomStore(repo.teamDb(), dbPath, backupDir);
    await team.append("ws", rec(1));
    await team.append("ws", rec(2));
    const file = await team.backup("20261010T000000Z");
    expect(file).toBe(path.join(backupDir, "moct-20261010T000000Z.db"));
    // The daemon keeps running and keeps writing after the copy.
    await team.append("ws", rec(3));
    const copied = await TursoRepository.queryRows(file, "SELECT sequence FROM team_operations ORDER BY sequence");
    expect(copied.map((r) => r["sequence"])).toEqual([1, 2]);
    await repo.close();
  });
});
