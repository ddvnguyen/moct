/** Where the host half answers the island's boot questions. */
export const ISLAND_CONFIG_PATH = "/multica/config";

/** The API surface the island reaches: the host's proxy, never multica-be. */
export const ISLAND_API_BASE = "/multica";

/**
 * The account-level unread summary behind the rail's inbox dot.
 *
 * One constant built from `ISLAND_API_BASE` so the poller and the island's own
 * client cannot drift onto different paths.
 */
export const UNREAD_SUMMARY_PATH = `${ISLAND_API_BASE}/api/inbox/unread-summary`;

export interface IslandConfig {
  /** Same-origin path of the realtime channel. */
  wsPath: string;
  /** Workspace the panel opens; empty selects the first readable one. */
  workspaceSlug: string;
  /** Why the host cannot proxy, when it cannot. Never a credential. */
  problem: string | null;
}

export const DEFAULT_ISLAND_CONFIG: IslandConfig = {
  wsPath: "/multica/ws",
  workspaceSlug: "",
  problem: null,
};

/**
 * Read the host's boot config.
 *
 * The host owns the workspace choice and the WebSocket path, and neither is a
 * secret; the token is deliberately absent from this payload.
 */
export async function loadIslandConfig(
  fetchImpl: typeof fetch = fetch,
): Promise<IslandConfig> {
  const response = await fetchImpl(ISLAND_CONFIG_PATH, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`island config responded ${response.status}`);
  }
  const body = (await response.json()) as Partial<IslandConfig> | null;
  return {
    wsPath:
      typeof body?.wsPath === "string" && body.wsPath.startsWith("/")
        ? body.wsPath
        : DEFAULT_ISLAND_CONFIG.wsPath,
    workspaceSlug:
      typeof body?.workspaceSlug === "string" ? body.workspaceSlug : "",
    problem: typeof body?.problem === "string" ? body.problem : null,
  };
}

let cachedConfig: Promise<IslandConfig> | null = null;

/**
 * The host's boot config, read once per page.
 *
 * Two callers want it and neither can wait for the other: the island's boot
 * gate, which decides which workspace the panel speaks as, and the rail dot's
 * poller, which runs from `apply` before any island exists. One shared promise
 * means one `/multica/config` request on load instead of two.
 *
 * A failed read is not cached: the next caller tries again, so a host that was
 * still starting up when the shell booted is picked up by the next poll.
 */
export function islandConfig(): Promise<IslandConfig> {
  cachedConfig ??= loadIslandConfig().catch((cause: unknown) => {
    cachedConfig = null;
    throw cause;
  });
  return cachedConfig;
}

/** Drop the cached read so the next caller fetches again. Tests only. */
export function resetIslandConfig(): void {
  cachedConfig = null;
}

/** Absolute WebSocket URL for a same-origin path. */
export function islandWebSocketUrl(wsPath: string, location: Location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${wsPath}`;
}
