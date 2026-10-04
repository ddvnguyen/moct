/**
 * Team domain (LLM-Agents-Orchestration#70, Lane T) — the four tables and the
 * three tools.
 *
 * The evidence this file exists to produce, in order:
 *   1. the DDL round-trips on a scratch fleet.db (tables created and queried);
 *   2. team create/get/roster, including the unknown-team error shape;
 *   3. team_join's packet blocks are TRACEABLE — every block's `source` names
 *      the contract that produced it (asserted, not just "a block exists"),
 *      and there are no memory blocks (owner freeze);
 *   4. team_resolve BOTH branches: live -> agent_id, vacant -> vacant + packet;
 *   5. non-first-mate seats behave per #70 (pooled, not refused, not first-mate);
 *   6. importing the module has no side effects (the src/mcp.ts discipline).
 *
 * Every store is a fresh temp fleet.db via TursoRepository — the only module
 * importing @tursodatabase/database (turso-import gate). The live
 * orchestration.sqlite is never opened.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TursoRepository } from "../../src/store/turso-repository.js";
import {
  DEFAULT_SEATS,
  FIRST_MATE_SEATS,
  PACKET_SOURCES,
  TEAM_DOMAIN,
  isFirstMateSeat,
} from "../../src/tools/team.js";

const openRepos: TursoRepository[] = [];
const tmpDirs: string[] = [];

interface World {
  repo: TursoRepository;
  dbPath: string;
  projectId: string;
  trackId: string;
  summaryPath: string;
  previousSummaryPath: string | undefined;
}

async function makeWorld(summaryMd?: string): Promise<World> {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-team-"));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, "fleet.db");
  const repo = await TursoRepository.open(dir, dbPath);
  openRepos.push(repo);
  const project = await repo.createProject("team-domain", [], "omp");
  const track = await repo.createTrack(project.id, "team epic", "team goal");

  // The project-summary resource reads summaryPath() (MCP_ORCH_SUMMARY_PATH),
  // which the parity harness also points at a temp file. Point it at this
  // world so the packet's project_summary block is real, not an error path.
  const summaryPath = path.join(dir, "orchestration.md");
  if (summaryMd !== undefined) writeFileSync(summaryPath, summaryMd, "utf-8");
  const previousSummaryPath = process.env["MCP_ORCH_SUMMARY_PATH"];
  process.env["MCP_ORCH_SUMMARY_PATH"] = summaryPath;
  return {
    repo,
    dbPath,
    projectId: project.id,
    trackId: track.id,
    summaryPath,
    previousSummaryPath,
  };
}

afterEach(async () => {
  for (const repo of openRepos) await repo.close().catch(() => undefined);
  openRepos.length = 0;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function tool(name: string) {
  const spec = TEAM_DOMAIN.tools.find((t) => t.name === name);
  if (!spec) throw new Error(`no tool ${name} in TEAM_DOMAIN`);
  return spec;
}

/** Run a team tool through the seam's ToolSpec contract, as a surface would. */
function run(repo: TursoRepository, name: string, args: Record<string, unknown>) {
  return Promise.resolve(tool(name).run(repo, args));
}

// ---------------------------------------------------------------------------

