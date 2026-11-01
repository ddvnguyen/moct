import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachIsland,
  detachIsland,
  isIslandAttached,
  isIslandMounted,
  islandHost,
  mountIsland,
  resetIsland,
  startIsland,
  unmountIsland,
} from "../src/client/island";
import { shadowStyles } from "../src/client/popup-seat";
import { BOARD_ROUTE, type IslandRoute } from "../src/client/navigation";
import { attachSeat } from "../src/client/seat";
import { useModalStore } from "../src/fork";
import { resetIslandConfig } from "../src/client/config";
import { zoomStore } from "../src/client/zoom-store";

// The agent list virtualizes its rows; jsdom has no scroll viewport, so render
// the complete row set while keeping the real list and detail components.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 64,
        end: (index + 1) * 64,
        size: 64,
      })),
    getTotalSize: () => count * 64,
  }),
}));

/**
 * The island is a second React tree inside a shadow root, so these tests drive
 * it the way the shell does: mount into a host element and read the shadow DOM
 * back. The API is a stub in front of the `/multica` proxy path — the proxy's
 * own forwarding is covered in `proxy.test.ts`.
 */

const requests: string[] = [];
/** Each request with the headers it carried, for the workspace-slug contract. */
const calls: Array<{ url: string; headers: Record<string, string> }> = [];
const mounted: HTMLElement[] = [];

afterEach(() => {
  // The island owns listeners and a live WebSocket; leaving one mounted would
  // leak that work into the next test in this file. `resetIsland` also covers
  // the keep-alive host, which the seat tests create outside `mounted`.
  for (const host of mounted.splice(0)) unmountIsland(host);
  resetIsland();
  document.body.replaceChildren();
  requests.length = 0;
  calls.length = 0;
  // The host config is read once per page; these tests are many pages.
  resetIslandConfig();
  vi.unstubAllGlobals();
});

