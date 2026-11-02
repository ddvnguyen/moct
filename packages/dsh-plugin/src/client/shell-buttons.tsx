import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectResourcesOptions } from "../fork";
import { hostShell, type ShellBridge } from "./shell-runtime";
import {
  FILES_TAB_KIND,
  TERMINAL_TAB_KIND,
  boundSessionId,
  disabledTooltip,
  folderForSelection,
  isNoSessionSurfaceError,
  folderOfProjectResources,
  NO_SESSION_SURFACE_NOTE,
  planSidebarOpen,
  sessionSurfaceMounted,
  workspaceForFolder,
  describe,
  type OpenIntent,
  type SidebarRightLike,
} from "./shell-link";

/**
 * The header's right slot buttons (M-159): **Files** and **Terminal** open the
 * dsh right sidebar beside MMX, and a sidebar toggle sits last.
 *
 * The folder they address is the selected project's `local_directory`
 * resource; "All projects" addresses the host's `workspaceFolder`, which is
 * empty on many hosts. Nothing to address, or no dsh Workspace + Session to
 * open a tab under, disables the pair with a tooltip saying what is missing.
 * The bridge carries the dsh faces; the copy says "Project" for Multica and
 * "folder" for the path.
 *
 * Buttons render only when `apply` installed a bridge — the one host fact
 * this island cannot know without the shell, so their absence is exactly the
 * "no right sidebar" case.
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
  return <ShellButtonsInner
    shell={shell}
    workspaceId={workspaceId}
    projects={projects}
    projectId={projectId}
    workspaceFolder={workspaceFolder}
  />;
}

function ShellButtonsInner({
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
  const mountedSessionId = useMemo(() => {
    try {
      return shell.sidebarRight?.mounted.getSnapshot();
    } catch {
      return undefined;
    }
  }, [shell.sidebarRight]);

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

  async function ensureThenOpen(tabKind: string): Promise<void> {
    const { sidebarRight, workspaces, sessions } = shell;
    if (sidebarRight === null) return;
    const folder = resolved.folder;
    if (folder === null) {
      setNote(disabledTooltip(resolved.reason, folder));
      return;
    }
    if (workspaces === null || sessions === null) return;
    setBusy(true);
    try {
      // Match or create (never delete): dsh Workspace registration is
      // idempotent on the path, so a repeated click converges.
      let workspace = workspaceForFolder(workspaces.list.getSnapshot().items, folder);
      if (workspace === null) {
        workspace = await workspaces.create({ path: folder });
      }
      let sessionId = boundSessionId(mountedSessionId, workspace);
      if (sessionId === null) {
        sessionId = await sessions.create({ workspaceId: workspace.workspaceId });
      }
      open(
        shell,
        sidebarRight,
        planSidebarOpen({
          hasHostPanel: typeof sidebarRight.hostPanel === "function",
          boundSessionId: sessionId,
          mountedSessionId,
          tabKind,
        }),
      );
      setNote(null);
    } catch (cause: unknown) {
      // The M-159 no-session throw is a shell state, not a crash: say why like
      // the disabled buttons do instead of erroring the page.
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

  const disabled = resolved.folder === null || busy;
  const title = disabled
    ? disabledTooltip(resolved.reason, resolved.folder)
    : `Files and Terminal open the dsh sidebar on ${resolved.folder}`;

  return (
    <>
      <button
        type="button"
        data-shell-button="files"
        disabled={disabled}
        title={title}
        className={shellButtonClassName}
        onClick={() => void ensureThenOpen(FILES_TAB_KIND)}
      >
        Files
      </button>
      <button
        type="button"
        data-shell-button="terminal"
        disabled={disabled}
        title={title}
        className={shellButtonClassName}
        onClick={() => void ensureThenOpen(TERMINAL_TAB_KIND)}
      >
        Terminal
      </button>
      <SidebarToggle sidebarRight={shell.sidebarRight} notify={setNote} />
      {note !== null && (
        // A failed open is a shell fact the reader should see, not a dialog.
        <span data-shell-note="" className="text-caption text-muted-foreground">
          {note}
        </span>
      )}
    </>
  );
}

function SidebarToggle({
  sidebarRight,
  notify,
}: {
  sidebarRight: SidebarRightLike | null;
  notify: (note: string) => void;
}) {
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return sidebarRight?.isExpanded() ?? false;
    } catch {
      return false;
    }
  });
  if (sidebarRight === null) return null;
  // The same no-session knowledge the disabled-tooltip logic already has: the
  // face throws for every access while no session surface is mounted, so the
  // toggle reads as a disabled button (with the explanatory title) there —
  // MMX owning the main column is the situation it explains.
  const surfaceMounted = sessionSurfaceMounted(sidebarRight);
  const title = surfaceMounted
    ? expanded
      ? "Hide the dsh sidebar"
      : "Show the dsh sidebar"
    : NO_SESSION_SURFACE_NOTE;
  return (
    <button
      type="button"
      data-shell-button="toggle"
      disabled={!surfaceMounted}
      title={title}
      className={shellButtonClassName}
      onClick={() => {
        try {
          sidebarRight.toggleExpanded();
          // The face has no expanded observable; the toggler's own click is
          // the state change, and the next mount reconciles via `isExpanded()`.
          setExpanded((current) => !current);
        } catch (cause) {
          if (isNoSessionSurfaceError(cause)) {
            notify(describe("no-session"));
            return;
          }
          // Anything else is a real failure: state may not have changed, so
          // leave the optimistic flip alone and surface it like the opens do.
          notify(cause instanceof Error ? cause.message : String(cause));
        }
      }}
    >
      {surfaceMounted && expanded ? "Collapse" : "Expand"}
    </button>
  );
}

function open(
  shell: ShellBridge,
  sidebarRight: SidebarRightLike,
  intent: OpenIntent,
): void {
  if (intent.kind === "fallback" && intent.selectFirst) {
    // Without card C's `hostPanel` the sidebar only exists while the
    // Conversation owns the main column; the island's tabs survive the drop
    // through keep-alive.
    shell.selectPanel?.(null);
  }
  if (intent.kind === "openTab") {
    if (intent.sessionId !== undefined && typeof sidebarRight.openTabIn === "function") {
      sidebarRight.openTabIn(intent.sessionId, intent.tabKind);
      return;
    }
    sidebarRight.openTab(intent.tabKind);
    return;
  }
  if (typeof sidebarRight.openTabIn === "function" && intent.sessionId !== undefined) {
    sidebarRight.openTabIn(intent.sessionId, intent.tabKind);
    return;
  }
  sidebarRight.openTab(intent.tabKind);
}

const shellButtonClassName =
  "h-7 shrink-0 rounded-md border border-border px-2 text-caption text-foreground " +
  "disabled:cursor-not-allowed disabled:opacity-50";