describe("team domain DDL (schema v3)", () => {
  it("creates all four tables and stamps every applied schema version", async () => {
    const world = await makeWorld();
    const tables = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('teams','team_tracks','seats','seat_sessions') ORDER BY name",
    );
    // Acceptance: the tables exist, named exactly as the owner specified.
    expect(tables.map((r) => r["name"])).toEqual([
      "seat_sessions",
      "seats",
      "team_tracks",
      "teams",
    ]);

    const versions = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT key FROM meta WHERE key LIKE 'schema_version:%' ORDER BY key",
    );
    expect(versions.map((r) => r["key"])).toEqual(["schema_version:2", "schema_version:3"]);
  });

  it("round-trips team -> seats -> team_tracks -> seat_sessions", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", {
      action: "create",
      name: "Round Trip",
      mission: "prove the DDL",
      track_id: world.trackId,
    });
    expect(created["ok"]).toBe(true);
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);

    const seats = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT seat, first_mate FROM seats WHERE team_id=? ORDER BY seat",
      teamId,
    );
    expect(seats.map((r) => r["seat"])).toEqual([...DEFAULT_SEATS].sort());
    expect(Number(seats.find((r) => r["seat"] === "lead")!["first_mate"])).toBe(1);
    expect(Number(seats.find((r) => r["seat"] === "dev")!["first_mate"])).toBe(0);

    const linked = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT track_id FROM team_tracks WHERE team_id=?",
      teamId,
    );
    expect(linked.map((r) => r["track_id"])).toEqual([world.trackId]);

    await run(world.repo, "team_join", { team: teamId, seat: "lead", agent_id: "agent-live-1" });
    const sessions = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT seat, agent_id, model, started_at, ended_at, end_reason FROM seat_sessions WHERE team_id=? ORDER BY seat",
      teamId,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]["agent_id"]).toBe("agent-live-1");
    expect(sessions[0]["ended_at"]).toBeNull();
    expect(String(sessions[0]["started_at"])).not.toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("team create / get / roster", () => {
  it("creates a team with the default roster and derives first-mate", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", { action: "create", name: "Fleet Room" });
    expect(created["ok"]).toBe(true);
    const team = created["team"] as Record<string, unknown>;
    expect(String(team["id"])).toMatch(/^team-/);
    expect(team["name"]).toBe("Fleet Room");

    // Canonical roster order: first-mates lead, then pooled workers.
    const seats = created["seats"] as Record<string, unknown>[];
    expect(seats.map((s) => s["seat"])).toEqual(["lead", "architect", "dev", "devops", "qa"]);
    // Only lead + architect are first-mate; the rest are pooled worker seats.
    expect(seats.filter((s) => s["first_mate"] === true).map((s) => s["seat"])).toEqual([
      "lead",
      "architect",
    ]);
    for (const seat of seats) {
      const expected = isFirstMateSeat(String(seat["seat"]));
      expect(seat["first_mate"]).toBe(expected);
      expect(seat["occupancy"]).toBe(expected ? "exclusive" : "pooled");
    }
  });

  it("get returns the team, its tracks and its seats", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", {
      action: "create",
      name: "Get Me",
      track_id: world.trackId,
    });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);

    const got = await run(world.repo, "team", { action: "get", team: teamId });
    expect(got["ok"]).toBe(true);
    expect(got["tracks"]).toEqual([{ track_id: world.trackId, primary: true }]);
    expect((got["seats"] as unknown[]).length).toBe(DEFAULT_SEATS.length);
    // Same order in get as in create: one canonical roster order.
    expect((got["seats"] as Record<string, unknown>[]).map((s) => s["seat"])).toEqual([
      "lead",
      "architect",
      "dev",
      "devops",
      "qa",
    ]);
    expect(got["first_mates"]).toEqual(["lead", "architect"]);
  });

  it("roster reflects live occupancy and leaves other seats vacant", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", { action: "create", name: "Roster Me" });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);
    await run(world.repo, "team_join", { team: teamId, seat: "lead", agent_id: "agent-lead" });
    await run(world.repo, "team_join", { team: teamId, seat: "dev", agent_id: "agent-dev" });

    const roster = await run(world.repo, "team", { action: "roster", team: teamId });
    expect(roster["ok"]).toBe(true);
    const seats = Object.fromEntries(
      (roster["seats"] as Record<string, unknown>[]).map((s) => [String(s["seat"]), s]),
    );
    expect(seats["lead"]!["live"]).toEqual(["agent-lead"]);
    expect(seats["lead"]!["agent_id"]).toBe("agent-lead");
    expect(seats["architect"]!["live"]).toEqual([]);
    expect(seats["architect"]!["agent_id"]).toBeNull();
    expect(seats["dev"]!["live"]).toEqual(["agent-dev"]);
    // A pooled seat has no single holder.
    expect(seats["dev"]!["agent_id"]).toBeNull();
  });

  it("returns the unknown-team error shape for every mode", async () => {
    const world = await makeWorld();
    for (const action of ["get", "roster"]) {
      const res = await run(world.repo, "team", { action, team: "team-nope" });
      expect(res["ok"]).toBe(false);
      expect(res["error"]).toBe("team not found: team-nope");
      expect(String(res["hint"])).toContain("team(action=create)");
    }
    const joined = await run(world.repo, "team_join", {
      team: "team-nope",
      seat: "lead",
      agent_id: "a",
    });
    expect(joined["ok"]).toBe(false);
    expect(joined["error"]).toBe("team not found: team-nope");
  });

  it("rejects an invalid action instead of guessing", async () => {
    const world = await makeWorld();
    const res = await run(world.repo, "team", { action: "destroy" });
    expect(res["ok"]).toBe(false);
    expect(res["error"]).toBe("invalid action 'destroy'");
    expect(res["hint"]).toBe("must be one of: create, get, roster");
  });
});

