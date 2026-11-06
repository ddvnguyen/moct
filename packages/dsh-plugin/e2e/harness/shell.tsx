import { createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { islandHost } from "../../src/client/island";
import { createSeatComponent } from "../../src/client/seat";
import { BOARD_ROUTE } from "../../src/client/navigation";
import { configureHostShell } from "../../src/client/shell-runtime";
import type {
  SessionsLike,
  SidebarRightLike,
  WorkspacesLike,
} from "../../src/client/shell-link";
import { installBackend } from "./backend";

/**
 * M-159 harness: the board island against a stub shell bridge.
 *
 * The route page boots the island but never installs the side-panel bridge —
 * that wiring lives in dsh's `apply`, which the harness does not run. This page
 * does it directly, with the faces M-159 tests need:
 *
 * - `window.__sessionSurfaceMounted` names the Session the Sidebar draws for; a
 *   spec clears it to put the bridge into the state a host without card C's
 *   `hostPanel` reaches (MMX owning the main column). `toggleExpanded` throws
 *   there, exactly as the real controller does.
 * - `/multica/config` answers `workspaceFolder: /srv/demo`, the folder the
 *   harnessed toggle addresses (the "All projects" default — no project stub);
 *   `?noFolder` answers an empty one instead.
 * - Every face call is recorded on `window.__stubCalls`, and the shown state
 *   renders as real DOM (`[data-sidebar-expanded]`), so a spec asserts the
 *   chosen path (`toggle` in place vs `reveal` the folder's Session first)
 *   against the record, not against internals.
 * - `selectSession` mirrors the shell's navigation: it names that Session the
 *   on-screen one and notifies the `mounted` subscribers, which is what a
 *   reveal waits on before it opens the column.
 *
 * `?hostPanel` puts card C on the face — the `hostPanel` opt-in and
 * `selectHostedSession` — which is what lets a press name the project's Session
 * and flip the column in place instead of revealing a Session. `?noName` leaves
 * only `hostPanel` on the face, the card C build before naming shipped;
 * `?otherSession` starts on a Session from another Workspace, so a press has to
 * retarget before it opens. `?noSurface` starts with no Session on screen, so a
 * press has to bring the bound one up first; `?noReveal` adds a shell whose
 * navigation never draws it, which is the timeout the press reports.
 */

declare global {
  interface Window {
    /** The island host, so a spec can wait for the mount instead of a timer. */
    __islandHost?: () => HTMLElement | null;
    /** The mounted session id the sidebar's writes act on; empty means none. */
    __sessionSurfaceMounted?: string;
    /** Every call the stub face made, in order. */
    __stubCalls?: string[];
  }
}

const params = new URLSearchParams(window.location.search);
const withHostPanel = params.has("hostPanel");
const withoutName = params.has("noName");
const onAnotherWorkspace = params.has("otherSession");
const withoutSurface = params.has("noSurface");
const withoutFolder = params.has("noFolder");
// A shell that records the navigation but never draws the Session it was asked
// for: the reveal's timeout, and the copy a press reports when it gives up.
const withoutReveal = params.has("noReveal");

// The folder the "All projects" default addresses: the toggle reads it from
// `/multica/config`, which this stub answers.
installBackend({ workspaceFolder: withoutFolder ? "" : "/srv/demo" });

window.__stubCalls = [];
const calls = window.__stubCalls;

const stub = { expanded: false };

const listeners = new Set<() => void>();
function trigger(): void {
  for (const listener of listeners) listener();
}

const mounted = {
  getSnapshot: (): string | undefined =>
    (window.__sessionSurfaceMounted ?? "").trim() || undefined,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

const sidebarRight = {
  mounted,
  isExpanded: (): boolean => stub.expanded,
  toggleExpanded(): void {
    if (mounted.getSnapshot() === undefined) {
      throw new Error("sidebarRight: no session surface is mounted");
    }
    calls.push("toggleExpanded");
    stub.expanded = !stub.expanded;
    trigger();
  },
  expanded: {
    getSnapshot: (): boolean => stub.expanded,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  },
} as unknown as SidebarRightLike;

if (withHostPanel) {
  sidebarRight.hostPanel = (panelId: string): (() => void) => {
    calls.push(`hostPanel ${panelId}`);
    return () => { calls.push(`hostPanel-release ${panelId}`); };
  };
  if (!withoutName) {
    // The hosted column is drawn for the named Session, exactly as the real
    // controller names it: the stub moves its on-screen Session with the name.
    sidebarRight.selectHostedSession = (sessionId: string): (() => void) => {
      calls.push(`selectHostedSession ${sessionId}`);
      if (!withoutReveal) window.__sessionSurfaceMounted = sessionId;
      trigger();
      return () => { calls.push(`selectHostedSession-release ${sessionId}`); };
    };
  }
}

const workspaces: WorkspacesLike = {
  list: {
    getSnapshot: () => ({
      items: [{ workspaceId: "w-1", path: "/srv/demo", sessionIds: ["s-1"] }],
    }),
    subscribe: (): (() => void) => () => {},
  },
  create: async (input): Promise<{ workspaceId: string; path: string; sessionIds: string[] }> => {
    calls.push(`workspaces:create ${input.path}`);
    return { workspaceId: "w-1", path: input.path, sessionIds: [] };
  },
};

const sessions: SessionsLike = {
  list: {
    getSnapshot: () => ({ byId: { "s-1": { id: "s-1" } } }),
    subscribe: (): (() => void) => () => {},
  },
  create: async (opts): Promise<string> => {
    calls.push(`sessions:create ${opts?.workspaceId ?? ""}`);
    return "s-new";
  },
};

configureHostShell({
  sidebarRight,
  workspaces,
  sessions,
  daemonId: "",
  selectSession: (sessionId: string): void => {
    calls.push(`selectSession ${sessionId}`);
    if (!withoutReveal) window.__sessionSurfaceMounted = sessionId;
    trigger();
  },
});

// The session the sidebar's writes act on; a spec clears this to reproduce
// the no-session state a host without `hostPanel` reaches.
window.__sessionSurfaceMounted = withoutSurface
  ? ""
  : onAnotherWorkspace
    ? "s-9"
    : "s-1";

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font-family: sans-serif; }
  #main { display: flex; flex-direction: column; height: 100vh; }
  #dsh-sidebar { padding: 8px; border-top: 1px solid #ccc; }
`;
document.head.append(style);

const main = document.createElement("div");
main.id = "main";
document.body.append(main);

window.__islandHost = islandHost;

// The board: the page whose header slot carries the toggle.
const Seat = createSeatComponent(createElement as never, {
  panelId: "multica",
  route: BOARD_ROUTE,
});
createRoot(main).render(createElement(Seat as never));

// The stub's column lives OUTSIDE the island's container: `createRoot(main)`
// clears the container, so a sibling inside `main` would be detached before
// the stub could render into it.
const sidebar = document.createElement("div");
sidebar.id = "dsh-sidebar";
document.body.append(sidebar);

/** The stub's column: the Session it draws for and whether it is shown. */
function StubSidebar() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = (): void => setTick((tick) => tick + 1);
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);
  const sessionId = mounted.getSnapshot();
  return createElement(
    "div",
    {
      "data-sidebar": "",
      "data-session": sessionId ?? "",
      ...(stub.expanded ? { "data-sidebar-expanded": "" } : {}),
    },
  );
}

createRoot(sidebar).render(createElement(StubSidebar));
