// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  BOARD_ROUTE,
  createIslandNavigation,
  FAMILY_ROOTS,
  HIDDEN_AREAS,
  islandParent,
  islandPath,
  islandPathname,
  islandRouteKey,
  parseIslandRoute,
} from "../src/client/navigation";
import { createIslandStorage } from "../src/client/storage";
import { createTabsStore } from "../src/client/tabs";

describe("parseIslandRoute", () => {
  it("reads the board", () => {
    expect(parseIslandRoute("/demo/issues")).toEqual(BOARD_ROUTE);
  });

  it("reads one issue, including an identifier segment", () => {
    expect(parseIslandRoute("/demo/issues/MUL-12")).toEqual({
      view: "issue",
      issueId: "MUL-12",
    });
    expect(parseIslandRoute("/demo/issues/MUL-12#comment-abc")).toEqual({
      view: "issue",
      issueId: "MUL-12",
    });
    expect(parseIslandRoute("/demo/issues/MUL%2D12")).toEqual({
      view: "issue",
      issueId: "MUL-12",
    });
  });

  it("reads the other six entries of the menu", () => {
    expect(parseIslandRoute("/demo/agents")).toEqual({ view: "agents" });
    expect(parseIslandRoute("/demo/skills")).toEqual({ view: "skills" });
    expect(parseIslandRoute("/demo/inbox")).toEqual({ view: "inbox" });
    expect(parseIslandRoute("/demo/decisions?state=answered&decision=question%3A1")).toEqual({
      view: "decisions",
      query: "state=answered&decision=question%3A1",
    });
    expect(parseIslandRoute("/demo/chat")).toEqual({ view: "chat" });
    expect(parseIslandRoute("/demo/settings")).toEqual({ view: "settings" });
    // Settings addresses its page through the query, never a segment.
    expect(parseIslandRoute("/demo/settings?tab=moct-memory")).toEqual({
      view: "settings",
      query: "tab=moct-memory",
    });
    expect(parseIslandRoute("/demo/settings/billing")).toBeNull();
  });

  it("reads the detail depth of the families that have one", () => {
    expect(parseIslandRoute("/demo/agents/agent-7")).toEqual({
      view: "agent",
      agentId: "agent-7",
    });
    expect(parseIslandRoute("/demo/skills/skill-3")).toEqual({
      view: "skill",
      skillId: "skill-3",
    });
  });

  it("keeps the query the pages address their state with", () => {
    expect(parseIslandRoute("/demo/chat?session=abc")).toEqual({
      view: "chat",
      query: "session=abc",
    });
    expect(parseIslandRoute("/demo/inbox?view=archived&issue=MUL-1")).toEqual({
      view: "inbox",
      query: "view=archived&issue=MUL-1",
    });
  });

  it("refuses every other destination", () => {
    expect(parseIslandRoute("/demo/billing")).toBeNull();
    expect(parseIslandRoute("/demo/issues/MUL-1/extra")).toBeNull();
    // The agent creation flow is not a page this panel renders.
    expect(parseIslandRoute("/demo/agents/new")).toBeNull();
    expect(parseIslandRoute("/demo/inbox/MUL-1")).toBeNull();
  });
});

