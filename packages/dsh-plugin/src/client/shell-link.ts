/**
 * Resolving what the header's side-panel toggle addresses (M-159).
 *
 * One Multica Project equals one dsh Workspace (a folder). The folder comes
 * from the selected project's `local_directory` resource; "All projects" falls
 * back to the host's `workspaceFolder` config, empty meaning none. For a
 * folder the bridge matches the dsh Workspace by normalized path — creating
 * one when none exists (`workspaces.create` is idempotent) — and binds the
 * Session the sidebar surface works on: the on-screen one when it belongs to
 * that Workspace, otherwise the Workspace's first Session, otherwise a new
 * Session in it.
 *
 * Everything here is pure: the bridges carry real services, this module only
 * decides. Tests cover each rule separately.
 */

/** A project resource's `local_directory` ref subset the folder logic reads. */
export interface LocalDirectoryRefLike {
  daemon_id?: string;
  local_path?: string;
  execution_mode?: string;
}

/** A project resource subset the folder logic reads. */
export interface ProjectResourceLike {
  resource_type: unknown;
  resource_ref: unknown;
}

/**
 * The folder one project's resources name, after the daemon filter.
 *
 * Only `local_directory` refs address a folder on this host. A resource known
 * to run on another daemon names a folder we cannot open files for, so it is
 * not used; the first remaining ref wins. `in_place` mode is the one that
 * actually edits the user's working copy — a `worktree` ref names a runtime
 * copy, not the folder the sidebar's Session owns — so it is skipped.
 *
 * @param resources - the project's resources, in server order.
 * @param daemonId - this host's daemon id; a ref on a different daemon is
 *   skipped. Empty means the host cannot name its daemon, so no ref is
 *   filtered (permissive by default).
 */
export function folderOfProjectResources(
  resources: readonly ProjectResourceLike[],
  daemonId: string,
): string | null {
  const mine = daemonId.trim().toLowerCase();
  for (const resource of resources) {
    if (resource.resource_type !== "local_directory") continue;
    const ref: unknown = resource.resource_ref;
    if (typeof ref !== "object" || ref === null) continue;
    const record = ref as LocalDirectoryRefLike;
    if (record.execution_mode === "worktree") continue;
    if (
      mine !== "" &&
      typeof record.daemon_id === "string" &&
      record.daemon_id.trim().toLowerCase() !== mine
    ) {
      continue;
    }
    const path = typeof record.local_path === "string" ? record.local_path.trim() : "";
    if (path !== "") return path;
  }
  return null;
}

/**
 * The folder the Files/Terminal buttons address right now.
 *
 * @param projectId - the selected project, or `null` for "All projects".
 * @param projects - the projects the selected id is resolved against.
 * @param resourceFor - one project id to its `local_directory`-eligible folder,
 *   or `null`/`undefined` when that project has none (or their resources are
 *   still loading).
 * @param workspaceFolder - the host's default for "All projects"; may be empty.
 */
export function folderForSelection(
  projectId: string | null,
  projects: readonly { id: string }[] | undefined,
  resourceFor: (projectId: string) => string | null | undefined,
  workspaceFolder: string,
): {
  folder: string | null;
  reason: "project" | "default" | "project-no-folder" | "no-folder";
} {
  if (projectId !== null) {
    const known =
      projects === undefined || projects.some((project) => project.id === projectId);
    if (!known) return { folder: null, reason: "no-folder" };
    const fromProject = resourceFor(projectId);
    if (fromProject !== undefined && fromProject !== null && fromProject !== "") {
      return { folder: fromProject, reason: "project" };
    }
    // No folder on the project: buttons disabled with the link-a-folder copy,
    // per the amendment — the global default never rescues a project.
    return { folder: null, reason: "project-no-folder" };
  }
  const fallback = workspaceFolder.trim();
  return { folder: fallback === "" ? null : fallback, reason: fallback === "" ? "no-folder" : "default" };
}

/**
 * Whether the dsh sidebar has a session surface its commands can act on.
 *
 * The controller's own writes (`require()` in the ui-sidebar-right service)
 * throw `no session surface is mounted` precisely when the mounted snapshot
 * carries no Session, so this is the decision the buttons make instead of
 * re-throwing: a false answer predicts the next write's throw. Reads stay
 * available either way — `isExpanded` answers for the no-session case —
 * which is why only writes check.
 */
export function sessionSurfaceMounted(
  sidebarRight: { mounted: { getSnapshot(): string | undefined } } | null | undefined,
): boolean {
  return sidebarRight?.mounted.getSnapshot() !== undefined;
}

/** The words the dsh sidebar face rejects a write with when no surface is mounted. */
export const SIDEBAR_NO_SESSION_MESSAGE = "no session surface is mounted";