// ---------------------------------------------------------------------------

describe("bootstrap packet provenance (#70, no memory blocks)", () => {
  it("every block names the contract that produced it", async () => {
    const world = await makeWorld("# Orchestration\n\nproject summary body\n");
    const created = await run(world.repo, "team", {
      action: "create",
      name: "Packet",
      track_id: world.trackId,
    });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);

    const joined = await run(world.repo, "team_join", {
      team: teamId,
      seat: "lead",
      agent_id: "agent-lead",
      model: "command_code/z-ai/glm-5.3-flash",
    });
    const packet = joined["packet"] as Record<string, unknown>;
    const blocks = packet["blocks"] as Record<string, Record<string, unknown>>;

    // Exactly the four contracts, nothing else.
    expect(Object.keys(blocks).sort()).toEqual([
      "leader_handoff",
      "project_summary",
      "track_status",
      "track_summary",
    ]);
    // No memory blocks (owner freeze 2026-10-04).
    expect(Object.keys(blocks).some((k) => k.includes("memory"))).toBe(false);

    // Acceptance: assert the SOURCE fields, not merely that blocks exist.
    expect(blocks["track_summary"]!["source"]).toBe(
      `${PACKET_SOURCES.trackSummary}(track_id=${world.trackId}, action=spec)`,
    );
    expect(blocks["track_status"]!["source"]).toBe(
      `${PACKET_SOURCES.trackStatus}(track_id=${world.trackId})`,
    );
    expect(blocks["project_summary"]!["source"]).toBe(
      `orchestration://project/${world.projectId}/summary`,
    );
    expect(blocks["leader_handoff"]!["source"]).toBe(
      `${PACKET_SOURCES.leaderHandoff}(track_id=${world.trackId}, action=pack)`,
    );

    // Each block also carries its own contract's payload, not a stub.
    expect(blocks["project_summary"]!["ok"]).toBe(true);
    expect(String(blocks["project_summary"]!["text"])).toContain("project summary body");
    expect(blocks["track_status"]!["ok"]).toBe(true);
    expect(blocks["track_summary"]!["ok"]).toBe(true);
    expect(blocks["leader_handoff"]!["ok"]).toBe(true);

    expect(packet["track_id"]).toBe(world.trackId);
    expect(packet["project_id"]).toBe(world.projectId);
    expect(packet["seat"]).toBe("lead");
    expect(packet["first_mate"]).toBe(true);
  });

  it("a trackless team still gets four traceable blocks, each explaining itself", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", { action: "create", name: "No Track" });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);

    const joined = await run(world.repo, "team_join", {
      team: teamId,
      seat: "dev",
      agent_id: "agent-dev",
    });
    const blocks = (joined["packet"] as Record<string, unknown>)["blocks"] as Record<
      string,
      Record<string, unknown>
    >;
    // A block that cannot be produced still says which contract would have.
    for (const [name, block] of Object.entries(blocks)) {
      expect(block["source"], name).toBeTypeOf("string");
      expect(String(block["source"]), name).not.toBe("unknown");
      expect(block["ok"], name).toBe(false);
      expect(String(block["error"]), name).toMatch(/has no track/);
    }
    // The project-summary block still names the resource it would have read.
    expect(String(blocks["project_summary"]!["source"])).toContain("orchestration://project/");
  });
});

