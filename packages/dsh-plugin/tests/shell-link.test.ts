/**
 * The shell-link rules (M-159): folder resolution, workspace matching, session
 * binding, and the toggle plan's `hostPanel` feature detection. All pure — the
 * dsh faces enter as structural test doubles.
 */
import { describe, expect, it } from "vitest";
import {
  boundSessionId,
  describe as describeReason,
  disabledTooltip,
  folderForSelection,
  folderOfProjectResources,
  isNoSessionSurfaceError,
  normalizePath,
  NO_SESSION_SURFACE_NOTE,
  noSessionSurfaceError,
  panelToggleTitle,
  planSidebarToggle,
  sessionSurfaceMounted,
  waitForMountedSession,
  workspaceForFolder,
  type ProjectResourceLike,
  type WorkspaceLike,
} from "../src/client/shell-link";

const PROJECTS = [{ id: "p1" }, { id: "p2" }];

function directory(path: string, daemonId = "daemon-a"): ProjectResourceLike {
  return { resource_type: "local_directory", resource_ref: { local_path: path, daemon_id: daemonId } };
}

describe("folderOfProjectResources", () => {
  it("takes the first local_directory ref that is not on another daemon", () => {
    expect(
      folderOfProjectResources(
        [
          { resource_type: "github_repo", resource_ref: { url: "https://github" } },
          directory("/srv/demo"),
        ],
        "DAEMON-A",
      ),
    ).toBe("/srv/demo");
  });

  it("skips refs whose daemon is not this host's", () => {
    expect(folderOfProjectResources([directory("/x", "daemon-b")], "daemon-a")).toBeNull();
  });

  it("filters nothing when the host cannot name its daemon", () => {
    expect(folderOfProjectResources([directory("/x", "daemon-b")], "")).toBe("/x");
  });

  it("skips worktree refs: a runtime copy is not the folder the sidebar Session owns", () => {
    const ref = {
      resource_type: "local_directory",
      resource_ref: { local_path: "/srv/worktree", daemon_id: "daemon-a", execution_mode: "worktree" },
    };
    expect(folderOfProjectResources([ref], "daemon-a")).toBeNull();
  });

  it("ignores non-directory types and empty paths", () => {
    expect(
      folderOfProjectResources([{ resource_type: "local_directory", resource_ref: { local_path: " " } }], "d"),
    ).toBeNull();
  });
});

describe("folderForSelection", () => {
  it("uses the selected project's folder", () => {
    expect(folderForSelection("p1", PROJECTS, (id) => (id === "p1" ? "/srv/demo" : null), "")).toEqual({
      folder: "/srv/demo",
      reason: "project",
    });
  });

  it("disables with the link-a-folder copy when the project has no local_directory", () => {
    const resolved = folderForSelection("p2", PROJECTS, () => null, "/srv/demo");
    expect(resolved).toEqual({ folder: null, reason: "project-no-folder" });
    expect(disabledTooltip(resolved.reason, resolved.folder)).toBe("Link a folder to this project");
  });

  it("does not rescue a project with the global default", () => {
    const resolved = folderForSelection("p2", PROJECTS, () => undefined, "/srv/only-all");
    expect(resolved.folder).toBeNull();
  });

  it("falls back to workspaceFolder for All projects", () => {
    expect(folderForSelection(null, PROJECTS, () => null, "/srv/demo")).toEqual({
      folder: "/srv/demo",
      reason: "default",
    });
  });

  it("asks the reader to choose a project when All projects has no default", () => {
    const resolved = folderForSelection(null, PROJECTS, () => null, "");
    expect(resolved.folder).toBeNull();
    expect(disabledTooltip(resolved.reason, resolved.folder)).toBe("Choose a project");
  });

  it("reads All projects normally while the project list is loading", () => {
    expect(folderForSelection(null, undefined, () => undefined, "/srv/demo")?.folder).toBe("/srv/demo");
  });
});

describe("workspaceForFolder", () => {
  const workspaces: WorkspaceLike[] = [
    { workspaceId: "w-1", path: "/srv/demo/", sessionIds: ["s-1"] },
    { workspaceId: "w-2", path: "/srv/other", sessionIds: [] },
  ];

  it("matches by normalized path", () => {
    expect(workspaceForFolder(workspaces, "/srv//demo")?.workspaceId).toBe("w-1");
  });

  it("matches nothing when no path is equal", () => {
    expect(workspaceForFolder(workspaces, "/srv/demos")).toBeNull();
  });
});

describe("boundSessionId", () => {
  it("keeps the on-screen Session when it belongs to the Workspace", () => {
    expect(boundSessionId("s-1", { sessionIds: ["s-1", "s-2"] })).toBe("s-1");
  });

  it("rebinds to the Workspace's first Session otherwise", () => {
    expect(boundSessionId("s-9", { sessionIds: ["s-1", "s-2"] })).toBe("s-1");
  });

  it("returns null when the Workspace has no Session (caller creates one)", () => {
    expect(boundSessionId(undefined, { sessionIds: [] })).toBeNull();
  });
});

