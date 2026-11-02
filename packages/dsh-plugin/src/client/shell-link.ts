/**
 * Resolving what the Files/Terminal buttons address (M-159).
 *
 * One Multica Project equals one dsh Workspace (a folder). The folder comes
 * from the selected project's `local_directory` resource; "All projects" falls
 * back to the host's `workspaceFolder` config, empty meaning none. For a
 * folder the bridge matches the dsh Workspace by normalized path — creating
 * one when none exists (`workspaces.create` is idempotent) — and binds the
 * Session the sidebar surface should open the files/terminal tab under: the
 * on-screen one when it belongs to that Workspace, otherwise the Workspace's
 * first Session, otherwise a new Session in it.
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

/** The tooltip for a disabled pair of buttons. */
export function disabledTooltip(
  reason:
    | "project"
    | "default"
    | "project-no-folder"
    | "no-folder"
    | "no-session",
  folder: string | null,
): string {
  switch (reason) {
    case "project":
    case "default":
      return "Files and Terminal are ready";
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
 * One open intent, already resolved against the sidebar surface's abilities.
 *
 * With card C's `hostPanel` deployed the sidebar shows beside a hosted main
 * panel, and Session-bound tabs open through `openTabIn`; the plain `openTab`
 * acts on the on-screen Session. No `hostPanel` is the fallback: the main
 * panel is dropped (`layout.selectPanel(null)`) first, then the tab opens.
 */
export type OpenIntent =
  | { kind: "openTab"; tabKind: string; sessionId?: string }
  | { kind: "fallback"; tabKind: string; selectFirst: boolean; sessionId?: string };

/**
 * Plan the call a button press makes.
 *
 * `openTabIn` exists on the face regardless of card C; in-session opening
 * keeps MMX bound to the Workspace's Session instead of retargeting whatever
 * the Conversation has selected. A fallback also selects the Conversation
 * first, because the on-screen Session and the tab strip only exist while the
 * Conversation owns the right sidebar's surface.
 */
export function planSidebarOpen(input: {
  hasHostPanel: boolean;
  boundSessionId: string | null;
  mountedSessionId: string | undefined;
  tabKind: string;
}): OpenIntent {
  const sessionId =
    input.boundSessionId === null || input.boundSessionId === input.mountedSessionId
      ? undefined
      : input.boundSessionId;
  if (input.hasHostPanel) {
    return { kind: "openTab", tabKind: input.tabKind, sessionId };
  }
  // Dropped panel first so the Session surface mounts; then the tab.
  return { kind: "fallback", tabKind: input.tabKind, selectFirst: true, sessionId };
}

/** The two tab kinds the buttons open, as the sidebar faces name them. */
export const FILES_TAB_KIND = "files";
export const TERMINAL_TAB_KIND = "terminal";

/** Structural subset of the dsh `sidebarRight` face the bridge uses. */
export interface SidebarRightLike {
  readonly mounted: { getSnapshot(): string | undefined };
  openTab(kind: string, options?: { params?: unknown }): void;
  openTabIn?(sessionId: string, kind: string, options?: { params?: unknown }): void;
  toggleExpanded(): void;
  isExpanded(): boolean;
  /** Card C's opt-in: the sidebar beside a hosted `main` panel. Optional face. */
  hostPanel?(panelId: string): () => void;
}

/** Structural subset of the dsh `workspaces` face the bridge uses. */
export interface WorkspacesLike {
  readonly list: {
    getSnapshot(): { items: readonly WorkspaceLike[] };
    subscribe(listener: () => void): () => void;
  };
  create(input: { path: string }): Promise<WorkspaceLike>;
}

/** Structural subset of the dsh `sessions` face the bridge uses. */
export interface SessionsLike {
  readonly list: {
    getSnapshot(): { byId: Record<string, SessionLike> };
    subscribe(listener: () => void): () => void;
  };
  create(opts?: { workspaceId?: string; cwd?: string }): Promise<string>;
}