// ---------------------------------------------------------------------------

describe("team_resolve live / vacant", () => {
  it("live seat returns the agent_id holding it", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", {
      action: "create",
      name: "Live",
      track_id: world.trackId,
    });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);
    await run(world.repo, "team_join", {
      team: teamId,
      seat: "architect",
      agent_id: "agent-arch",
      model: "claude/claude-opus-5",
    });

    const resolved = await run(world.repo, "team_resolve", { seat: "architect" });
    expect(resolved["ok"]).toBe(true);
    expect(resolved["status"]).toBe("live");
    expect(resolved["agent_id"]).toBe("agent-arch");
    expect(resolved["model"]).toBe("claude/claude-opus-5");
    expect(resolved["first_mate"]).toBe(true);
    expect((resolved["team"] as Record<string, unknown>)["id"]).toBe(teamId);
    // Live means no bootstrap packet is needed.
    expect(resolved["packet"]).toBeUndefined();
  });

  it("vacant seat returns vacant plus the bootstrap packet", async () => {
    const world = await makeWorld("# summary\n");
    const created = await run(world.repo, "team", {
      action: "create",
      name: "Vacant",
      track_id: world.trackId,
    });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);

    const resolved = await run(world.repo, "team_resolve", { seat: "lead", team: teamId });
    expect(resolved["ok"]).toBe(true);
    expect(resolved["status"]).toBe("vacant");
    expect(resolved["agent_id"]).toBeNull();

    const packet = resolved["packet"] as Record<string, unknown>;
    expect(packet["seat"]).toBe("lead");
    const blocks = packet["blocks"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(blocks).sort()).toEqual([
      "leader_handoff",
      "project_summary",
      "track_status",
      "track_summary",
    ]);
    // Same provenance contract as the join packet.
    expect(blocks["track_summary"]!["source"]).toBe(
      `${PACKET_SOURCES.trackSummary}(track_id=${world.trackId}, action=spec)`,
    );
    expect(blocks["project_summary"]!["source"]).toBe(
      `orchestration://project/${world.projectId}/summary`,
    );
  });

  it("a vacated first-mate seat falls back to vacant after being replaced", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", {
      action: "create",
      name: "Replace",
      track_id: world.trackId,
    });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);
    await run(world.repo, "team_join", { team: teamId, seat: "lead", agent_id: "old-lead" });
    const second = await run(world.repo, "team_join", {
      team: teamId,
      seat: "lead",
      agent_id: "new-lead",
    });
    // Exclusive seat: the previous binding is recorded, not silently dropped.
    expect(second["superseded"]).toEqual(["old-lead"]);

    const resolved = await run(world.repo, "team_resolve", { seat: "lead" });
    expect(resolved["status"]).toBe("live");
    expect(resolved["agent_id"]).toBe("new-lead");

    const rows = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT agent_id, ended_at, end_reason FROM seat_sessions WHERE team_id=? AND seat='lead' ORDER BY started_at, agent_id",
      teamId,
    );
    expect(rows).toHaveLength(2);
    const ended = rows.filter((r) => r["ended_at"] !== null);
    expect(ended).toHaveLength(1);
    expect(ended[0]!["agent_id"]).toBe("old-lead");
    expect(ended[0]!["end_reason"]).toBe("replaced");
  });

  it("asks for a team instead of guessing when a seat name spans two teams", async () => {
    const world = await makeWorld();
    const a = await run(world.repo, "team", {
      action: "create",
      name: "A",
      track_id: world.trackId,
    });
    const b = await run(world.repo, "team", {
      action: "create",
      name: "B",
      track_id: world.trackId,
    });
    const aId = String((a["team"] as Record<string, unknown>)["id"]);
    const bId = String((b["team"] as Record<string, unknown>)["id"]);
    await run(world.repo, "team_join", { team: aId, seat: "lead", agent_id: "agent-a" });
    await run(world.repo, "team_join", { team: bId, seat: "lead", agent_id: "agent-b" });

    const ambiguous = await run(world.repo, "team_resolve", { seat: "lead" });
    expect(ambiguous["ok"]).toBe(false);
    expect(String(ambiguous["error"])).toBe(
      `seat lead is held on more than one team: ${aId}, ${bId}`,
    );
    expect(ambiguous["hint"]).toBe("pass team to disambiguate");

    const disambiguated = await run(world.repo, "team_resolve", { seat: "lead", team: bId });
    expect(disambiguated["status"]).toBe("live");
    expect(disambiguated["agent_id"]).toBe("agent-b");
  });

  it("with no team and no holder it refuses to invent one", async () => {
    const world = await makeWorld();
    const res = await run(world.repo, "team_resolve", { seat: "lead" });
    expect(res["ok"]).toBe(false);
    expect(res["error"]).toBe("seat lead is not held on any team");
    expect(res["hint"]).toBe("pass team to resolve a vacant seat");
  });
});

