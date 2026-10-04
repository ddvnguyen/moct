/**
 * Team domain tools — LLM-Agents-Orchestration#70 (Team Room MVP), Lane T.
 *
 * Registered through the T0 per-domain seam (src/tools/registry.ts); this file
 * deliberately does NOT touch src/surfaces/mcp/dispatch.ts. Two sibling agents
 * own that switch.
 *
 * Core principle (#70): the SEAT (position) is the identity. Sessions, models
 * and Paseo agent ids are disposable and attach to a seat, so memory and
 * authorship key on `seat` rather than on an agent id.
 *
 * The bootstrap packet composes FOUR existing contracts and nothing else:
 *   summary_read(action="spec")      -> track summary
 *   track_status                     -> live track state
 *   orchestration://project/{id}/summary -> project summary (MCP resource)
 *   leader_handoff(action="pack")    -> leader handoff pack
 * NO memory blocks (owner freeze 2026-10-04): every block carries the `source`
 * that produced it, so a reader can always tell which contract to re-run.
 *
 * Import discipline (mirrors src/mcp.ts): importing this module must have no
 * side effects. Everything below is a pure declaration; nothing here opens a
 * database, reads a file at module scope, or registers a process handler.
 */
import { readFileSync, statSync } from "node:fs";
import { estimateTokens, summaryPath } from "../domain/config.js";
import { newId, pyRepr, utcnowIso } from "../domain/models.js";
import { leaderHandoff } from "../domain/tools/leader.js";
import { trackStatus } from "../domain/tools/reporting.js";
import { summaryRead } from "../domain/tools/summary.js";
import type { SeatRow, SeatSessionRow, Store, TeamRow } from "../store/store-interface.js";
import type { ToolDomain, ToolSpec } from "./registry.js";

/**
 * First-mate seats (#70: "first-mate position: Leader, Architect"). Only these
 * two may answer in the room. Derived, never caller-supplied — a caller cannot
 * promote itself to first-mate by passing a flag.
 */
export const FIRST_MATE_SEATS: readonly string[] = ["lead", "architect"];

/** Default roster at team create: both first-mates plus the pooled workers. */
export const DEFAULT_SEATS: readonly string[] = ["lead", "architect", "dev", "qa", "devops"];

/**
 * Seat -> fleet position. `role` is the seat's own name for worker seats;
 * `tier` is the fleet.json tool tier. fleet.json has no architect/qa/devops
 * positions (#70 gap 8), so architect maps onto the consult tier — the mapping
 * #70 recorded for the architect seat — and the worker seats share `dev`.
 * Deliberately local: extending fleet.json's POSITION_TIER is a fleet-model
 * change, not a team-domain one.
 */
const SEAT_ROLE: Record<string, string> = {
  lead: "leader",
  architect: "architect",
  dev: "dev",
  qa: "qa",
  devops: "devops",
};

const SEAT_TIER: Record<string, string> = {
  lead: "leader",
  architect: "consult",
  dev: "dev",
  qa: "dev",
  devops: "dev",
};

export function isFirstMateSeat(seat: string): boolean {
  return FIRST_MATE_SEATS.includes(seat);
}

/** The four packet contracts, named so a block and its source cannot drift. */
export const PACKET_SOURCES = {
  trackSummary: "summary_read",
  trackStatus: "track_status",
  projectSummary: "orchestration://project/{project_id}/summary",
  leaderHandoff: "leader_handoff",
} as const;

// ---------------------------------------------------------------------------
// Argument reading — every accessor is total: a missing/blank argument yields
// the default rather than undefined leaking into a query.
// ---------------------------------------------------------------------------

function str(args: Record<string, unknown>, key: string, dflt = ""): string {
  const v = args[key];
  if (v === null || v === undefined) return dflt;
  const s = String(v).trim();
  return s === "" ? dflt : s;
}

