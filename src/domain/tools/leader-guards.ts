/**
 * Guard + collector-track helpers — port of leader.py refuse_* and
 * collector.py (ensure_collector_track, is_system_track, system_track_ids).
 */
import {
  COLLECTOR_TRACK_EPIC,
  COLLECTOR_TRACK_GOAL,
  SYSTEM_PROJECT_NAME,
  SYSTEM_PROJECT_SLUG,
  pyRepr,
  utcnowIso,
} from "../models.js";
import { StateError, type Store, type Track } from "../../store/store-interface.js";

export async function systemProject(store: Store): Promise<{ id: string } | null> {
  return store.findSystemProject(SYSTEM_PROJECT_SLUG);
}

export function isSystemTrackSync(projectId: string, systemId: string | null): boolean {
  return systemId !== null && projectId === systemId;
}

export async function isSystemTrack(store: Store, track: Track | null): Promise<boolean> {
  if (!track) return false;
  const project = await systemProject(store);
  return project !== null && track.project_id === project.id;
}

export async function systemTrackIds(store: Store, tracks: Track[]): Promise<Set<string>> {
  const project = await systemProject(store);
  if (!project) return new Set();
  return new Set(tracks.filter((t) => t.project_id === project.id).map((t) => t.id));
}

export async function refuseOrchestratorWrite(
  store: Store,
  trackId: string,
  tool: string,
): Promise<Record<string, unknown> | null> {
  let track: Track;
  try {
    track = await store.getTrack(trackId);
  } catch (exc) {
    return {
      ok: false,
      error: `track not found: ${trackId}: ${(exc as Error).message}`,
      hint: "verify track_id",
    };
  }
  if (await isSystemTrack(store, track)) return null;
  return {
    ok: false,
    error: `${tool}(role='orchestrator') may not write to track ${trackId}`,
    hint:
      "omit track_id: the server records the collector's generation on " +
      "its own system collector track. Writing into a leader's track " +
      "would inflate its turn_count and corrupt its staleness signal.",
  };
}

export async function refuseSystemTrackWrite(
  store: Store,
  trackId: string,
  tool: string,
): Promise<Record<string, unknown> | null> {
  let track: Track;
  try {
    track = await store.getTrack(trackId);
  } catch (exc) {
    return {
      ok: false,
      error: `track not found: ${trackId}: ${(exc as Error).message}`,
      hint: "verify track_id",
    };
  }
  if (!(await isSystemTrack(store, track))) return null;
  return {
    ok: false,
    error: `${tool} is not available on the system collector track`,
    hint:
      "that track is the ORCHESTRATOR's own state (heartbeat binding " +
      "and wake count), not a unit of work: it has no leader, no queue " +
      "and no PR. Use your own track.",
  };
}

export const ENSURE_LOCK = "collector-track";

export async function ensureCollectorTrack(store: Store): Promise<Track> {
  let project = await systemProject(store);
  if (!project) {
    refuseSlugCollision(await store.findProjectBySlug(SYSTEM_PROJECT_SLUG));
    project = await store.lock(ENSURE_LOCK, async () => {
      const reread = await systemProject(store);
      if (reread) return reread;
      refuseSlugCollision(await store.findProjectBySlug(SYSTEM_PROJECT_SLUG));
      return store.createProject(SYSTEM_PROJECT_NAME, [], "omp", true);
    });
  }
  for (const track of await store.listTracks(project.id)) {
    if (track.epic === COLLECTOR_TRACK_EPIC) return track;
  }
  return store.lock(ENSURE_LOCK, async () => {
    for (const track of await store.listTracks(project.id)) {
      if (track.epic === COLLECTOR_TRACK_EPIC) return track;
    }
    const track = await store.createTrack(project.id, COLLECTOR_TRACK_EPIC, COLLECTOR_TRACK_GOAL);
    await store.appendEvent(
      {
        ts: utcnowIso(),
        type: "collector_track_created",
        project_id: project.id,
        track_id: track.id,
        payload: { reason: "heartbeat(role=orchestrator) omitted track_id", epic: track.epic },
      },
      project.id,
    );
    return track;
  });
}

function refuseSlugCollision(squatter: { id: string; name: string } | null): void {
  if (!squatter) return;
  throw new StateError(
    `project slug ${pyRepr(SYSTEM_PROJECT_SLUG)} is held by project ` +
      `${pyRepr(squatter.id)} (${pyRepr(squatter.name)}), which is not the system project, ` +
      "so the collector will not adopt it. Rename or archive that project — " +
      "the name is reserved for the ORCHESTRATOR's own state.",
  );
}