/** Request headers, lower-cased: `Headers` normalizes names, an object does not. */
function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const WORKSPACE = {
  id: "ws-1",
  slug: "demo",
  name: "Demo",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const ISSUE = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "ws-1",
  number: 1,
  identifier: "MUL-1",
  title: "Fix the rail row",
  description: null,
  status: "todo",
  priority: "medium",
  assignee_type: null,
  assignee_id: null,
  creator_type: "member",
  creator_id: "user-1",
  parent_issue_id: null,
  project_id: null,
  position: 1000,
  stage: null,
  start_date: null,
  due_date: null,
  metadata: {},
  properties: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const AGENT = {
  id: "agent-1",
  workspace_id: "ws-1",
  runtime_id: "runtime-1",
  name: "Test agent",
  description: "",
  instructions: "",
  avatar_url: null,
  runtime_mode: "local",
  runtime_config: {},
  custom_args: [],
  visibility: "workspace",
  permission_mode: "public_to",
  invocation_targets: [{ target_type: "workspace", target_id: null }],
  status: "idle",
  max_concurrent_tasks: 1,
  model: "",
  owner_id: "user-1",
  skills: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  archived_at: null,
  archived_by: null,
};

function stubBackend(
  options: {
    workspaces?: unknown[];
    problem?: string | null;
    issues?: unknown[];
    agents?: unknown[];
    /** Host-configured slug; `""` is an unconfigured host. */
    workspaceSlug?: string;
    projects?: unknown[];
  } = {},
) {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push(url);
    calls.push({ url, headers: headerRecord(init) });
    if (url.startsWith("/multica/config")) {
      return json({
        wsPath: "/multica/ws",
        // One workspace (M-173): the configured slug is the only source, so
        // the stub defaults to the workspace it serves.
        workspaceSlug: options.workspaceSlug ?? WORKSPACE.slug,
        problem: options.problem ?? null,
      });
    }
    if (url.startsWith("/multica/api/workspaces")) {
      return json(options.workspaces ?? [WORKSPACE]);
    }
    if (url.startsWith("/multica/api/projects")) {
      return json({ projects: options.projects ?? [] });
    }
    if (url.startsWith("/multica/api/me")) {
      return json({ id: "user-1", name: "Ada", email: "ada@example.test" });
    }
    // The memory seam the settings page reads through the host's /moct prefix.
    if (url.startsWith("/moct/status")) {
      return json({ ok: true, schema: 8, reachable: true });
    }
    if (url.startsWith("/moct/team/v1/memory/usage")) {
      return json({
        workspaceId: "multica:ws:ws-1",
        capTokens: 1200,
        injectLayerTokens: { min: 200, max: 4000 },
        homes: [
          { home: "team:demo", usedTokens: 640, records: 3, blockedPending: 1, largest: [] },
        ],
      });
    }
    // The record list the Memory tab opens on: one pending rule, which is what
    // a worker's write looks like before a human approves it.
    if (url.startsWith("/moct/team/v1/memory?")) {
      return json({
        results: [
          {
            id: "mem_1",
            workspaceId: "multica:ws:ws-1",
            type: "rule",
            title: "Always run the package suite",
            body: "Run the package suite before pushing.",
            home: { kind: "expert", ref: "multica:agent:agent-1" },
            tags: [{ kind: "expert", ref: "multica:agent:agent-1" }],
            status: "pending",
            authorKind: "member",
            authorId: "multica:agent:agent-1",
            version: 1,
            tokens: 12,
            createdAt: "2026-10-27T10:00:00Z",
            updatedAt: "2026-10-27T10:00:00Z",
          },
        ],
        total: 1,
        nextCursor: null,
      });
    }
    if (url.startsWith("/moct/team/v1/memory/get")) {
      return json({ records: [], missing: ["mem_1"] });
    }
    if (url.startsWith("/moct/team/v1/memory/mem_1/versions")) {
      return json({ versions: [] });
    }
    if (url.startsWith("/multica/api/issues/grouped")) {
      return json({
        groups: [
          {
            id: "none",
            assignee_type: null,
            assignee_id: null,
            issues: options.issues ?? [],
            total: (options.issues ?? []).length,
          },
        ],
      });
    }
    if (url.startsWith("/multica/api/issues")) {
      const single = options.issues?.length === 1 ? options.issues[0] : null;
      if (single !== null && !url.includes("/comments") && /issues\/[^/?]+$/.test(url.split("?")[0] ?? "")) {
        return json(single);
      }
      return json({ issues: options.issues ?? [], total: (options.issues ?? []).length, comments: [] });
    }
    if (
      url.startsWith("/multica/api/pins") ||
      url.startsWith("/multica/api/projects") ||
      url.startsWith("/multica/api/issue-statuses") ||
      url.startsWith("/multica/api/labels")
    ) {
      return json([]);
    }
    if (url.includes("/agents")) {
      return json(options.agents ?? []);
    }
    if (url.includes("assignee-frequency") || url.includes("/members")) {
      return json([]);
    }
    // Object-shaped singletons the board reads on mount.
    if (url.startsWith("/multica/api/config") || url.startsWith("/multica/api/onboarding")) {
      return json({});
    }
    // Everything else the fork reads on mount is a list; an empty list is the
    // shape those queries parse, so one entry keeps the page rendering instead
    // of tripping over a `{}` that no `.map` accepts.
    return json([]);
  });
  vi.stubGlobal("fetch", handler);
  return handler;
}

function hostElement(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mounted.push(host);
  return host;
}

/** A `main` cell: an empty element the shell hands the island. */
function seatElement(): HTMLElement {
  const seat = document.createElement("div");
  document.body.append(seat);
  return seat;
}

/**
 * The island's portal container, wherever the seat currently keeps it.
 *
 * It lives in a seat outside the panel — and each seat hides it in its own
 * shadow root, which a document selector cannot see through.
 */
function portalHostElement(): HTMLElement | null {
  for (const seat of document.querySelectorAll<HTMLElement>("[data-multica-popup-seat]")) {
    const portals = seat.shadowRoot?.querySelector<HTMLElement>("[data-multica-portals]");
    if (portals !== null && portals !== undefined) return portals;
  }
  return null;
}

