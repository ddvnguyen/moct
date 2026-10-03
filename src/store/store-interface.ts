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