describe("planSidebarToggle", () => {
  it("retargets the hosted column when it draws another Workspace's Session", () => {
    // MMX owns the main column, so nothing selects a Session: the press names
    // the project's own Session and keeps the board where it is.
    expect(
      planSidebarToggle({
        hasHostPanel: true,
        canNameSession: true,
        mountedSessionId: "s-other",
        boundSessionId: "s-1",
      }),
    ).toEqual({ kind: "retarget", sessionId: "s-1" });
  });

  it("flips the hosted column when it already draws the bound Session", () => {
    expect(
      planSidebarToggle({
        hasHostPanel: true,
        canNameSession: true,
        mountedSessionId: "s-1",
        boundSessionId: "s-1",
      }),
    ).toEqual({ kind: "toggle" });
  });

  it("retargets to a Session it will have to create when the Workspace has none", () => {
    expect(
      planSidebarToggle({
        hasHostPanel: true,
        canNameSession: true,
        mountedSessionId: "s-other",
        boundSessionId: null,
      }),
    ).toEqual({ kind: "retarget", sessionId: null });
  });

  it("flips a hosted column it cannot retarget, rather than leaving MMX", () => {
    // A card C build before naming shipped: the column has no way to move, and
    // revealing the Session would replace the board with a Conversation.
    expect(
      planSidebarToggle({
        hasHostPanel: true,
        canNameSession: false,
        mountedSessionId: "s-other",
        boundSessionId: "s-1",
      }),
    ).toEqual({ kind: "toggle" });
  });

  it("flips it without card C when the bound Session is the on-screen one", () => {
    expect(
      planSidebarToggle({
        hasHostPanel: false,
        canNameSession: false,
        mountedSessionId: "s-1",
        boundSessionId: "s-1",
      }),
    ).toEqual({ kind: "toggle" });
  });

  it("reveals the folder's Session when no Session is on screen", () => {
    expect(
      planSidebarToggle({
        hasHostPanel: false,
        canNameSession: false,
        mountedSessionId: undefined,
        boundSessionId: "s-1",
      }),
    ).toEqual({ kind: "reveal", sessionId: "s-1" });
  });

  it("reveals when the screen is showing another Workspace's Session", () => {
    expect(
      planSidebarToggle({
        hasHostPanel: false,
        canNameSession: false,
        mountedSessionId: "s-9",
        boundSessionId: "s-1",
      }),
    ).toEqual({ kind: "reveal", sessionId: "s-1" });
  });

  it("asks for a Session to be created when the Workspace has none and nothing hosts it", () => {
    expect(
      planSidebarToggle({
        hasHostPanel: false,
        canNameSession: false,
        mountedSessionId: undefined,
        boundSessionId: null,
      }),
    ).toEqual({ kind: "reveal", sessionId: null });
  });
});

describe("panelToggleTitle", () => {
  it("names the fold it opens and the close it performs", () => {
    expect(panelToggleTitle(false, "/srv/demo")).toBe("Open the dsh side panel on /srv/demo");
    expect(panelToggleTitle(true, "/srv/demo")).toBe("Close the dsh side panel");
  });
});

describe("waitForMountedSession", () => {
  function sidebar(initial?: string) {
    let current = initial;
    const listeners = new Set<() => void>();
    return {
      mounted: {
        getSnapshot: (): string | undefined => current,
        subscribe: (listener: () => void): (() => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      select(sessionId: string | undefined): void {
        current = sessionId;
        for (const listener of listeners) listener();
      },
      get listenerCount(): number {
        return listeners.size;
      },
    };
  }

  it("answers at once when the Session is already on screen", async () => {
    const face = sidebar("s-1");
    await expect(waitForMountedSession(face, "s-1")).resolves.toBe(true);
  });

  it("resolves when the shell draws the Session it just selected", async () => {
    const face = sidebar(undefined);
    const waited = waitForMountedSession(face, "s-1", { intervalMs: 10 });
    face.select("s-1");
    await expect(waited).resolves.toBe(true);
    // The subscription is released: a controller snapshot never keeps a
    // finished click alive.
    expect(face.listenerCount).toBe(0);
  });

  it("gives up instead of hanging the button", async () => {
    const face = sidebar(undefined);
    await expect(
      waitForMountedSession(face, "s-1", { timeoutMs: 30, intervalMs: 5 }),
    ).resolves.toBe(false);
    expect(face.listenerCount).toBe(0);
  });
});

describe("noSessionSurfaceError", () => {
  it("raises the same failure the dsh face raises", () => {
    expect(isNoSessionSurfaceError(noSessionSurfaceError())).toBe(true);
  });
});

describe("sessionSurfaceMounted", () => {
  it("is mounted only when the snapshot carries a Session", () => {
    expect(sessionSurfaceMounted({ mounted: { getSnapshot: () => "s-1" } })).toBe(true);
    expect(sessionSurfaceMounted({ mounted: { getSnapshot: () => undefined } })).toBe(false);
  });

  it("answers false when there is no sidebar at all", () => {
    expect(sessionSurfaceMounted(null)).toBe(false);
    expect(sessionSurfaceMounted(undefined)).toBe(false);
  });
});

describe("isNoSessionSurfaceError", () => {
  it("matches the dsh face's no-session write rejection", () => {
    expect(
      isNoSessionSurfaceError(new Error("sidebarRight: no session surface is mounted")),
    ).toBe(true);
    expect(isNoSessionSurfaceError(new Error("openTab failed: boom"))).toBe(false);
    expect(isNoSessionSurfaceError("not an error")).toBe(false);
  });
});

describe("describe", () => {
  it("explains no-session for a folder the reader follows into dsh", () => {
    expect(describeReason("no-session")).toBe(NO_SESSION_SURFACE_NOTE);
  });
});

describe("normalizePath", () => {
  it("collapses duplicate separators and a trailing slash", () => {
    expect(normalizePath("/srv//demo/")).toBe("/srv/demo");
    expect(normalizePath(" /srv/demo ")).toBe("/srv/demo");
    expect(normalizePath("")).toBe("");
  });
});