function configRequests(): string[] {
  return requests.filter((url) => url.startsWith("/multica/config"));
}

/** The dialog the modal store opened, wherever the seat keeps it. */
function dialogElement(): Element | null {
  return portalHostElement()?.querySelector("[role='dialog']") ?? null;
}

async function settle(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
  }
  assertion();
}

describe("shadowStyles", () => {
  it("retargets the fork's :root tokens at the shadow host", () => {
    expect(shadowStyles(':root { --background: red; }\n.foo:rootbar { color: red }')).toBe(
      ':host { --background: red; }\n.foo:rootbar { color: red }',
    );
  });
});

describe("mountIsland", () => {
  it("renders the fork's board inside its own shadow root", async () => {
    stubBackend();
    const host = hostElement();
    act(() => mountIsland(host));

    const shadow = host.shadowRoot;
    expect(shadow).not.toBeNull();
    expect(shadow?.querySelector("style[data-multica-styles]")).not.toBeNull();
    expect(shadow?.querySelector("[data-multica-root]")).not.toBeNull();
    // No pages and no popups: overlays render in the seat, outside this shadow
    // root, or Base UI cannot tell an outside press from an inside one.
    expect(shadow?.querySelector("[data-multica-portals]")).toBeNull();
    expect(portalHostElement()).not.toBeNull();

    // Styles are shadow-local: the document itself carries no island sheet.
    expect(document.querySelector("style[data-multica-styles]")).toBeNull();

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").not.toContain("Connecting to Multica");
      expect(host.shadowRoot?.textContent ?? "").not.toContain("did not start");
    });

    // The workspace resolved from the stub backend and the board mounted under
    // the panel's own chrome: a page header plus the view's own filter row.
    await settle(() => {
      const text = host.shadowRoot?.textContent ?? "";
      expect(text).toContain("Issues");
    });
    expect(requests.some((url) => url.startsWith("/multica/api/workspaces"))).toBe(true);
  });

  // Every page load used to open with a burst of 400s: the pages and the
  // unread reporter queried from their own effects, before the gate's effect
  // had told the API client which workspace it speaks as (M-198).
  it("stamps every workspace-scoped request with the slug from the first frame", async () => {
    stubBackend();
    const host = hostElement();
    act(() => mountIsland(host));

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").toContain("Issues");
    });

    // Reads that legitimately carry no slug: the caller's identity, the
    // workspace list that resolves the slug, and `/api/config`, a public route
    // outside the workspace middleware (`server/cmd/server/router.go:1527`).
    // Everything else the panel asks for is scoped by the slug, and the server
    // answers 400 without it.
    const scoped = calls.filter(
      (call) =>
        call.url.startsWith("/multica/api/") &&
        !call.url.startsWith("/multica/api/workspaces") &&
        !call.url.startsWith("/multica/api/me") &&
        !call.url.startsWith("/multica/api/config"),
    );
    expect(scoped.length).toBeGreaterThan(0);
    expect(
      scoped
        .filter((call) => call.headers["x-workspace-slug"] === undefined)
        .map((call) => call.url),
    ).toEqual([]);
  });

  it("renders one issue from the backend inside the panel", async () => {
    stubBackend({ issues: [ISSUE] });
    const host = hostElement();
    act(() => mountIsland(host, { initialRoute: { view: "issue", issueId: ISSUE.identifier } }));

    await settle(() => {
      const text = host.shadowRoot?.textContent ?? "";
      expect(text).toContain(ISSUE.identifier);
      expect(text).toContain(ISSUE.title);
    });
    expect(requests.some((url) => url.includes("issues"))).toBe(true);
  });

  it("keeps an agent route when its real Settings tab updates the view query", async () => {
    stubBackend({ agents: [AGENT] });
    const host = hostElement();
    act(() =>
      mountIsland(host, {
        initialRoute: { view: "agents" },
      }),
    );

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").toContain(AGENT.name);
    });

    const agentName = [...(host.shadowRoot?.querySelectorAll("span") ?? [])].find(
      (span) => span.textContent?.trim() === AGENT.name,
    );
    expect(agentName).toBeDefined();
    act(() => agentName?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })));

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").toContain("Assign work");
    });

    const settingsTab = [...(host.shadowRoot?.querySelectorAll<HTMLButtonElement>("[role='tab']") ?? [])].find(
      (tab) => tab.textContent?.trim() === "Settings",
    );
    expect(settingsTab).toBeDefined();
    act(() => settingsTab?.click());

    await settle(() => {
      const persisted = localStorage.getItem("multica.dsh.tabs.v1");
      expect(persisted).not.toBeNull();
      const state = JSON.parse(persisted ?? "{}").state as {
        tabs: Array<{ id: string; url: string }>;
        activeId: string;
      };
      const active = state.tabs.find((tab) => tab.id === state.activeId);
      expect(active?.url).toBe(`/demo/agents/${AGENT.id}?view=general`);
    });
  });

  // One row per rail entry: the island has to render each of the five views on
  // its own, inside the same shadow root, with nothing page-level in the shell.
  const entries: Array<{ entry: string; route: IslandRoute; text: string }> = [
    { entry: "issues", route: BOARD_ROUTE, text: "Issues" },
    { entry: "agents", route: { view: "agents" }, text: "Agents" },
    { entry: "skills", route: { view: "skills" }, text: "Skills" },
    { entry: "inbox", route: { view: "inbox" }, text: "Inbox" },
    { entry: "chat", route: { view: "chat" }, text: "Chat" },
    { entry: "settings", route: { view: "settings" }, text: "Settings" },
  ];

  for (const { entry, route, text } of entries) {
    it(`opens the ${entry} entry inside the shadow root`, async () => {
      stubBackend();
      const host = hostElement();
      act(() => mountIsland(host, { initialRoute: route }));

      await settle(() => {
        const rendered = host.shadowRoot?.textContent ?? "";
        expect(rendered).toContain(text);
        expect(rendered).not.toContain("Connecting to Multica");
        expect(rendered).not.toContain("did not start");
      });

      // Native rendering only: no iframe anywhere in the document, and the
      // island's sheet stays inside its own shadow root.
      expect(host.shadowRoot?.querySelector("iframe")).toBeNull();
      expect(document.querySelectorAll("iframe")).toHaveLength(0);
      expect(host.shadowRoot?.querySelector("style[data-multica-styles]")).not.toBeNull();
      expect(document.querySelector("style[data-multica-styles]")).toBeNull();
    });
  }

  it("opens settings with the MOCT group and without the surfaces this panel hides", async () => {
    stubBackend();
    const host = hostElement();
    act(() => mountIsland(host, { initialRoute: { view: "settings" } }));

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").toContain("MOCT");
    });

    const labels = [...(host.shadowRoot?.querySelectorAll("nav a") ?? [])].map((link) =>
      (link.textContent ?? "").trim(),
    );
    // The group this shell adds, in the second sidebar's own group chrome.
    expect(labels).toEqual(expect.arrayContaining(["Memory", "Connection"]));
    // Kept pages stay where the fork put them.
    expect(labels).toEqual(
      expect.arrayContaining(["Profile", "Preferences", "MCP servers"]),
    );
    for (const hidden of [
      "Billing",
      "Code",
      "Messaging",
      "Plugins",
      "Connected apps",
      "Keyboard shortcuts",
    ]) {
      expect(labels).not.toContain(hidden);
    }
  });

  it("renders Preferences without the error boundary, with the panel zoom row", async () => {
    stubBackend();
    const host = hostElement();
    act(() =>
      mountIsland(host, {
        initialRoute: { view: "settings", query: "tab=preferences" },
      }),
    );

    // Before M-154 this page threw: `useLocaleAdapter` had no provider, so the
    // whole tab rendered as the boundary's fallback.
    await settle(() => {
      const text = host.shadowRoot?.textContent ?? "";
      expect(text).toContain("Panel zoom");
      expect(text).toContain("Scales this panel");
      expect(text).not.toContain("Something went wrong displaying this section");
    });
  });

  it("scales the panel surface from the zoom store, without a reload", async () => {
    stubBackend();
    const host = hostElement();
    act(() => mountIsland(host, { initialRoute: BOARD_ROUTE }));

    const surface = () =>
      host.shadowRoot?.querySelector<HTMLElement>("[data-panel-zoom]") ?? null;

    await settle(() => {
      expect(surface()?.dataset.panelZoom).toBe("100");
    });

    act(() => zoomStore.set(125));
    expect(surface()?.dataset.panelZoom).toBe("125");

    // Leave the shared store as the next test expects it.
    act(() => zoomStore.set(100));
  });

  it("reads the memory plane on the MOCT page and nowhere else", async () => {
    stubBackend();
    const host = hostElement();
    act(() =>
      mountIsland(host, {
        initialRoute: { view: "settings", query: "tab=moct-memory" },
      }),
    );

    await settle(() => {
      const text = host.shadowRoot?.textContent ?? "";
      expect(text).toContain("Reachable");
      expect(text).toContain("1200 tokens");
      expect(text).toContain("640 tokens · 3 records");
      expect(text).toContain("1 waiting for approval");
      // ... and the records themselves, which is what S2-D added: the page
      // opens on the queue that needs a human.
      expect(text).toContain("Always run the package suite");
      expect(text).toContain("1 of 1 records");
    });
    expect(requests).toContain("/moct/status");
    expect(requests).toContain("/moct/team/v1/memory/usage");
    const list = requests.find((url) => url.startsWith("/moct/team/v1/memory?"));
    expect(new URLSearchParams(list?.split("?")[1] ?? "").get("status")).toBe("pending");
  });

  it("does not touch the memory plane from another page", async () => {
    stubBackend();
    const host = hostElement();
    act(() => mountIsland(host, { initialRoute: BOARD_ROUTE }));

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").toContain("Issues");
    });
    expect(requests.some((url) => url.startsWith("/moct"))).toBe(false);
  });

  it("explains a host that is not configured instead of rendering an empty page", async () => {
    stubBackend({ problem: "token is not set" });
    const host = hostElement();
    act(() => mountIsland(host));

    await settle(() => {
      const text = host.shadowRoot?.textContent ?? "";
      expect(text).toContain("Multica is not configured");
      expect(text).toContain("token is not set");
    });
  });

  it("reports a token that cannot see a workspace", async () => {
    stubBackend({ workspaces: [] });
    const host = hostElement();
    act(() => mountIsland(host));

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").toContain("No Multica workspace");
    });
  });

  // M-173: the island is one workspace. A host slug the token cannot read is
  // an error to show, never an invitation to open the next workspace the token
  // happens to see — that would render another tenant's data under this header.
  it("does not fall back to another workspace when the configured slug is unreadable", async () => {
    stubBackend({
      workspaceSlug: "missing",
      workspaces: [
        WORKSPACE,
        { ...WORKSPACE, id: "ws-2", slug: "other", name: "Other" },
      ],
    });
    const host = hostElement();
    act(() => mountIsland(host));

    await settle(() => {
      const text = host.shadowRoot?.textContent ?? "";
      expect(text).toContain("No Multica workspace");
      expect(text).toContain('The configured workspace "missing" is not readable');
      // No board, no tabs: the fallback workspace is never mounted.
      expect(text).not.toContain("Issues");
    });
  });

  it("detaches the island when the rail moves away, without tearing it down", async () => {
    stubBackend();
    const seat = seatElement();

    act(() => attachSeat(seat, BOARD_ROUTE));
    const host = islandHost();
    expect(host).not.toBeNull();
    expect(host?.parentElement).toBe(seat);
    await settle(() => {
      expect(host?.shadowRoot?.textContent ?? "").toContain("Issues");
    });
    const configCalls = configRequests();

    // The shell detaches the ref before it removes the node, so the sweep runs a
    // microtask later — after the commit — and only for a node that really left.
    await act(async () => {
      seat.remove();
      attachSeat(null, BOARD_ROUTE);
    });

    // Out of the document, still built: the tree, the query cache and the
    // socket are exactly what the next click reuses instead of paying again.
    expect(isIslandAttached()).toBe(false);
    expect(host?.isConnected).toBe(false);
    expect(isIslandMounted(host as HTMLElement)).toBe(true);
    expect(configRequests()).toHaveLength(configCalls.length);
    expect(host?.shadowRoot?.querySelector("[data-multica-root]")).not.toBeNull();
  });

  it("moves the same island into the next seat and opens that entry", async () => {
    stubBackend();
    const issues = seatElement();
    const agents = seatElement();

    act(() => attachSeat(issues, BOARD_ROUTE));
    await settle(() => {
      expect(islandHost()?.shadowRoot?.textContent ?? "").toContain("Issues");
    });
    const host = islandHost() as HTMLElement;
    const configCalls = configRequests();

    await act(async () => {
      issues.remove();
      attachSeat(null, BOARD_ROUTE);
      attachSeat(agents, { view: "agents" });
    });

    // Same host element, same React root: the panel moved rather than rebuilt.
    expect(islandHost()).toBe(host);
    expect(host.parentElement).toBe(agents);
    expect(host.isConnected).toBe(true);
    expect(configRequests()).toHaveLength(configCalls.length);
    await settle(() => {
      const text = host.shadowRoot?.textContent ?? "";
      expect(text).toContain("Agents");
      expect(text).not.toContain("Connecting to Multica");
    });
  });

  it("keeps a seat attached across a re-render", async () => {
    stubBackend();
    const seat = seatElement();

    act(() => {
      attachSeat(seat, BOARD_ROUTE);
      // A re-render detaches and re-attaches the same node; the node never left
      // the document, so nothing may be torn down.
      attachSeat(null, BOARD_ROUTE);
      attachSeat(seat, BOARD_ROUTE);
    });
    await act(async () => {});
    expect(isIslandAttached()).toBe(true);
    expect(islandHost()?.parentElement).toBe(seat);
  });

  it("presses outside once on detach, and only when something is open", async () => {
    stubBackend();
    const seat = seatElement();
    act(() => attachSeat(seat, BOARD_ROUTE));
    const host = islandHost() as HTMLElement;
    const portals = portalHostElement();
    expect(portals).not.toBeNull();
    // The portal container is not in the panel: it renders into the seat, which
    // is what makes a detach lose it unless the press below happens.
    expect(host.shadowRoot?.querySelector("[data-multica-portals]")).toBeNull();

    const presses: string[] = [];
    const record = (event: Event): void => {
      presses.push(event.type);
    };
    document.body.addEventListener("pointerdown", record);

    // Nothing portalled: a detach must not reach the shell's own dismiss layers.
    await act(async () => {
      seat.remove();
      attachSeat(null, BOARD_ROUTE);
    });
    expect(presses).toEqual([]);

    // A popup is not a child of the panel, so leaving would leave it on screen
    // over the next panel; the synthetic outside press is what closes it.
    act(() => attachSeat(seat, BOARD_ROUTE));
    act(() => portals?.appendChild(document.createElement("div")));
    await act(async () => {
      seat.remove();
      attachSeat(null, BOARD_ROUTE);
    });
    expect(presses).toEqual(["pointerdown"]);
    document.body.removeEventListener("pointerdown", record);
  });

  it("is idempotent per host and tears down cleanly", async () => {
    stubBackend();
    const host = hostElement();
    act(() => mountIsland(host));
    expect(isIslandMounted(host)).toBe(true);
    act(() => mountIsland(host));
    expect(host.shadowRoot?.querySelectorAll("[data-multica-root]")).toHaveLength(1);

    act(() => unmountIsland(host));
    expect(isIslandMounted(host)).toBe(false);
    expect(host.shadowRoot?.childNodes.length).toBe(0);
  });

  it("builds one island for the page and hands it to every seat", async () => {
    stubBackend();
    const first = seatElement();
    const second = seatElement();

    act(() => attachSeat(first, BOARD_ROUTE));
    const host = islandHost();
    act(() => attachSeat(second, { view: "inbox" }));
    expect(islandHost()).toBe(host);
    expect(host?.parentElement).toBe(second);
    // One config read for the whole page, however many seats come and go.
    expect(configRequests()).toHaveLength(1);
  });
});

