/**
 * The shell-link rules (M-159): folder resolution, workspace matching, session
 * binding, and the open plan's `hostPanel` feature detection. All pure — the
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
  planSidebarOpen,
  sessionSurfaceMounted,
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

describe("planSidebarOpen", () => {
  it("opens the tab in the Workspace's Session, in place, with card C deployed", () => {
    expect(
      planSidebarOpen({ hasHostPanel: true, boundSessionId: "s-1", mountedSessionId: "s-other", tabKind: "files" }),
    ).toEqual({ kind: "openTab", tabKind: "files", sessionId: "s-1" });
  });

  it("keeps the plain on-screen open when the bound Session is the mounted one", () => {
    expect(
      planSidebarOpen({ hasHostPanel: true, boundSessionId: "s-1", mountedSessionId: "s-1", tabKind: "terminal" }),
    ).toEqual({ kind: "openTab", tabKind: "terminal", sessionId: undefined });
  });

  it("falls back to dropping the main panel first without hostPanel", () => {
    expect(
      planSidebarOpen({ hasHostPanel: false, boundSessionId: "s-1", mountedSessionId: undefined, tabKind: "files" }),
    ).toEqual({ kind: "fallback", tabKind: "files", selectFirst: true, sessionId: "s-1" });
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