describe("islandPath", () => {
  it("round-trips every route through the parser", () => {
    const routes = [
      BOARD_ROUTE,
      { view: "issue" as const, issueId: "MUL-9" },
      { view: "agents" as const },
      { view: "agent" as const, agentId: "agent-7" },
      { view: "skills" as const },
      { view: "skill" as const, skillId: "skill-3" },
      { view: "inbox" as const },
      { view: "decisions" as const },
      { view: "chat" as const, query: "session=abc" },
      { view: "inbox" as const, query: "view=archived" },
      { view: "settings" as const },
      { view: "settings" as const, query: "tab=moct-connection" },
    ];
    for (const route of routes) {
      expect(parseIslandRoute(islandPath("demo", route))).toEqual(route);
      // The pathname is the same path without the query, which is what the
      // fork's pages compare against.
      expect(islandPathname("demo", route)).toBe(islandPath("demo", route).split("?")[0]);
    }
  });

  it("names each family after the web app's own route", () => {
    expect(islandPathname("demo", FAMILY_ROOTS.issues)).toBe("/demo/issues");
    expect(islandPathname("demo", FAMILY_ROOTS.agents)).toBe("/demo/agents");
    expect(islandPathname("demo", FAMILY_ROOTS.skills)).toBe("/demo/skills");
    expect(islandPathname("demo", FAMILY_ROOTS.inbox)).toBe("/demo/inbox");
    expect(islandPathname("demo", FAMILY_ROOTS.decisions)).toBe("/demo/decisions");
    expect(islandPathname("demo", FAMILY_ROOTS.chat)).toBe("/demo/chat");
    expect(islandPathname("demo", FAMILY_ROOTS.settings)).toBe("/demo/settings");
  });
});

describe("islandParent", () => {
  it("gives each detail view its family root and each root nothing", () => {
    expect(islandParent({ view: "issue", issueId: "MUL-1" })).toEqual(BOARD_ROUTE);
    expect(islandParent({ view: "agent", agentId: "a" })).toEqual(FAMILY_ROOTS.agents);
    expect(islandParent({ view: "skill", skillId: "s" })).toEqual(FAMILY_ROOTS.skills);
    for (const root of Object.values(FAMILY_ROOTS)) {
      expect(islandParent(root)).toBeNull();
    }
  });
});

describe("islandRouteKey", () => {
  it("separates the rendered places", () => {
    expect(
      new Set([
        islandRouteKey(BOARD_ROUTE),
        islandRouteKey({ view: "issue", issueId: "MUL-1" }),
        islandRouteKey(FAMILY_ROOTS.agents),
        islandRouteKey({ view: "agent", agentId: "a" }),
        islandRouteKey(FAMILY_ROOTS.skills),
        islandRouteKey({ view: "skill", skillId: "s" }),
        islandRouteKey(FAMILY_ROOTS.inbox),
        islandRouteKey(FAMILY_ROOTS.chat),
        islandRouteKey(FAMILY_ROOTS.settings),
      ]).size,
    ).toBe(9);
  });
});