function list(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  return v.map((item) => String(item).trim()).filter((item) => item !== "");
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

function buildSeat(teamId: string, seat: string): SeatRow {
  return {
    team_id: teamId,
    seat,
    role: SEAT_ROLE[seat] ?? seat,
    tier: SEAT_TIER[seat] ?? "dev",
    first_mate: isFirstMateSeat(seat) ? 1 : 0,
    persona_md: "",
  };
}

/**
 * One seat with its live occupancy, as the roster reports it.
 * `first_mate` comes from the row (derived at create time) and is echoed as a
 * boolean so callers never have to read a SQLite integer flag.
 */
interface SeatView extends Record<string, unknown> {
  seat: string;
  first_mate: boolean;
  live: string[];
}

/**
 * The one roster order every mode uses: first-mates in owner-facing order,
 * then the pooled worker seats. #70's default room view is the first-mates, so
 * they lead the roster rather than sorting in among the workers.
 */
function orderSeats(seats: SeatRow[]): SeatRow[] {
  const rank = (seat: string): number => {
    const idx = FIRST_MATE_SEATS.indexOf(seat);
    return idx === -1 ? FIRST_MATE_SEATS.length + 1 : idx;
  };
  return [...seats].sort((a, b) => rank(a.seat) - rank(b.seat) || a.seat.localeCompare(b.seat));
}

function seatView(seat: SeatRow, live: SeatSessionRow[]): SeatView {
  const firstMate = isFirstMateSeat(seat.seat);
  const agents = live.filter((s) => s.seat === seat.seat).map((s) => s.agent_id);
  return {
    seat: seat.seat,
    role: seat.role,
    tier: seat.tier,
    first_mate: firstMate,
    // A first-mate seat is one identity (at most one live agent); a pooled
    // worker seat may hold many concurrent agents (#70 G4).
    occupancy: firstMate ? "exclusive" : "pooled",
    live: agents,
    agent_id: firstMate ? (agents[0] ?? null) : null,
    agent_ids: agents,
    persona_md: seat.persona_md,
  };
}

function unknownTeam(teamId: string): Record<string, unknown> {
  return {
    ok: false,
    error: `team not found: ${teamId}`,
    hint: "list teams or create one first with team(action=create)",
  };
}

function unknownSeat(team: string, seat: string, known: string[]): Record<string, unknown> {
  return {
    ok: false,
    error: `seat not found on team ${team}: ${seat}`,
    hint: `seats on this team: ${known.join(", ") || "(none)"}`,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap packet
// ---------------------------------------------------------------------------

/**
 * The orchestration://project/{pid}/summary MCP resource, ported to the TS
 * surface. Python's resources.py read_project_summary is the contract: validate
 * the project, then return summary.md's text plus meta. Kept local because the
 * resources surface lands in M2; the packet needs it now.
 */
async function readProjectSummary(
  store: Store,
  projectId: string,
): Promise<Record<string, unknown>> {
  const uri = `orchestration://project/${projectId}/summary`;
  try {
    await store.getProject(projectId);
  } catch (exc) {
    return {
      ok: false,
      error: `project not found: ${projectId}: ${(exc as Error).message}`,
      hint: "list projects via track_list or check pid",
    };
  }
  const mdPath = summaryPath();
  const meta: Record<string, unknown> = { project_id: projectId, path: mdPath, uri };
  let text: string;
  try {
    text = readFileSync(mdPath, "utf-8");
    meta["size"] = statSync(mdPath).size;
  } catch (exc) {
    return {
      ok: false,
      error: `summary not found at ${mdPath}: ${(exc as Error).message}`,
      hint: "run validate_and_commit first",
      meta,
      uri,
    };
  }
  meta["tokens_estimate"] = estimateTokens(text);
  return { ok: true, uri, mimeType: "text/markdown", text, meta };
}

/**
 * Compose the seat bootstrap packet from the four existing contracts.
 *
 * Every block is `{source, ok, ...}` so a reader can trace any block back to the
 * contract that produced it, and a failing contract degrades its own block
 * instead of killing the packet — a seat with no track still needs to know it
 * has none. There are exactly four blocks and no memory blocks (owner freeze).
 */
async function buildBootstrapPacket(
  store: Store,
  team: TeamRow,
  seat: string,
): Promise<Record<string, unknown>> {
  const trackIds = await store.listTeamTracks(team.id);
  const trackId = trackIds[0] ?? "";
  const trackList = trackIds.map((id) => ({ track_id: id, primary: id === trackId }));

  let projectId = "";
  if (trackId) {
    try {
      projectId = (await store.getTrack(trackId)).project_id;
    } catch {
      projectId = "";
    }
  }

  const noTrack = {
    ok: false,
    error: `team ${team.id} has no tracks attached`,
    hint: "attach one with team(action=create, track_id=...) on a later team",
  };

  const blocks: Record<string, Record<string, unknown>> = {
    track_summary: trackId ? await summaryRead(store, trackId, "spec", "") : { ...noTrack },
    track_status: trackId
      ? await trackStatus(store, trackId, 0, "", "", "", 0, 0, 0)
      : { ...noTrack },
    project_summary: projectId
      ? await readProjectSummary(store, projectId)
      : {
          ok: false,
          error: `team ${team.id} has no track, so its project is unknown`,
          hint: "attach a track to the team",
          uri: "",
        },
    leader_handoff: trackId
      ? await leaderHandoff(store, trackId, "pack", "", "", "dev", 6000)
      : { ...noTrack },
  };
  for (const [name, block] of Object.entries(blocks)) {
    blocks[name] = { ...block, source: sourceForBlock(name, trackId, projectId) };
  }

  return {
    ok: true,
    team: { id: team.id, name: team.name, mission: team.mission },
    seat,
    first_mate: isFirstMateSeat(seat),
    track_id: trackId,
    project_id: projectId,
    tracks: trackList,
    generated_at: utcnowIso(),
    blocks,
  };
}

/** The contract that produced a block, in that block's own `source` field. */
function sourceForBlock(name: string, trackId: string, projectId: string): string {
  switch (name) {
    case "track_summary":
      return `${PACKET_SOURCES.trackSummary}(track_id=${trackId}, action=spec)`;
    case "track_status":
      return `${PACKET_SOURCES.trackStatus}(track_id=${trackId})`;
    case "project_summary":
      return `${PACKET_SOURCES.projectSummary.replace("{project_id}", projectId)}`;
    case "leader_handoff":
      return `${PACKET_SOURCES.leaderHandoff}(track_id=${trackId}, action=pack)`;
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * team(action=create) — a long-lived team above tracks, with its seat roster.
 * Seats default to both first-mates plus the pooled workers; `seats` overrides
 * the list but can never change who is first-mate.
 */
async function teamCreate(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const name = str(args, "name");
  if (!name) {
    return { ok: false, error: "name must be a non-empty string", hint: "provide a team name" };
  }
  const mission = str(args, "mission");
  const trackId = str(args, "track_id");
  const requested = list(args, "seats");
  const seatNames = requested.length ? requested : [...DEFAULT_SEATS];
  const dupes = seatNames.filter((s, i) => seatNames.indexOf(s) !== i);
  if (dupes.length) {
    return {
      ok: false,
      error: `duplicate seats: ${[...new Set(dupes)].join(", ")}`,
      hint: "each seat name must be unique within a team",
    };
  }
  if (trackId) {
    // Fail fast on a bad track_id instead of tripping the FK at insert time.
    try {
      await store.getTrack(trackId);
    } catch (exc) {
      return {
        ok: false,
        error: `track not found: ${trackId}: ${(exc as Error).message}`,
        hint: "verify track_id",
      };
    }
  }

  const team: TeamRow = {
    id: str(args, "team", "") || newId("team"),
    name,
    mission,
    created_at: utcnowIso(),
  };
  const seats = seatNames.map((seat) => buildSeat(team.id, seat));
  try {
    await store.createTeam(team, seats);
    if (trackId) await store.addTeamTrack(team.id, trackId);
  } catch (exc) {
    return { ok: false, error: (exc as Error).message, hint: "team create failed" };
  }
  return {
    ok: true,
    team,
    seats: orderSeats(seats).map((s) => seatView(s, [])),
    tracks: trackId ? [{ track_id: trackId, primary: true }] : [],
  };
}

/** team(action=get) — the team, its tracks and its seats in one read. */
async function teamGet(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const teamId = str(args, "team") || str(args, "team_id");
  const team = await store.getTeam(teamId);
  if (!team) return unknownTeam(teamId);
  const [seats, live, trackIds] = await Promise.all([
    store.listSeats(team.id),
    store.listLiveSeatSessions(team.id),
    store.listTeamTracks(team.id),
  ]);
  return {
    ok: true,
    team,
    tracks: trackIds.map((id, i) => ({ track_id: id, primary: i === 0 })),
    seats: orderSeats(seats).map((s) => seatView(s, live)),
    first_mates: orderSeats(seats)
      .filter((s) => isFirstMateSeat(s.seat))
      .map((s) => s.seat),
  };
}

/** team(action=roster) — seats only, with live occupancy per seat. */
async function teamRoster(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const teamId = str(args, "team") || str(args, "team_id");
  const team = await store.getTeam(teamId);
  if (!team) return unknownTeam(teamId);
  const [seats, live] = await Promise.all([
    store.listSeats(team.id),
    store.listLiveSeatSessions(team.id),
  ]);
  return {
    ok: true,
    team: { id: team.id, name: team.name },
    seats: orderSeats(seats).map((s) => seatView(s, live)),
    first_mates: orderSeats(seats)
      .filter((s) => isFirstMateSeat(s.seat))
      .map((s) => s.seat),
  };
}

/**
 * team_join(team, seat, agent_id) — attach an agent to a seat and hand it the
 * bootstrap packet.
 *
 * A first-mate seat is exclusive: joining supersedes the previous binding
 * (recorded as end_reason='replaced'). A pooled worker seat is not, so several
 * workers can hold `dev` at once (#70 G4) — join never refuses a pooled seat.
 */
async function teamJoin(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const teamId = str(args, "team") || str(args, "team_id");
  const seat = str(args, "seat");
  const agentId = str(args, "agent_id");
  if (!teamId) return { ok: false, error: "team is required", hint: "pass the team id" };
  if (!seat) return { ok: false, error: "seat is required", hint: "pass a seat name" };
  if (!agentId) {
    return { ok: false, error: "agent_id is required", hint: "pass the joining agent id" };
  }
  const team = await store.getTeam(teamId);
  if (!team) return unknownTeam(teamId);
  const seatRow = await store.getSeat(team.id, seat);
  if (!seatRow) {
    const known = (await store.listSeats(team.id)).map((s) => s.seat);
    return unknownSeat(team.id, seat, known);
  }

  const firstMate = isFirstMateSeat(seatRow.seat);
  const before = firstMate ? await store.listLiveSeatSessions(team.id) : [];
  const superseded = firstMate
    ? before.filter((s) => s.seat === seatRow.seat).map((s) => s.agent_id)
    : [];

  await store.startSeatSession(
    {
      team_id: team.id,
      seat: seatRow.seat,
      agent_id: agentId,
      model: str(args, "model"),
      started_at: utcnowIso(),
      ended_at: null,
      end_reason: "",
    },
    firstMate,
  );

  return {
    ok: true,
    team: { id: team.id, name: team.name },
    seat: seatRow.seat,
    first_mate: firstMate,
    occupancy: firstMate ? "exclusive" : "pooled",
    agent_id: agentId,
    // Only a first-mate seat evicts; a pooled seat adds to the pool.
    superseded,
    packet: await buildBootstrapPacket(store, team, seatRow.seat),
  };
}

/**
 * team_resolve(seat) — who holds this seat?
 *
 * Live -> the agent_id holding it. Vacant -> vacant plus the bootstrap packet,
 * so a fresh agent can join knowing everything. `team` is an optional
 * disambiguator: a seat name is only unique WITHIN a team, and guessing between
 * two teams would be worse than asking. With no `team` the seat is resolved from
 * whoever holds it; with no holder and no `team` there is nothing to resolve
 * against, so the tool says so instead of inventing a team.
 *
 * A pooled worker seat can hold several live agents; resolution is
 * deterministic (oldest live session first — the agent that has held the seat
 * longest) and the full pool is returned alongside.
 */
async function teamResolve(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const seat = str(args, "seat");
  if (!seat) return { ok: false, error: "seat is required", hint: "pass a seat name" };
  const teamFilter = str(args, "team") || str(args, "team_id");
  const firstMate = isFirstMateSeat(seat);

  let team: TeamRow | null;
  let candidates: SeatSessionRow[];
  if (teamFilter) {
    team = await store.getTeam(teamFilter);
    if (!team) return unknownTeam(teamFilter);
    const seatRow = await store.getSeat(team.id, seat);
    if (!seatRow)
      return unknownSeat(
        team.id,
        seat,
        (await store.listSeats(team.id)).map((s) => s.seat),
      );
    candidates = (await store.listLiveSeatSessions(team.id)).filter((s) => s.seat === seatRow.seat);
  } else {
    const live = await store.listLiveSeatSessionsForSeat(seat);
    const teams = [...new Set(live.map((s) => s.team_id))];
    if (teams.length > 1) {
      return {
        ok: false,
        error: `seat ${seat} is held on more than one team: ${teams.join(", ")}`,
        hint: "pass team to disambiguate",
        teams,
      };
    }
    if (teams.length === 0) {
      return {
        ok: false,
        error: `seat ${seat} is not held on any team`,
        hint: "pass team to resolve a vacant seat",
        teams: [],
      };
    }
    team = await store.getTeam(teams[0]!);
    candidates = live.filter((s) => s.team_id === teams[0]);
  }
  if (!team) return unknownTeam(teamFilter);

  const held = candidates[0] ?? null;
  if (!held) {
    return {
      ok: true,
      status: "vacant",
      team: { id: team.id, name: team.name },
      seat,
      first_mate: firstMate,
      agent_id: null,
      packet: await buildBootstrapPacket(store, team, seat),
    };
  }
  return {
    ok: true,
    status: "live",
    team: { id: team.id, name: team.name },
    seat,
    first_mate: firstMate,
    agent_id: held.agent_id,
    model: held.model,
    started_at: held.started_at,
    // agent_id above is the single holder of an exclusive seat, or the
    // longest-held agent of a pooled one; `pool` is the full set of holders.
    pool: candidates.map((s) => ({ team_id: s.team_id, agent_id: s.agent_id, seat: s.seat })),
  };
}

// ---------------------------------------------------------------------------
// Tool specs
// ---------------------------------------------------------------------------

const teamSpec: ToolSpec = {
  name: "team",
  description:
    "Team domain (#70): create/get/roster a team and its seats. action=create takes name " +
    "(required), mission, track_id and seats; action=get/roster take team. Only the lead and " +
    "architect seats are first-mate; every other seat is a pooled worker seat.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "get", "roster"], default: "get" },
      team: { type: "string", description: "team id (get/roster)" },
      team_id: { type: "string", description: "alias for team" },
      name: { type: "string", description: "team name (create)" },
      mission: { type: "string", description: "what the team is for (create)" },
      track_id: { type: "string", description: "track to attach (create)" },
      seats: { type: "array", items: { type: "string" }, description: "seat names (create)" },
    },
    required: ["action"],
  },
  run: async (store, args) => {
    const action = str(args, "action", "get");
    if (action === "create") return teamCreate(store, args);
    if (action === "get") return teamGet(store, args);
    if (action === "roster") return teamRoster(store, args);
    return {
      ok: false,
      error: `invalid action ${pyRepr(action)}`,
      hint: "must be one of: create, get, roster",
    };
  },
};

const teamJoinSpec: ToolSpec = {
  name: "team_join",
  description:
    "Attach an agent to a team seat and return its bootstrap packet (track summary, track " +
    "status, project summary, leader handoff pack — each block tagged with its source). A " +
    "first-mate seat (lead, architect) is exclusive and supersedes its previous binding; a " +
    "pooled worker seat adds to the pool.",
  inputSchema: {
    type: "object",
    properties: {
      team: { type: "string", description: "team id" },
      team_id: { type: "string", description: "alias for team" },
      seat: { type: "string", description: "seat name" },
      agent_id: { type: "string", description: "agent taking the seat" },
      model: { type: "string", description: "model the agent is running" },
    },
    required: ["team", "seat", "agent_id"],
  },
  run: teamJoin,
};

const teamResolveSpec: ToolSpec = {
  name: "team_resolve",
  description:
    "Resolve a seat: returns status=live with the agent_id holding it, or status=vacant plus " +
    "the bootstrap packet. Pass team to disambiguate a seat name held on several teams.",
  inputSchema: {
    type: "object",
    properties: {
      seat: { type: "string", description: "seat name" },
      team: { type: "string", description: "optional team id disambiguator" },
      team_id: { type: "string", description: "alias for team" },
    },
    required: ["seat"],
  },
  run: teamResolve,
};

export const TEAM_DOMAIN: ToolDomain = {
  namespace: "team",
  tools: [teamSpec, teamJoinSpec, teamResolveSpec],
};
