// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createIslandStorage } from "../src/client/storage";
import { HISTORY_CAP, createTabsStore, type TabsState } from "../src/client/tabs";
import type { StoreApi } from "zustand/vanilla";

function memoryBacking() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function store(): StoreApi<TabsState> {
  return createTabsStore(createIslandStorage(memoryBacking() as any), "demo");
}

/** The tab the window is standing on, and where it stands. */
function current(s: StoreApi<TabsState>): { tabId: string | null; url: string | null } {
  const state = s.getState();
  return {
    tabId: state.activeId,
    url: state.tabs.find((t) => t.id === state.activeId)?.url ?? null,
  };
}

describe("window history (M-197)", () => {
  it("back from tab B's first entry lands on tab A's last entry", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    s.getState().push("/demo/issues/MUL-1");
    const b = s.getState().openTab("/demo/agents");
    expect(current(s)).toEqual({ tabId: b, url: "/demo/agents" });

    expect(s.getState().back()).toBe(true);
    expect(current(s)).toEqual({ tabId: a, url: "/demo/issues/MUL-1" });
    // The tab was re-focused, so it is the most recent one again.
    expect(s.getState().mru[0]).toBe(a);
  });

  it("forward walks the same path back into the other tab", () => {
    const s = store();
    s.getState().openTab("/demo/issues");
    const b = s.getState().openTab("/demo/agents");
    s.getState().back();
    expect(s.getState().canGoForward()).toBe(true);
    expect(s.getState().forward()).toBe(true);
    expect(current(s).tabId).toBe(b);
    expect(s.getState().canGoForward()).toBe(false);
  });

  it("records a tab switch as a visit, once", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    const b = s.getState().openTab("/demo/agents");
    // `openTab` already visited b; focusing it again is not a second visit.
    s.getState().focusTab(b);
    expect(s.getState().entries.map((e) => e.url)).toEqual([
      "/demo/issues",
      "/demo/agents",
    ]);
    s.getState().focusTab(a);
    expect(s.getState().entries.map((e) => e.url)).toEqual([
      "/demo/issues",
      "/demo/agents",
      "/demo/issues",
    ]);
  });

  it("skips the entries of a closed tab", () => {
    const s = store();
    s.getState().openTab("/demo/issues");
    const b = s.getState().openTab("/demo/agents");
    s.getState().openTab("/demo/skills");
    s.getState().closeTab(b);
    // Standing on the skills tab; back crosses the closed agents tab's entries.
    expect(s.getState().back()).toBe(true);
    expect(current(s).url).toBe("/demo/issues");
    // No live entry remains before it, and the board has no parent.
    expect(s.getState().back()).toBe(false);
  });

  it("caps the history and keeps the index on the same visit", () => {
    const s = store();
    s.getState().openTab("/demo/issues");
    for (const step of Array.from({ length: HISTORY_CAP + 20 }, (_, i) => i)) {
      s.getState().push(`/demo/issues/MUL-${step}`);
    }
    expect(s.getState().entries).toHaveLength(HISTORY_CAP);
    expect(current(s).url).toBe(`/demo/issues/MUL-${HISTORY_CAP + 19}`);
    expect(s.getState().canGoForward()).toBe(false);
    // The oldest 21 visits fell off the front; one Back moves one visit.
    expect(s.getState().back()).toBe(true);
    expect(current(s).url).toBe(`/demo/issues/MUL-${HISTORY_CAP + 18}`);
  });

  it("a replace rewrites the visit the window is on instead of adding one", () => {
    const s = store();
    s.getState().openTab("/demo/issues/11111111-1111-4111-8111-111111111111");
    s.getState().replace("/demo/issues/MUL-1");
    expect(s.getState().entries).toHaveLength(1);
    expect(s.getState().entries[0]).toEqual({
      tabId: s.getState().activeId,
      url: "/demo/issues/MUL-1",
    });
    // Back must not bounce between two spellings of the same issue.
    expect(s.getState().canGoBack()).toBe(true); // the detail view's family root
  });

  it("pushes from the active tab only, and follows the tab's URL", () => {
    const s = store();
    const a = s.getState().openTab("/demo/issues");
    const b = s.getState().openTab("/demo/agents", { activate: false });
    s.getState().push("/demo/issues/MUL-2");
    expect(s.getState().tabs.find((t) => t.id === a)?.url).toBe("/demo/issues/MUL-2");
    expect(s.getState().tabs.find((t) => t.id === b)?.url).toBe("/demo/agents");
    expect(s.getState().entries.map((e) => e.url)).toEqual([
      "/demo/issues",
      "/demo/issues/MUL-2",
    ]);
  });

  it("a background tab is not a visit", () => {
    const s = store();
    s.getState().openTab("/demo/issues");
    s.getState().openTab("/demo/agents", { activate: false });
    expect(s.getState().entries).toHaveLength(1);
    expect(s.getState().activeId).not.toBe(s.getState().tabs[1]?.id);
  });

  it("restores tabs and their history from storage", () => {
    const backing = memoryBacking();
    const storage = createIslandStorage(backing as any);
    const first = createTabsStore(storage, "demo");
    first.getState().openTab("/demo/issues");
    first.getState().openTab("/demo/agents");

    const second = createTabsStore(storage, "demo");
    expect(second.getState().tabs).toHaveLength(2);
    expect(second.getState().entries).toHaveLength(2);
    expect(second.getState().back()).toBe(true);
    expect(second.getState().activeTab()?.url).toBe("/demo/issues");
  });
});