/**
 * The failure the dsh face raises for a write with no Session on screen.
 *
 * The fallback path can reach the same state by waiting too long for the
 * Session it just selected to be drawn (`waitForMountedSession`), so it raises
 * this exact error rather than a new message: one note path covers both.
 */
export function noSessionSurfaceError(): Error {
  return new Error(`sidebarRight: ${SIDEBAR_NO_SESSION_MESSAGE}`);
}

/**
 * Whether an open or toggle died on exactly the no-session-surface state.
 *
 * Checked after the call, because a session can leave between the pre-check
 * and the click; both outcomes mean the same user-facing note, so the caller
 * maps this to the `no-session` tooltip copy instead of the raw error text.
 */
export function isNoSessionSurfaceError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes(SIDEBAR_NO_SESSION_MESSAGE);
}

export type DisabledReason = "project" | "default" | "project-no-folder" | "no-folder" | "no-session";

/** The copy a reveal that never landed surfaces. */
export const NO_SESSION_SURFACE_NOTE =
  "The dsh side panel needs a session in the project folder";

/**
 * The tooltip copy for one reason, the way the disabled state reads.
 *
 * The no-session throw is shell state, not a glitch — a host without card C's
 * `hostPanel` draws no sidebar until a Session owns the main column — so it
 * says why the way the disabled state does, instead of the controller's raw
 * error text leaking into the header.
 */
export function describe(reason: DisabledReason, folder: string | null = null): string {
  if (reason === "no-session") return NO_SESSION_SURFACE_NOTE;
  return disabledTooltip(reason, folder);
}

/** The tooltip for the disabled toggle. */
export function disabledTooltip(
  reason: DisabledReason,
  folder: string | null,
): string {
  switch (reason) {
    case "project":
    case "default":
      return "Open the dsh side panel";
    case "project-no-folder":
      return "Link a folder to this project";
    case "no-folder":
      return "Choose a project";
    case "no-session":
      return folder === null
        ? "Link a folder to this project"
        : `Open a dsh session in ${folder}`;
  }
}

/** Path equality in the way dsh hosts name directories: `/`-collapsed, trailing `/` gone. */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "") return "";
  const collapsed = trimmed.endsWith("/")
    ? trimmed.replace(/\/+$/, "")
    : trimmed;
  return collapsed.replace(/\/{2,}/g, "/");
}

/** Subset of the dsh Workspace view the match reads. */
export interface WorkspaceLike {
  workspaceId: string;
  path: string;
  sessionIds: readonly string[];
}

/** Subset of the dsh Session view the binding reads. */
export interface SessionLike {
  id: string;
  cwd?: string;
}

/**
 * The dsh Workspace for one folder: the one whose path matches, else `null`
 * (the caller creates one — a dsh Workspace is never deleted here).
 */
export function workspaceForFolder(
  workspaces: readonly WorkspaceLike[],
  folder: string,
): WorkspaceLike | null {
  const want = normalizePath(folder);
  if (want === "") return null;
  return workspaces.find((entry) => normalizePath(entry.path) === want) ?? null;
}

/**
 * The Session the sidebar surface opens the tab under.
 *
 * The on-screen Session when it belongs to the Workspace (the Owner's bind
 * rule), else the Workspace's first Session, else `null` — the caller creates
 * one in the Workspace.
 */
export function boundSessionId(
  mountedSessionId: string | undefined,
  workspace: Pick<WorkspaceLike, "sessionIds">,
): string | null {
  const mounted = mountedSessionId?.trim();
  if (mounted && workspace.sessionIds.includes(mounted)) return mounted;
  const first = workspace.sessionIds[0];
  return first === undefined ? null : first;
}

/**
 * What one press of the header's panel toggle does.
 *
 * `toggle` flips the Sidebar that is already on screen — the same call dsh's
 * own header control makes, so the reader gets the column, its tabs and its
 * Start guide exactly as dsh draws them. `retarget` is the hosted case: the
 * column is drawn beside MMX, and it has to be told which Session's folder it
 * edits before it opens, or Files and Terminal would point at whichever
 * Session the Conversation last had. `reveal` is the case the controller
 * cannot answer on its own: no Session is on screen (MMX owns the main column
 * and the host has neither `hostPanel` nor `selectHostedSession`), so the
 * folder's Session has to be put on screen before the column has anything to
 * draw.
 */
export type ToggleIntent =
  | { kind: "toggle" }
  | { kind: "retarget"; sessionId: string | null }
  | { kind: "reveal"; sessionId: string | null };

/**
 * Plan the call one press makes.
 *
 * The column always shows the Session bound to the project's folder. With card
 * C it renders beside MMX, so the press names that Session
 * (`selectHostedSession`) and flips the column, leaving the main column where it
 * is. Without it the only surface is the on-screen Session, and the press has to
 * bring the folder's own Session on screen first — otherwise the column opens
 * on somebody else's workspace. A host that hosts the panel but cannot name a
 * Session is left to toggle what it shows, since moving the column would mean
 * leaving MMX.
 */
