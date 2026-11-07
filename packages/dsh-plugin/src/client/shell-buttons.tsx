import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PanelRight, PanelRightClose, projectResourcesOptions } from "../fork";
import { hostShell, type ShellBridge } from "./shell-runtime";
import {
  boundSessionId,
  describe,
  disabledTooltip,
  folderForSelection,
  folderOfProjectResources,
  isNoSessionSurfaceError,
  noSessionSurfaceError,
  panelToggleTitle,
  planSidebarToggle,
  sessionSurfaceMounted,
  waitForMountedSession,
  workspaceForFolder,
  type SidebarRightLike,
} from "./shell-link";

/**
 * The header's side-panel toggle (M-159): the dsh right Sidebar, opened from
 * MMX the way dsh's own session header opens it.
 *
 * It is one icon button, not a control per sidebar view: the column owns its
 * tabs, its Start guide and its collapse, exactly as it does beside a
 * Conversation, so MMX has nothing to name beyond "show it". The folder it
 * addresses is the selected project's `local_directory` resource; "All
 * projects" addresses the host's `workspaceFolder`, which is empty on many
 * hosts. No folder means the button is disabled with the copy that says what
 * is missing.
 *
 * A press either flips the column on screen (`toggle`), names the project's
 * Session for the column that is drawn beside MMX (`retarget`), or, when no
 * Session is on screen to draw it for, brings the folder's Session on screen
 * first (`reveal`). Card C's `hostPanel` opt-in — installed in `apply` — is what
 * lets the first two keep MMX where it is; a host without it has to reveal the
 * Session, which is the only place its Sidebar can be drawn.
 *
 * The button renders only when `apply` installed a bridge — the one host fact
 * this island cannot know without the shell, so its absence is exactly the
 * "no right sidebar" case. A failed press stays in the tooltip rather than in
 * the header: shell state is not a page error, and the header is a strip.
 */
export function ShellButtons({
  workspaceId,
  projects,
  projectId,
  workspaceFolder,
}: {
  workspaceId: string;
  projects: readonly { id: string }[] | undefined;
  projectId: string | null;
  workspaceFolder: string;
}) {
  const shell = hostShell();
  if (shell === null || shell.sidebarRight === null) return null;
  return <SidePanelToggle
    shell={shell}
    workspaceId={workspaceId}
    projects={projects}
    projectId={projectId}
    workspaceFolder={workspaceFolder}
  />;
}

/**
 * The name last given to the hosted column, released when a press replaces it.
 *
 * Page-lifetime, like the rest of this bridge: one name is in force at a time,
 * and a press on another project's folder must withdraw the old one rather
 * than leave the column on the workspace it no longer edits.
 */
let releaseHostedSession: (() => void) | null = null;

/**
 * Tell the hosted column which Session's folder it edits.
 *
 * @param sidebarRight - the face that names the column's Session.
 * @param sessionId - the Session bound to the project's folder.
 */
function nameHostedSession(sidebarRight: SidebarRightLike, sessionId: string): void {
  const name = sidebarRight.selectHostedSession;
  if (typeof name !== "function") {
    throw new Error("this dsh build cannot retarget the side panel");
  }
  releaseHostedSession?.();
  releaseHostedSession = name.call(sidebarRight, sessionId);
}

/** The Sidebar's shown state, read tolerantly: a face without it reads closed. */
function readExpanded(sidebarRight: SidebarRightLike | null): boolean {
  try {
    return sidebarRight?.isExpanded() ?? false;
  } catch {
    return false;
  }
}

