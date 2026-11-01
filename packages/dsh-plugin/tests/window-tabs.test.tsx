import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DshLayout } from "../src/dsh";
import { resetIsland, unmountIsland, islandHost } from "../src/client/island";
import { attachSeat } from "../src/client/seat";
import { bindShell } from "../src/client/shell";
import { familyOfRoute } from "../src/client/tabs";
import { MULTICA_ENTRIES } from "../src/client/index";
import type { IslandRoute } from "../src/client/navigation";

/**
 * The island's own window, rendered: one tab strip across the six views, one
 * history behind Back/Forward, and the shell's rail kept on the tab that is
 * showing (M-197).
 *
 * Driven the way the shell drives it — a seat claims the island, and the rail
 * moves it to the next seat — because the strip is only meaningful while a seat
 * holds it.
 */

const requests: string[] = [];

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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubBackend(): void {
  const handler = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push(url);
    if (url.startsWith("/multica/config")) {
      return json({ wsPath: "/multica/ws", workspaceSlug: WORKSPACE.slug, problem: null });
    }
    if (url.startsWith("/multica/api/workspaces")) return json([WORKSPACE]);
    if (url.startsWith("/multica/api/me")) {
      return json({ id: "user-1", name: "Ada", email: "ada@example.test" });
    }
    if (url.startsWith("/multica/api/issues/grouped")) {
      return json({
        groups: [
          { id: "none", assignee_type: null, assignee_id: null, issues: [ISSUE], total: 1 },
        ],
      });
    }
    if (url.startsWith("/multica/api/issues")) {
      if (!url.includes("/comments") && /issues\/[^/?]+$/.test(url.split("?")[0] ?? "")) {
        return json(ISSUE);
      }
      return json({ issues: [ISSUE], total: 1, comments: [] });
    }
    if (
      url.startsWith("/multica/api/pins") ||
      url.startsWith("/multica/api/projects") ||
      url.startsWith("/multica/api/issue-statuses") ||
      url.startsWith("/multica/api/labels") ||
      url.startsWith("/multica/api/config") ||
      url.startsWith("/multica/api/onboarding")
    ) {
      return json([]);
    }
    return json([]);
  });
  vi.stubGlobal("fetch", handler);
}

const PANEL_OF_FAMILY = new Map(
  MULTICA_ENTRIES.map((entry) => [familyOfRoute(entry.route), entry.id]),
);

/** The shell's layout service, recording what the island asked it to select. */
function fakeLayout() {
  let activePanelId: string | null = null;
  const selected: string[] = [];
  const layout: DshLayout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId }),
      subscribe: () => () => {},
    },
    selectPanel(panelId) {
      activePanelId = panelId;
      if (panelId !== null) selected.push(panelId);
    },
    toggleSidebar() {},
  };
  return { layout, selected };
}

