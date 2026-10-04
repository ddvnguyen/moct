/**
 * Store interface — every domain/tools module codes against this, never
 * against the Turso driver. store/turso-repository.ts is the ONLY file in
 * this package importing @tursodatabase/database (CI-gated).
 */
import type {
  Decision,
  FleetEvent,
  Project,
  QueueItem,
  SuggestionRecord,
  ModelEvaluation,
  Telemetry,
  Track,
  TurnDelta,
  WorkerEvaluation,
  WorkerRecord,
} from "../domain/models.js";

export class StateError extends Error {}

export interface RowFilter {
  types: Set<string> | null;
  trackIds: Set<string> | null;
  includeNullTrack: boolean;
  since: string | null;
}

/**
 * Team domain rows (LLM-Agents-Orchestration#70). Shapes are the DDL columns
 * verbatim: `first_mate` is a SQLite boolean, `ended_at === null` is a live
 * seat session.
 */
export interface TeamRow {
  id: string;
  name: string;
  mission: string;
  created_at: string;
}

export interface SeatRow {
  team_id: string;
  seat: string;
  role: string;
  tier: string;
  first_mate: number;
  persona_md: string;
}

export interface SeatSessionRow {
  team_id: string;
  seat: string;
  agent_id: string;
  model: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string;
}

export function makeRowFilter(init?: Partial<RowFilter>): RowFilter {
  return {
    types: init?.types ?? null,
    trackIds: init?.trackIds ?? null,
    includeNullTrack: init?.includeNullTrack ?? false,
    since: init?.since ?? null,
  };
}

/** JSON-mode predicate shared by backends (store.RowFilter.matches verbatim). */
export function rowMatches(filter: RowFilter, row: Record<string, unknown>): boolean {
  if (filter.types !== null && !filter.types.has(row["type"] as string)) return false;
  if (filter.trackIds !== null) {
    const trackId = row["track_id"];
    if (!filter.trackIds.has(trackId as string) && !(filter.includeNullTrack && trackId === null))
      return false;
  }
  if (filter.since && ((row["ts"] as string) || "") < filter.since) return false;
  return true;
}

export interface Store {
  readonly root: string;
  /** Advisory exclusive critical section (serializes read-modify-write). */
  lock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Atomic JSON file write (used for sidecar files even in SQL mode). */
  writeJsonAtomic(filePath: string, data: unknown): Promise<void>;
  projectFile(projectId: string): string;

  // -- projects --
  createProject(
    name: string,
    repos?: Record<string, unknown>[] | string[] | null,
    harness?: string,
    system?: boolean,
  ): Promise<Project>;
  getProject(projectId: string): Promise<Project>;
  findProjectBySlug(slug: string): Promise<Project | null>;
  findSystemProject(slug: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  // -- tracks --
  createTrack(
    projectId: string,
    epic: string,
    goal: string,
    repo?: string,
    branch?: string,
  ): Promise<Track>;
  saveTrack(track: Track): Promise<void>;
  getTrack(trackId: string): Promise<Track>;
  listTracks(projectId?: string | null): Promise<Track[]>;

  // -- events / decisions / turns --
  appendEvent(event: FleetEvent, projectId: string): Promise<void>;
  readEvents(projectId: string): Promise<Record<string, unknown>[]>;
  appendDecision(decision: Decision, projectId: string): Promise<void>;
  readDecisions(projectId: string): Promise<Record<string, unknown>[]>;
  nextTurnNumber(projectId: string, trackId: string): Promise<number>;
  saveTurn(projectId: string, trackId: string, delta: TurnDelta): Promise<void>;
  readTurns(projectId: string, trackId: string): Promise<Record<string, unknown>[]>;
  tailEvents(
    projectId: string,
    limit: number,
    offset: number,
    filter: RowFilter | null,
  ): Promise<Record<string, unknown>[]>;
  tailDecisions(
    projectId: string,
    limit: number,
    offset: number,
    filter: RowFilter | null,
  ): Promise<Record<string, unknown>[]>;
  streamDecisions(projectId: string, filter: RowFilter | null): Promise<Record<string, unknown>[]>;
  resolveTurnNumberAt(projectId: string, trackId: string, since: string): Promise<number | null>;
  readTurnsPaged(
    projectId: string,
    trackId: string,
    limit: number,
    offset: number,
    since?: string | null,
  ): Promise<Record<string, unknown>[]>;
  eventsBytes(projectId: string): Promise<number>;
  decisionsBytes(projectId: string): Promise<number>;

  // -- suggestions / model evaluations --
  readSuggestions(projectId: string): Promise<Record<string, unknown>[]>;
  writeSuggestions(projectId: string, suggestions: Record<string, unknown>[]): Promise<void>;
  readModelEvaluations(projectId: string): Promise<Record<string, unknown>[]>;
  writeModelEvaluations(projectId: string, evaluations: Record<string, unknown>[]): Promise<void>;

  // -- team domain (#70) --
  /**
   * Insert a team and its seats in one transaction. The caller owns the
   * first_mate derivation; this layer never guesses it.
   */
  createTeam(team: TeamRow, seats: SeatRow[]): Promise<void>;
  getTeam(teamId: string): Promise<TeamRow | null>;
  listTeams(): Promise<TeamRow[]>;
  addTeamTrack(teamId: string, trackId: string): Promise<void>;
  listTeamTracks(teamId: string): Promise<string[]>;
  listSeats(teamId: string): Promise<SeatRow[]>;
  getSeat(teamId: string, seat: string): Promise<SeatRow | null>;
  /**
   * Record a seat session and close any live session it supersedes.
   * `exclusiveSeats` decides the cardinality: a first-mate seat holds at most
   * one live row, a pooled worker seat may hold many (#70 G4).
   */
  startSeatSession(session: SeatSessionRow, exclusive: boolean): Promise<void>;
  listLiveSeatSessions(teamId: string): Promise<SeatSessionRow[]>;
  listLiveSeatSessionsForSeat(seat: string): Promise<SeatSessionRow[]>;
}

export type {
  Decision,
  FleetEvent,
  Project,
  QueueItem,
  SuggestionRecord,
  ModelEvaluation,
  Telemetry,
  Track,
  TurnDelta,
  WorkerEvaluation,
  WorkerRecord,
};
