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
 * The route page boots the island but never installs the Files/Terminal
 * bridge — that wiring lives in dsh's `apply`, which the harness does not run.
 * This page does it directly, with the faces M-159 tests need:
 *
 * - `window.__sessionSurfaceMounted` names the session the sidebar's writes
 *   act on; a spec clears it to put the bridge into the no-session state the
 *   real face reaches (M-159: MMX owning the main column). Writes mirror the
 *   real controller: `openTab` and `toggleExpanded` throw there, `openTabIn`
 *   only records.
 * - `/multica/config` answers `workspaceFolder: /srv/demo`, the folder the
 *   harnessed buttons address (the "All projects" default — no project stub).
 * - Every face call is recorded on `window.__stubCalls`, and the opened tabs
 *   render as real DOM (`[data-sidebar-tab]`), so a spec asserts the chosen
 *   open path (`openTab` the on-screen session vs the keep-alive fallback's
 *   `selectPanel(null)` first) against the record, not against internals.
 *
 * `?hostPanel` puts card C's opt-in on the face, which is what makes the
 * open plan take the in-place path instead of the fallback.
 */

declare global {
  interface Window {
    /** The island host, so a spec can wait for the mount instead of a timer. */
    __islandHost?: () => HTMLElement | null;
    /** The mounted session id the sidebar's writes act on; empty means none. */
    __sessionSurfaceMounted?: string;
    /** Every call the stub face made, in order. */
    __stubCalls?: string[];
    /** The tabs the sidebar face opened, as the strip would show them. */
    __stubTabs?: Array<{ sessionId: string; kind: string }>;
  }
}

// The folder the "All projects" default addresses: the buttons read it from
// `/multica/config`, which this stub answers.
installBackend({ workspaceFolder: "/srv/demo" });

const params = new URLSearchParams(window.location.search);
const withHostPanel = params.has("hostPanel");

window.__stubCalls = [];
const calls = window.__stubCalls;

const stub: {
  tabs: Array<{ sessionId: string; kind: string }>;
  expanded: boolean;
} = { tabs: [], expanded: false };
window.__stubTabs = stub.tabs;

const listeners = new Set<() => void>();
function trigger(): void {
  for (const listener of listeners) listener();
}

const mounted = {
  getSnapshot: (): string | undefined =>
    (window.__sessionSurfaceMounted ?? "").trim() || undefined,
  subscribe: (): (() => void) => () => {},
};

const sidebarRight = {
  mounted,
  openTab(kind: string): void {
    const sessionId = mounted.getSnapshot();
    if (sessionId === undefined) {
      throw new Error("sidebarRight: no session surface is mounted");
    }
    calls.push(`openTab ${kind}`);
    stub.tabs.push({ sessionId, kind });
    trigger();
  },
  openTabIn(sessionId: string, kind: string): void {
    // The real face no-ops for a session whose store it never adopted, so the
    // record is the only observable here — and the record is the point.
    calls.push(`openTabIn ${sessionId} ${kind}`);
    stub.tabs.push({ sessionId, kind });
    trigger();
  },
  isExpanded(): boolean {
    return stub.expanded;
  },
  toggleExpanded(): void {
    const sessionId = mounted.getSnapshot();
    if (sessionId === undefined) {
      throw new Error("sidebarRight: no session surface is mounted");
    }
    calls.push("toggleExpanded");
    stub.expanded = !stub.expanded;
    trigger();
  },
} as unknown as SidebarRightLike;

if (withHostPanel) {
  sidebarRight.hostPanel = (panelId: string): (() => void) => {
    calls.push(`hostPanel ${panelId}`);
    return () => calls.push(`hostPanel-release ${panelId}`);
  };
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
  selectPanel: (panelId: string | null): void => {
    calls.push(`selectPanel:${panelId ?? "null"}`);
    trigger();
  },
});

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

// The session the sidebar's writes act on; a spec clears this to reproduce
// the M-159 no-session state.
window.__sessionSurfaceMounted = "s-1";

// The board: the page whose header slot carries the buttons.
const Seat = createSeatComponent(createElement as never, {
  panelId: "multica",
  route: BOARD_ROUTE,
});
createRoot(main).render(createElement(Seat as never));

// The stub's strip lives OUTSIDE the island's container: `createRoot(main)`
// clears the container, so a sibling inside `main` would be detached before
// the stub could render into it.
const sidebar = document.createElement("div");
sidebar.id = "dsh-sidebar";
document.body.append(sidebar);

/** The stub's strip: the session surface state and the tabs it opened. */
function StubStrip() {
  const [, setTick] = useState(0);
  useEffect(() => {
    listeners.add(() => setTick((tick) => tick + 1));
    return () => {
      listeners.clear();
    };
  }, []);
  const sessionId = mounted.getSnapshot();
  return createElement(
    "div",
    {
      "data-sidebar": "",
      "data-session": sessionId ?? "",
      ...(stub.expanded ? { "data-sidebar-expanded": "" } : {}),
    },
    stub.tabs.map((tab, index) =>
      createElement("span", {
        key: index,
        "data-sidebar-tab": tab.kind,
        "data-tab-session": tab.sessionId,
      }),
    ),
  );
}

createRoot(sidebar).render(createElement(StubStrip));