function seatElement(): HTMLElement {
  const seat = document.createElement("div");
  document.body.append(seat);
  return seat;
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

/** The strip's tab buttons, in order. */
function stripTabs(host: HTMLElement): HTMLButtonElement[] {
  return [...(host.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-tab-strip] button") ?? [])];
}

/** The name of the tab the strip marks as showing. */
function activeTabName(host: HTMLElement): string | null {
  const active = host.shadowRoot?.querySelector("[data-tab-strip] button[data-active]");
  return active === null || active === undefined
    ? null
    : (active.textContent ?? "").replace("×", "").trim();
}

function shadowText(host: HTMLElement): string {
  return host.shadowRoot?.textContent ?? "";
}

/** Move the island to the next rail row, the way the shell does. */
async function moveSeat(
  from: HTMLElement,
  to: HTMLElement,
  route: IslandRoute,
): Promise<void> {
  await act(async () => {
    from.remove();
    attachSeat(null, route);
    attachSeat(to, route);
  });
}

afterEach(() => {
  const host = islandHost();
  if (host !== null) unmountIsland(host);
  resetIsland();
  bindShell(null);
  document.body.replaceChildren();
  requests.length = 0;
  vi.unstubAllGlobals();
});

describe("the island's tab strip (M-197)", () => {
  it("names an issue tab M-1 with the full title in its tooltip", async () => {
    stubBackend();
    bindShell({ layout: fakeLayout().layout, panelOfFamily: PANEL_OF_FAMILY });
    const seat = seatElement();
    act(() => attachSeat(seat, { view: "issue", issueId: "MUL-1" }));

    const host = islandHost() as HTMLElement;
    await settle(() => {
      expect(shadowText(host)).toContain(ISSUE.title);
    });

    const tabs = stripTabs(host);
    expect(tabs.map((tab) => tab.textContent?.replace("×", "").trim())).toEqual(["MUL-1"]);
    expect(tabs[0]?.getAttribute("title")).toBe(`${ISSUE.identifier}: ${ISSUE.title}`);
  });

  it("keeps three tabs in the strip and walks back across them", async () => {
    stubBackend();
    const { layout, selected } = fakeLayout();
    bindShell({ layout, panelOfFamily: PANEL_OF_FAMILY });

    // Tab A: one issue. Tab B: the agents entry. Tab C: skills.
    const issues = seatElement();
    act(() => attachSeat(issues, { view: "issue", issueId: "MUL-1" }));
    const host = islandHost() as HTMLElement;
    await settle(() => {
      expect(shadowText(host)).toContain(ISSUE.title);
    });

    const agents = seatElement();
    await moveSeat(issues, agents, { view: "agents" });
    await settle(() => {
      expect(shadowText(host)).toContain("Agents");
    });

    const skills = seatElement();
    await moveSeat(agents, skills, { view: "skills" });
    await settle(() => {
      expect(shadowText(host)).toContain("Skills");
    });

    expect(stripTabs(host).map((tab) => tab.textContent?.replace("×", "").trim())).toEqual([
      "MUL-1",
      "Agents",
      "Skills",
    ]);

    // Back crosses from the skills tab into the agents tab...
    const back = host.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Back']");
    expect(back?.disabled).toBe(false);
    await act(async () => {
      back?.click();
    });
    await settle(() => {
      expect(activeTabName(host)).toBe("Agents");
    });

    // ...and again into the issue tab, two tabs away from where it started.
    await act(async () => {
      host.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Back']")?.click();
    });
    await settle(() => {
      expect(activeTabName(host)).toBe("MUL-1");
      expect(shadowText(host)).toContain(ISSUE.title);
    });

    // The rail followed every move: the shell never marks a stale row.
    expect(selected).toEqual(["multica", "multica-agents", "multica-skills", "multica-agents", "multica"]);

    // Forward retraces it.
    await act(async () => {
      host.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Forward']")?.click();
    });
    await settle(() => {
      expect(activeTabName(host)).toBe("Agents");
    });
    expect(selected.at(-1)).toBe("multica-agents");
  });

  it("follows a tab click into another family, and a relaunch does not select a row", async () => {
    stubBackend();
    const { layout, selected } = fakeLayout();
    bindShell({ layout, panelOfFamily: PANEL_OF_FAMILY });

    const issues = seatElement();
    act(() => attachSeat(issues, { view: "issue", issueId: "MUL-1" }));
    const host = islandHost() as HTMLElement;
    await settle(() => {
      expect(shadowText(host)).toContain(ISSUE.title);
    });

    const agents = seatElement();
    await moveSeat(issues, agents, { view: "agents" });
    await settle(() => {
      expect(stripTabs(host)).toHaveLength(2);
    });
    expect(selected).toEqual(["multica", "multica-agents"]);

    // Clicking the issue tab moves the rail back without touching the seat.
    const issueTab = stripTabs(host).find((tab) => (tab.textContent ?? "").includes("MUL-1"));
    await act(async () => {
      issueTab?.click();
    });
    await settle(() => {
      expect(activeTabName(host)).toBe("MUL-1");
      expect(shadowText(host)).toContain(ISSUE.title);
    });
    expect(selected.at(-1)).toBe("multica");
  });
});