export function planSidebarToggle(input: {
  hasHostPanel: boolean;
  canNameSession: boolean;
  mountedSessionId: string | undefined;
  boundSessionId: string | null;
}): ToggleIntent {
  const mounted = input.mountedSessionId?.trim();
  const onScreen = mounted !== undefined && mounted !== "";
  // The column already edits the project's folder: flip it, nothing to move.
  if (onScreen && input.boundSessionId === mounted) return { kind: "toggle" };
  if (input.hasHostPanel && input.canNameSession) {
    return { kind: "retarget", sessionId: input.boundSessionId };
  }
  // A host that hosts the panel but cannot name the column's Session keeps the
  // column on the Session it draws; moving it would mean leaving MMX.
  if (onScreen && input.hasHostPanel) return { kind: "toggle" };
  return { kind: "reveal", sessionId: input.boundSessionId };
}

/**
 * The toggle's tooltip: what a press does, and on which folder.
 *
 * @param expanded - whether the Sidebar is shown right now (pressed state).
 * @param folder - the folder the column would show; never null when enabled.
 */
export function panelToggleTitle(expanded: boolean, folder: string): string {
  return expanded ? "Close the dsh side panel" : `Open the dsh side panel on ${folder}`;
}

/** How long a fallback waits for the shell to draw the Session it selected. */
export const SESSION_MOUNT_TIMEOUT_MS = 5000;

/**
 * Wait for the sidebar's on-screen Session to become `sessionId`.
 *
 * Selecting a Session is a navigation: the shell re-renders, the runtime mints
 * that Session's store, and only then does the sidebar adopt it. Opening a tab
 * before that lands writes into no surface at all, so the fallback waits — on
 * the controller's own `mounted` snapshot, which is what its writes read —
 * and gives up after `timeoutMs` instead of hanging the button.
 *
 * @param sidebarRight - the sidebar face whose `mounted` snapshot is watched.
 * @param sessionId - the Session the tab must open under.
 * @param options - timeout and poll interval; defaults are the module's.
 * @returns whether the Session became the on-screen one in time.
 */
export async function waitForMountedSession(
  sidebarRight: Pick<SidebarRightLike, "mounted">,
  sessionId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const mounted = sidebarRight.mounted;
  if (mounted.getSnapshot() === sessionId) return true;
  const timeoutMs = options.timeoutMs ?? SESSION_MOUNT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 100;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: () => void = () => {};
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    const check = (): boolean => {
      if (mounted.getSnapshot() === sessionId) {
        finish(true);
        return true;
      }
      return false;
    };
    unsubscribe = mounted.subscribe(check);
    if (check()) return;
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (settled || check()) return;
      if (Date.now() >= deadline) {
        finish(false);
        return;
      }
      timer = setTimeout(poll, intervalMs);
    };
    timer = setTimeout(poll, intervalMs);
  });
}

/** Structural subset of the dsh `sidebarRight` face the bridge uses. */
export interface SidebarRightLike {
  readonly mounted: {
    getSnapshot(): string | undefined;
    subscribe(listener: () => void): () => void;
  };
  toggleExpanded(): void;
  isExpanded(): boolean;
  /** Card C publishes the same fact as a subscribable; absent before it ships. */
  expanded?: {
    getSnapshot(): boolean;
    subscribe(listener: () => void): () => void;
  };
  /** Card C's opt-in: the sidebar beside a hosted `main` panel. Optional face. */
  hostPanel?(panelId: string): () => void;
  /**
   * Card C's target for the hosted column; absent before it ships. Naming a
   * Session is what makes Files and Terminal open on the project's folder
   * while MMX keeps the main column.
   */
  selectHostedSession?(sessionId: string): () => void;
}

/** Structural subset of the dsh `workspaces` face the bridge uses. */
export interface WorkspacesLike {
  readonly list: {
    getSnapshot(): { items: readonly WorkspaceLike[] };
    subscribe(listener: () => void): () => void;
  };
  create(input: { path: string }): Promise<WorkspaceLike>;
}

/** Structural subset of the dsh session navigation face the bridge uses. */
export interface SessionNavigationLike {
  /** Select a Session and show its Conversation, as the shell's own lists do. */
  openSession(target: string): void;
}

/** Structural subset of the dsh `sessions` face the bridge uses. */
export interface SessionsLike {
  readonly list: {
    getSnapshot(): { byId: Record<string, SessionLike> };
    subscribe(listener: () => void): () => void;
  };
  create(opts?: { workspaceId?: string; cwd?: string }): Promise<string>;
}