// ---------------------------------------------------------------------------

describe("first-mate vs pooled worker seats (#70 G4 / 'first-mate: Leader, Architect')", () => {
  it("only lead and architect are first-mate", () => {
    expect([...FIRST_MATE_SEATS]).toEqual(["lead", "architect"]);
    expect(isFirstMateSeat("lead")).toBe(true);
    expect(isFirstMateSeat("architect")).toBe(true);
    for (const seat of ["dev", "qa", "devops", "review", "lead-2", "architect-2", "LEAD"]) {
      expect(isFirstMateSeat(seat), seat).toBe(false);
    }
  });

  it("a non-first-mate seat is NOT refused: it pools several live agents", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", {
      action: "create",
      name: "Pool",
      track_id: world.trackId,
    });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);

    const first = await run(world.repo, "team_join", {
      team: teamId,
      seat: "dev",
      agent_id: "dev-1",
    });
    const second = await run(world.repo, "team_join", {
      team: teamId,
      seat: "dev",
      agent_id: "dev-2",
    });
    // Pooled: joining never evicts, and first_mate stays false.
    expect(first["ok"]).toBe(true);
    expect(first["first_mate"]).toBe(false);
    expect(first["occupancy"]).toBe("pooled");
    expect(first["superseded"]).toEqual([]);
    expect(second["ok"]).toBe(true);
    expect(second["superseded"]).toEqual([]);

    // Both hold the seat at once.
    const live = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT agent_id FROM seat_sessions WHERE team_id=? AND seat='dev' AND ended_at IS NULL ORDER BY started_at, agent_id",
      teamId,
    );
    expect(live.map((r) => r["agent_id"])).toEqual(["dev-1", "dev-2"]);

    const roster = await run(world.repo, "team", { action: "roster", team: teamId });
    const dev = (roster["seats"] as Record<string, unknown>[]).find((s) => s["seat"] === "dev")!;
    expect(dev["live"]).toEqual(["dev-1", "dev-2"]);
    expect(dev["agent_ids"]).toEqual(["dev-1", "dev-2"]);
    expect(dev["first_mate"]).toBe(false);
  });

  it("a first-mate seat holds exactly one agent; a worker seat holds many", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", { action: "create", name: "Cardinality" });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);
    for (const agent of ["a1", "a2"]) {
      await run(world.repo, "team_join", { team: teamId, seat: "architect", agent_id: agent });
    }
    for (const agent of ["w1", "w2", "w3"]) {
      await run(world.repo, "team_join", { team: teamId, seat: "qa", agent_id: agent });
    }
    const rows = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT seat, COUNT(*) AS n FROM seat_sessions WHERE team_id=? AND ended_at IS NULL GROUP BY seat ORDER BY seat",
      teamId,
    );
    expect(rows).toEqual([
      { seat: "architect", n: 1 },
      { seat: "qa", n: 3 },
    ]);
  });

  it("resolving a pooled seat names one agent and reports the whole pool", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", {
      action: "create",
      name: "Pool Resolve",
      track_id: world.trackId,
    });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);
    await run(world.repo, "team_join", { team: teamId, seat: "devops", agent_id: "ops-1" });
    await run(world.repo, "team_join", { team: teamId, seat: "devops", agent_id: "ops-2" });

    const resolved = await run(world.repo, "team_resolve", { seat: "devops", team: teamId });
    expect(resolved["status"]).toBe("live");
    expect(resolved["first_mate"]).toBe(false);
    expect(resolved["agent_id"]).toBe("ops-1");
    expect(resolved["pool"]).toEqual([
      { team_id: teamId, agent_id: "ops-1", seat: "devops" },
      { team_id: teamId, agent_id: "ops-2", seat: "devops" },
    ]);
  });

  it("an unknown seat is refused with the team's seat list", async () => {
    const world = await makeWorld();
    const created = await run(world.repo, "team", { action: "create", name: "Seats" });
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);
    const res = await run(world.repo, "team_join", {
      team: teamId,
      seat: "beast",
      agent_id: "a",
    });
    expect(res["ok"]).toBe(false);
    expect(res["error"]).toBe(`seat not found on team ${teamId}: beast`);
    expect(String(res["hint"])).toContain("architect");
  });
});