describe("popup seat", () => {
  function overlayLayer(): HTMLElement {
    const layer = document.createElement("div");
    layer.dataset.shellOverlay = "";
    document.body.append(layer);
    return layer;
  }

  it("seats the island's portals in the shell's overlay layer", async () => {
    stubBackend();
    const layer = overlayLayer();
    const host = hostElement();
    act(() => mountIsland(host));

    const seat = layer.querySelector<HTMLElement>("[data-multica-popup-seat]");
    expect(seat).not.toBeNull();
    // Zero-size, inert, above the app layer: the shell's own overlay-layer
    // pattern, so the seat itself blocks nothing and steals no clicks.
    expect(seat?.style.position).toBe("absolute");
    expect(seat?.style.width).toBe("0px");
    expect(seat?.style.height).toBe("0px");
    expect(seat?.style.zIndex).toBe("60");
    expect(seat?.style.pointerEvents).toBe("none");

    // The portal container lives inside the seat's shadow root — outside the
    // panel's stacking context, still under the island's stylesheet.
    const seatShadow = seat?.shadowRoot;
    expect(seatShadow?.querySelector("style[data-multica-styles]")).not.toBeNull();
    const portalHost = seatShadow?.querySelector("[data-multica-portals]");
    expect(portalHost).not.toBeNull();
    expect(portalHost?.parentNode).toBe(seatShadow);

    // One portal seat: the panel's own shadow root keeps the page, not the
    // popups — popups must not render below the shell's overlay layer again.
    expect(host.shadowRoot?.querySelector("[data-multica-portals]")).toBeNull();

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").toContain("Issues");
    });
  });

  it("follows the shell's theme on the seat", async () => {
    stubBackend();
    const layer = overlayLayer();
    const host = hostElement();
    act(() => mountIsland(host));

    const portalHost = layer
      .querySelector("[data-multica-popup-seat]")
      ?.shadowRoot?.querySelector("[data-multica-portals]");
    expect(portalHost?.classList.contains("dark")).toBe(false);

    act(() => {
      document.documentElement.classList.add("dark");
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
    expect(portalHost?.classList.contains("dark")).toBe(true);
    act(() => {
      document.documentElement.classList.remove("dark");
    });
  });

  it("removes the seat from the shell's layer on unmount", async () => {
    stubBackend();
    const layer = overlayLayer();
    const host = hostElement();
    act(() => mountIsland(host));
    expect(layer.querySelector("[data-multica-popup-seat]")).not.toBeNull();

    act(() => unmountIsland(host));
    expect(layer.querySelector("[data-multica-popup-seat]")).toBeNull();
    expect(host.shadowRoot?.childNodes.length).toBe(0);
  });

  it("keeps its own seat on the document when the shell has no overlay layer", async () => {
    stubBackend();
    const host = hostElement();
    act(() => mountIsland(host));

    // No layer to join: the seat covers the viewport itself, so popups land
    // above the panel instead of inside its stacking context. What it must not
    // do is move back into the panel's shadow root — a press inside the island
    // would then read as an outside press Base UI drops (M-148).
    const seat = document.querySelector<HTMLElement>("[data-multica-popup-seat]");
    expect(seat).not.toBeNull();
    expect(seat?.parentElement).toBe(document.body);
    expect(seat?.style.position).toBe("fixed");
    expect(seat?.style.pointerEvents).toBe("none");
    expect(seat?.shadowRoot?.querySelector("[data-multica-portals]")).not.toBeNull();
    expect(host.shadowRoot?.querySelector("[data-multica-portals]")).toBeNull();

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").toContain("Issues");
    });
  });

  it("moves into the shell's overlay layer when it is mounted after warm-up", async () => {
    stubBackend();
    const host = hostElement();
    // Lane z: the plugin warms the island up from a hook and the shell paints
    // its chrome — overlay layer included — a moment later.
    act(() => mountIsland(host));
    const portalHost = portalHostElement();
    expect(portalHost?.getRootNode()).toBe(
      document.querySelector("[data-multica-popup-seat]")?.shadowRoot,
    );
    expect(document.querySelector("[data-multica-popup-seat]")?.parentElement).toBe(document.body);

    const layer = overlayLayer();
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await act(async () => {
      await promise;
    });

    // Same portal container, new home: React's portals follow it, so an open
    // popup is not rebuilt — and the seat now stacks with the shell's overlays.
    const seat = layer.querySelector<HTMLElement>("[data-multica-popup-seat]");
    expect(seat).not.toBeNull();
    expect(seat?.shadowRoot?.querySelector("[data-multica-portals]")).toBe(portalHost);
    // One seat, not two: the document-level one is dropped as the layer takes
    // the container over.
    expect(document.querySelectorAll("[data-multica-popup-seat]")).toHaveLength(1);
  });
});