function SidePanelToggle({
  shell,
  workspaceId,
  projects,
  projectId,
  workspaceFolder,
}: {
  shell: ShellBridge;
  workspaceId: string;
  projects: readonly { id: string }[] | undefined;
  projectId: string | null;
  workspaceFolder: string;
}) {
  const sidebarRight = shell.sidebarRight;

  // The pressed state follows the controller, not this button: the reader can
  // collapse the column from its own header too. Card C publishes `expanded`
  // as a subscribable; without it the button tracks its own presses only.
  const [expanded, setExpanded] = useState<boolean>(() => readExpanded(sidebarRight));
  useEffect(() => {
    const observable = sidebarRight?.expanded;
    if (observable === undefined) return;
    setExpanded(observable.getSnapshot());
    return observable.subscribe(() => setExpanded(observable.getSnapshot()));
  }, [sidebarRight]);

  // The selected project's resources share the pages' query key, so this adds
  // no request of its own once any project surface has loaded the list.
  const { data: resources } = useQuery({
    ...projectResourcesOptions(workspaceId, projectId ?? ""),
    enabled: projectId !== null,
  });

  const resolved = useMemo(() => {
    const folderOf = (id: string): string | null | undefined => {
      if (id !== projectId || resources === undefined) return undefined;
      return folderOfProjectResources(resources, shell.daemonId);
    };
    return folderForSelection(projectId, projects, folderOf, workspaceFolder);
  }, [projectId, projects, resources, workspaceFolder, shell.daemonId]);

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function onToggle(): Promise<void> {
    const { workspaces, sessions } = shell;
    if (sidebarRight === null) return;
    const folder = resolved.folder;
    if (folder === null || workspaces === null || sessions === null) return;
    // A press on an open column closes it where it is. Retargeting first would
    // swap the Session under a column the reader is closing.
    if (readExpanded(sidebarRight)) {
      sidebarRight.toggleExpanded();
      setExpanded(false);
      setNote(null);
      return;
    }
    setBusy(true);
    try {
      // Match or create (never delete): dsh Workspace registration is
      // idempotent on the path, so a repeated press converges.
      let workspace = workspaceForFolder(workspaces.list.getSnapshot().items, folder);
      if (workspace === null) {
        workspace = await workspaces.create({ path: folder });
      }
      const intent = planSidebarToggle({
        hasHostPanel: typeof sidebarRight.hostPanel === "function",
        canNameSession: typeof sidebarRight.selectHostedSession === "function",
        mountedSessionId: sidebarRight.mounted.getSnapshot(),
        boundSessionId: boundSessionId(sidebarRight.mounted.getSnapshot(), workspace),
      });
      if (intent.kind === "toggle") {
        sidebarRight.toggleExpanded();
        setExpanded(readExpanded(sidebarRight));
        setNote(null);
        return;
      }
      let sessionId = intent.sessionId;
      if (sessionId === null || sessionId === "") {
        sessionId = await sessions.create({ workspaceId: workspace.workspaceId });
      }
      if (intent.kind === "retarget") {
        // The column is drawn beside MMX: name the project's Session so Files
        // and Terminal open on that folder, and flip the column in place. MMX
        // keeps the main column, so the board never leaves the screen.
        nameHostedSession(sidebarRight, sessionId);
        if (!sessionSurfaceMounted(sidebarRight)) throw noSessionSurfaceError();
        if (!readExpanded(sidebarRight)) sidebarRight.toggleExpanded();
        setExpanded(readExpanded(sidebarRight));
        setNote(null);
        return;
      }
      // No Session on screen to draw the column for: bind the folder's own and
      // reveal it. Selecting is the shell's navigation, and it puts that
      // Session's Conversation in the main column, which is where a host
      // without card C draws the Sidebar.
      if (shell.selectSession === null) {
        throw new Error(`this dsh build cannot select a session, so the side panel cannot open on ${folder}`);
      }
      shell.selectSession(sessionId);
      if (!(await waitForMountedSession(sidebarRight, sessionId))) {
        // The shell never drew the Session: the same state the face's own write
        // rejects, so it reads with the same copy.
        throw noSessionSurfaceError();
      }
      if (!readExpanded(sidebarRight)) sidebarRight.toggleExpanded();
      setExpanded(readExpanded(sidebarRight));
      setNote(null);
    } catch (cause: unknown) {
      setNote(
        isNoSessionSurfaceError(cause)
          ? describe("no-session")
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    } finally {
      setBusy(false);
    }
  }

  const folder = resolved.folder;
  const disabled = folder === null || busy;
  const title = disabled
    ? disabledTooltip(resolved.reason, folder)
    : panelToggleTitle(expanded, folder);
  const glyph = expanded
    ? <PanelRightClose className="size-4" />
    : <PanelRight className="size-4" />;

  return (
    <button
      type="button"
      data-shell-button="toggle"
      data-shell-note={note ?? undefined}
      aria-label={note ?? title}
      aria-pressed={expanded}
      disabled={disabled}
      title={note ?? title}
      className={panelButtonClassName}
      onClick={() => void onToggle()}
    >
      {glyph}
    </button>
  );
}

const panelButtonClassName =
  "h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-foreground " +
  "flex disabled:cursor-not-allowed disabled:opacity-50";