describe("createIslandNavigation", () => {
  it("swaps the rendered page on push instead of leaving the panel", () => {
    const onChange = vi.fn();
    const navigation = createIslandNavigation({
      slug: "demo",
      route: BOARD_ROUTE,
      onChange,
    });
    navigation.push("/demo/issues/MUL-3");
    expect(onChange).toHaveBeenCalledWith({ view: "issue", issueId: "MUL-3" });
    navigation.push("/demo/chat?session=abc");
    expect(onChange).toHaveBeenCalledWith({ view: "chat", query: "session=abc" });
  });

  it("refuses the surfaces this panel hides (Q8)", () => {
    const onChange = vi.fn();
    const onRefused = vi.fn();
    const navigation = createIslandNavigation({
      slug: "demo",
      route: BOARD_ROUTE,
      onChange,
      onRefused,
    });
    for (const area of HIDDEN_AREAS) {
      navigation.push(`/demo/${area}`);
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledTimes(HIDDEN_AREAS.length);
  });

  it("reports where it is and what is behind it", () => {
    const board = createIslandNavigation({
      slug: "demo",
      route: BOARD_ROUTE,
      onChange: vi.fn(),
    });
    expect(board.pathname).toBe("/demo/issues");
    expect(board.canGoBack?.()).toBe(false);

    const issue = createIslandNavigation({
      slug: "demo",
      route: { view: "issue", issueId: "MUL-1" },
      onChange: vi.fn(),
    });
    expect(issue.pathname).toBe("/demo/issues/MUL-1");
    expect(issue.canGoBack?.()).toBe(true);
    expect(issue.getShareableUrl("/demo/issues/MUL-1")).toBe("");
  });

  it("hands the pages the query they address their state with", () => {
    const onChange = vi.fn();
    const chat = createIslandNavigation({
      slug: "demo",
      route: { view: "chat", query: "session=abc" },
      onChange,
    });
    // ChatPage compares its own path against the workspace's chat route, so the
    // pathname must not carry the query.
    expect(chat.pathname).toBe("/demo/chat");
    expect(chat.searchParams.get("session")).toBe("abc");
    chat.back();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("createIslandNavigation over the window's history (M-197)", () => {
  function tabs() {
    const values = new Map<string, string>();
    const backing = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    };
    return createTabsStore(createIslandStorage(backing as any), "demo");
  }

  it("restores Decisions selection through the window's Back and Forward history", () => {
    const store = createTabsStore(createIslandStorage(), "demo");
    store.getState().railEntry(FAMILY_ROOTS.decisions);
    const navigation = createIslandNavigation({ slug: "demo", tabs: store });

    navigation.push("/demo/decisions?state=answered&decision=question%3Acard-9");
    expect(store.getState().activeTab()?.url).toBe(
      "/demo/decisions?state=answered&decision=question%3Acard-9",
    );
    navigation.back();
    expect(store.getState().activeTab()?.url).toBe("/demo/decisions");
    navigation.forward?.();
    expect(store.getState().activeTab()?.url).toBe(
      "/demo/decisions?state=answered&decision=question%3Acard-9",
    );
  });

  it("reads the active tab's pathname and query after tab changes", () => {
    const store = tabs();
    const navigation = createIslandNavigation({ slug: "demo", tabs: store });

    store.getState().openTab("/demo/agents/agent-7");
    expect(navigation.pathname).toBe("/demo/agents/agent-7");
    expect(navigation.searchParams.get("view")).toBeNull();

    navigation.replace(`${navigation.pathname}?view=general`);
    expect(store.getState().activeUrl()).toBe("/demo/agents/agent-7?view=general");
    expect(navigation.pathname).toBe("/demo/agents/agent-7");
    expect(navigation.searchParams.get("view")).toBe("general");
  });

  it("focuses an existing resource tab when a page pushes that resource", () => {
    const store = tabs();
    const agentsTab = store.getState().openTab("/demo/agents");
    const agentTab = store.getState().openTab("/demo/agents/agent-7", {
      activate: false,
    });
    const navigation = createIslandNavigation({ slug: "demo", tabs: store });

    navigation.push("/demo/agents/agent-7?view=general");

    expect(store.getState().activeId).toBe(agentTab);
    expect(store.getState().activeUrl()).toBe(
      "/demo/agents/agent-7?view=general",
    );
    expect(store.getState().tabs).toHaveLength(2);
    expect(agentsTab).not.toBe(agentTab);
  });

  it("back crosses tabs and forward returns to the tab it left", () => {
    const store = tabs();
    const onChange = vi.fn();
    const navigation = createIslandNavigation({ slug: "demo", tabs: store, onChange });
    store.getState().openTab("/demo/issues");
    store.getState().push("/demo/issues/MUL-1");
    const agents = store.getState().openTab("/demo/agents");

    navigation.back();
    expect(store.getState().activeTab()?.url).toBe("/demo/issues/MUL-1");
    expect(onChange).toHaveBeenLastCalledWith({ view: "issue", issueId: "MUL-1" });

    navigation.forward?.();
    expect(store.getState().activeId).toBe(agents);
    expect(onChange).toHaveBeenLastCalledWith({ view: "agents" });
  });

  it("reports Back as available while the window has somewhere behind it", () => {
    const store = tabs();
    const navigation = createIslandNavigation({ slug: "demo", tabs: store, onChange: vi.fn() });
    store.getState().openTab("/demo/issues");
    expect(navigation.canGoBack?.()).toBe(false);
    store.getState().push("/demo/issues/MUL-2");
    expect(navigation.canGoBack?.()).toBe(true);
  });
});