describe("property registration (M-148)", () => {
  it("registers Tailwind's @property rules on the document, once, outside the shadow root", async () => {
    stubBackend();
    let host!: HTMLElement;
    act(() => {
      host = startIsland(document);
    });

    // Chromium ignores `@property` inside a shadow tree, so the rules the
    // island's border/shadow/ring utilities read are registered on the shell's
    // document instead — from the stylesheet the build compiled, not a copy.
    const style = document.head.querySelector("style[data-multica-properties]");
    expect(style?.textContent ?? "").toMatch(/@property\s+--tw-border-style/);

    // The warm-up and the first rail click both start the island; the document
    // is served once, so nothing stacks.
    act(() => {
      startIsland(document);
    });
    expect(document.querySelectorAll("style[data-multica-properties]")).toHaveLength(1);

    // Still shadow-local where it belongs: the island's own sheet is unchanged.
    expect(host.shadowRoot?.querySelector("style[data-multica-properties]")).toBeNull();
    expect(document.querySelector("style[data-multica-styles]")).toBeNull();
  });
});

describe("modal store", () => {
  /**
   * The fork's pages do not own their dialogs: they call
   * `useModalStore.open(...)` and one component renders whatever it names. The
   * island mounted no such component, so on lane z every dialog — create
   * issue, delete confirm, set parent — was a click that did nothing (M-146).
   */
  it("renders the dialog a page opens, inside the island's shadow root", async () => {
    stubBackend();
    let host!: HTMLElement;
    act(() => {
      host = startIsland(document);
    });
    const seat = seatElement();
    act(() => attachIsland(seat, BOARD_ROUTE));

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").toContain("Issues");
    });

    act(() => useModalStore.getState().open("create-issue"));

    await settle(() => {
      expect(dialogElement()).not.toBeNull();
    });

    // Portalled into the island's own container: the dialog has to be styled by
    // the island's sheet, which the seat's shadow root carries.
    expect(dialogElement()).not.toBeNull();
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(host.shadowRoot?.querySelector("[role='dialog']")).toBeNull();

    act(() => useModalStore.getState().close());
    await settle(() => {
      expect(dialogElement()).toBeNull();
    });
  });

  /**
   * A dialog is a child of the portal container, not of the panel, and Base
   * UI's outside press does not dismiss a modal. Detaching the panel therefore
   * has to close it through the store, or a rail click leaves it open for the
   * next attach.
   */
  it("closes an open dialog when the island is detached", async () => {
    stubBackend();
    let host!: HTMLElement;
    act(() => {
      host = startIsland(document);
    });
    const seat = seatElement();
    act(() => attachIsland(seat, BOARD_ROUTE));

    await settle(() => {
      expect(host.shadowRoot?.textContent ?? "").toContain("Issues");
    });

    act(() => useModalStore.getState().open("create-issue"));
    await settle(() => {
      expect(dialogElement()).not.toBeNull();
    });

    act(() => detachIsland());
    expect(isIslandAttached()).toBe(false);
    expect(useModalStore.getState().modal).toBeNull();

    act(() => attachIsland(seat, BOARD_ROUTE));
    await settle(() => {
      expect(dialogElement()).toBeNull();
    });
  });
});