// ---------------------------------------------------------------------------

describe("import discipline (the src/mcp.ts rule)", () => {
  it("importing the team domain touches nothing: no store, no fs, no handlers", async () => {
    const before = process.env["MCP_ORCH_SUMMARY_PATH"];
    const module = await import("../../src/tools/team.js");
    // A pure declaration: reading the module must not have opened a database,
    // read a summary, or installed a process handler.
    expect(module.TEAM_DOMAIN.namespace).toBe("team");
    expect(module.TEAM_DOMAIN.tools.map((t) => t.name)).toEqual([
      "team",
      "team_join",
      "team_resolve",
    ]);
    expect(process.env["MCP_ORCH_SUMMARY_PATH"]).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(0);
    expect(process.listenerCount("exit")).toBe(0);
    // Every tool is data + a pure function, so running one needs a store
    // handed in explicitly rather than a module-level connection.
    expect(typeof tool("team").run).toBe("function");
  });
});

describe("registration through the T0 seam", () => {
  it("all three tools resolve and run through the PRODUCTION resolution path", async () => {
    // Proof the single registration line (TOOL_DOMAINS) is load-bearing: these
    // names are dispatched by runTool, not by calling TEAM_DOMAIN directly.
    const { resolveTool, runTool } = await import("../../src/tools/registry.js");
    const world = await makeWorld();

    for (const name of ["team", "team_join", "team_resolve"]) {
      const spec = resolveTool(name);
      expect(spec, name).toBeDefined();
      expect(spec?.description, name).toBeTypeOf("string");
      expect(spec?.inputSchema, name).toMatchObject({ type: "object" });
    }
    // The 26 base tools are untouched and still resolve ahead of the domain.
    expect(resolveTool("track_status")).toBeDefined();
    expect(resolveTool("not_a_tool")).toBeUndefined();

    const created = (await runTool(world.repo, "team", {
      action: "create",
      name: "Seam",
    })) as Record<string, unknown>;
    expect(created["ok"]).toBe(true);
    const teamId = String((created["team"] as Record<string, unknown>)["id"]);
    const joined = (await runTool(world.repo, "team_join", {
      team: teamId,
      seat: "lead",
      agent_id: "agent-via-seam",
    })) as Record<string, unknown>;
    expect(joined["ok"]).toBe(true);
    const resolved = (await runTool(world.repo, "team_resolve", { seat: "lead" })) as Record<
      string,
      unknown
    >;
    expect(resolved["status"]).toBe("live");
    expect(resolved["agent_id"]).toBe("agent-via-seam");
  });
});
